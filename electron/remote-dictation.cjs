"use strict";
/*
 * Phone dictation relay (fork feature, docs/remote-control.md).
 *
 * The desktop window talks to the local dictation worker over a direct
 * MessagePort (electron/dictation.cjs connect()). A phone can't hold an
 * Electron port, so the LAN proxy accepts a WebSocket at /_remote/dictation
 * and bridges it onto a fresh worker port:
 *
 *   phone → server  text   {"type":"start"|"stop"|"cancel", runId, ...}
 *                   binary [u32 LE runId][linear16 PCM]   (one 128ms frame)
 *   server → phone  text   {"type":"ready"} | {"type":"busy"} first, then the
 *                          worker's own messages verbatim (started, text,
 *                          final, error).
 */
const CONTROL_TYPES = new Set(["start", "stop", "cancel"]);

const UNAVAILABLE = {
	available: false,
	engine: { state: "none", model: null, backend: null, device: null, error: null, gpuFallback: false },
	models: {},
	vad: null,
};

/** The worker snapshot the phone gates on (models/ready state), or "unavailable". */
function dictationStatus(dictation) {
	try {
		return dictation ? dictation.snapshot() : UNAVAILABLE;
	} catch {
		return UNAVAILABLE;
	}
}

/** A fresh worker port via the desktop's own connect(), or null while the worker starts. */
function openWorkerPort(dictation) {
	let port = null;
	const ok = dictation.connect({ postMessage: (_channel, _message, ports) => { port = ports?.[0] ?? null; } });
	return ok ? port : null;
}

/**
 * Bridge one accepted WebSocket (electron/remote-ws.cjs) to the worker.
 * `openPort()` returns a MessagePortMain-like {on, postMessage, start, close} or null.
 */
function relayDictation(ws, openPort) {
	const port = openPort();
	if (!port) {
		ws.send(JSON.stringify({ type: "busy" }));
		ws.close();
		return;
	}
	let liveRun = null; // runId the worker hasn't ended yet
	port.on("message", ({ data }) => {
		if (data && (data.type === "final" || data.type === "error") && data.runId === liveRun) liveRun = null;
		ws.send(JSON.stringify(data));
	});
	port.start();
	ws.on("message", (data, isBinary) => {
		if (isBinary) {
			if (data.length < 6 || (data.length - 4) % 2 !== 0) return;
			const runId = data.readUInt32LE(0);
			// The worker reads an ArrayBuffer (new Int16Array(pcm)), never a Buffer view.
			const pcm = data.buffer.slice(data.byteOffset + 4, data.byteOffset + data.length);
			port.postMessage({ type: "audio", runId, pcm });
			return;
		}
		let msg;
		try {
			msg = JSON.parse(data.toString("utf8"));
		} catch {
			return;
		}
		if (!msg || !CONTROL_TYPES.has(msg.type) || !Number.isInteger(msg.runId)) return;
		if (msg.type === "start") liveRun = msg.runId;
		port.postMessage(msg);
	});
	ws.on("close", () => {
		// A phone that vanished mid-run (screen lock, network) must not hold
		// the worker's stream lease: cancel what it left running.
		if (liveRun !== null) port.postMessage({ type: "cancel", runId: liveRun });
		setTimeout(() => port.close(), 1000);
	});
	ws.send(JSON.stringify({ type: "ready" }));
}

module.exports = { relayDictation, openWorkerPort, dictationStatus, UNAVAILABLE };
