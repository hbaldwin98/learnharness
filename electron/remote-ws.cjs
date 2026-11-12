"use strict";
/*
 * Minimal server-side WebSocket (RFC 6455) for the phone remote (fork
 * feature, docs/remote-control.md). The Electron shell ships no `ws`
 * dependency, and the dictation relay needs only: text + binary messages,
 * ping/pong, close. Client frames must be masked; server frames are not.
 */
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Encode one unfragmented, unmasked frame. */
function encodeFrame(opcode, payload) {
	const len = payload.length;
	const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
	head[0] = 0x80 | opcode;
	if (len < 126) head[1] = len;
	else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
	else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
	return Buffer.concat([head, payload]);
}

/**
 * Parses frames from a growing buffer. Returns {frames, rest} or throws on a
 * protocol violation. Each frame: {fin, opcode, payload}.
 */
function decodeFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (buffer.length - offset >= 2) {
		const b0 = buffer[offset];
		const b1 = buffer[offset + 1];
		const masked = (b1 & 0x80) !== 0;
		if (!masked) throw new Error("unmasked client frame");
		let len = b1 & 0x7f;
		let pos = offset + 2;
		if (len === 126) {
			if (buffer.length - pos < 2) break;
			len = buffer.readUInt16BE(pos);
			pos += 2;
		} else if (len === 127) {
			if (buffer.length - pos < 8) break;
			const big = buffer.readBigUInt64BE(pos);
			if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error("frame too large");
			len = Number(big);
			pos += 8;
		}
		if (len > MAX_MESSAGE_BYTES) throw new Error("frame too large");
		if (buffer.length - pos < 4 + len) break;
		const mask = buffer.subarray(pos, pos + 4);
		pos += 4;
		const payload = Buffer.from(buffer.subarray(pos, pos + len));
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
		frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
		offset = pos + len;
	}
	return { frames, rest: buffer.subarray(offset) };
}

/**
 * Completes the upgrade handshake on `socket` and returns an EventEmitter:
 *   "message" (data: Buffer, isBinary: boolean), "close" ()
 *   send(text | Buffer), close()
 * Returns null (and ends the socket) when the request isn't a valid upgrade.
 */
function acceptWebSocket(req, socket, head) {
	const key = req.headers["sec-websocket-key"];
	if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string") {
		socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		return null;
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	socket.setNoDelay(true);

	const ws = new EventEmitter();
	let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
	let fragments = null; // {opcode, parts, bytes}
	let closed = false;

	const finish = () => {
		if (closed) return;
		closed = true;
		ws.emit("close");
	};
	ws.send = (data) => {
		if (closed || socket.destroyed) return;
		const binary = Buffer.isBuffer(data);
		socket.write(encodeFrame(binary ? 0x2 : 0x1, binary ? data : Buffer.from(String(data), "utf8")));
	};
	ws.close = () => {
		if (!closed && !socket.destroyed) socket.end(encodeFrame(0x8, Buffer.alloc(0)));
		finish();
	};

	const onData = (chunk) => {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
		let parsed;
		try {
			parsed = decodeFrames(buffer);
		} catch {
			socket.destroy();
			return;
		}
		buffer = parsed.rest;
		for (const { fin, opcode, payload } of parsed.frames) {
			if (opcode === 0x8) { ws.close(); return; }
			if (opcode === 0x9) { if (!socket.destroyed) socket.write(encodeFrame(0xa, payload)); continue; }
			if (opcode === 0xa) continue;
			if (opcode === 0x1 || opcode === 0x2) fragments = { opcode, parts: [payload], bytes: payload.length };
			else if (opcode === 0x0 && fragments) { fragments.parts.push(payload); fragments.bytes += payload.length; }
			else { socket.destroy(); return; }
			if (fragments.bytes > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
			if (!fin) continue;
			const message = Buffer.concat(fragments.parts);
			const isBinary = fragments.opcode === 0x2;
			fragments = null;
			ws.emit("message", message, isBinary);
		}
	};
	socket.on("data", onData);
	socket.on("close", finish);
	socket.on("end", () => { finish(); socket.destroy(); });
	socket.on("error", () => socket.destroy());
	if (buffer.length) { const first = buffer; buffer = Buffer.alloc(0); onData(first); }
	return ws;
}

module.exports = { acceptWebSocket, encodeFrame, decodeFrames, MAX_MESSAGE_BYTES };
