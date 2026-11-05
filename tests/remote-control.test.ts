import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createRemoteControl, stripOwnCookie, COOKIE } = require("../electron/remote-control.cjs");
const { HEADER } = require("../electron/desktop-api.cjs");
const secret = "s".repeat(64);
const noTailscale = { detectTailscale: async () => null };

type Seen = { url?: string; headers: http.IncomingHttpHeaders; method?: string };

async function fixture(opts: Record<string, unknown> = {}) {
	const seen: Seen[] = [];
	const upstream = http.createServer((req, res) => {
		seen.push({ url: req.url, headers: req.headers, method: req.method });
		if (req.url === "/redirect") { res.writeHead(307, { Location: `${origin}/chat/new` }); res.end(); return; }
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	let saved: unknown = null;
	const store = { load: () => ({ enabled: false, port: 0, host: "127.0.0.1", devices: [] }), save: (s: unknown) => { saved = s; } };
	const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-remote-"));
	const rc = createRemoteControl({ store, target: () => ({ origin, secret }), uploadDir, ...noTailscale, ...opts });
	const snap = await rc.control({ op: "enable" });
	const base: string = snap.url;
	const close = async () => { await rc.stop(); await new Promise((r) => upstream.close(r)); fs.rmSync(uploadDir, { recursive: true, force: true }); };
	return { rc, base, origin, seen, close, uploadDir, saved: () => saved };
}

function request(url: string, opts: http.RequestOptions = {}, body?: string) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const req = http.request(url, opts, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function pair(rc: any) {
	const { url } = await rc.control({ op: "pair" });
	const res = await request(url, { headers: { "User-Agent": "Mozilla/5.0 (iPhone)" } });
	assert.equal(res.status, 302);
	const cookie = String(res.headers["set-cookie"]?.[0]).split(";")[0] ?? "";
	assert.match(cookie, new RegExp(`^${COOKIE}=[0-9a-f]{64}$`));
	assert.match(String(res.headers["set-cookie"]?.[0]), /HttpOnly; SameSite=Strict/);
	return { cookie, url };
}

test("unpaired requests are refused and never reach the server", async () => {
	const f = await fixture();
	try {
		const res = await request(`${f.base}/api/settings`);
		assert.equal(res.status, 401);
		const forged = await request(`${f.base}/api/settings`, { headers: { Cookie: `${COOKIE}=${"0".repeat(64)}`, [HEADER]: secret } });
		assert.equal(forged.status, 401);
		assert.equal(f.seen.length, 0);
	} finally { await f.close(); }
});

test("pairing is single use, stores only a hash, and authorizes forwarding with the desktop secret", async () => {
	const f = await fixture();
	try {
		const { cookie, url } = await pair(f.rc);
		assert.equal((await request(url)).status, 403, "code reuse rejected");
		const token = cookie.split("=")[1] ?? "";
		assert.ok(!JSON.stringify(f.saved()).includes(token), "raw token never persisted");
		assert.equal(f.rc.snapshot().devices[0].name, "iPhone");

		const res = await request(`${f.base}/api/settings?x=1`, { headers: { Cookie: `${cookie}; theme=dark`, [HEADER]: "attacker" } });
		assert.equal(res.status, 200);
		assert.equal(res.body, "ok");
		const hit = f.seen.at(-1)!;
		assert.equal(hit.url, "/api/settings?x=1");
		assert.equal(hit.headers[HEADER], secret);
		assert.equal(hit.headers.cookie, "theme=dark");
		assert.equal(hit.headers.host, new URL(f.origin).host);
	} finally { await f.close(); }
});

test("cross-origin writes are rejected; same-origin writes get origin rewritten", async () => {
	const f = await fixture();
	try {
		const { cookie } = await pair(f.rc);
		const evil = await request(`${f.base}/api/chats`, { method: "POST", headers: { Cookie: cookie, Origin: "http://evil.invalid" } }, "{}");
		assert.equal(evil.status, 403);
		const ok = await request(`${f.base}/api/chats`, { method: "POST", headers: { Cookie: cookie, Origin: f.base } }, "{}");
		assert.equal(ok.status, 200);
		assert.equal(f.seen.at(-1)!.headers.origin, f.origin);
		assert.equal(f.seen.filter((s) => s.method === "POST").length, 1);
	} finally { await f.close(); }
});

test("absolute loopback redirects become relative", async () => {
	const f = await fixture();
	try {
		const { cookie } = await pair(f.rc);
		const res = await request(`${f.base}/redirect`, { headers: { Cookie: cookie } });
		assert.equal(res.headers.location, "/chat/new");
	} finally { await f.close(); }
});

test("expired pairing codes fail", async () => {
	let t = 1_000_000;
	const store = { load: () => ({ enabled: true, port: 0, host: "127.0.0.1", devices: [] }), save() {} };
	const rc = createRemoteControl({ store, target: () => null, now: () => t, ...noTailscale });
	await rc.boot();
	try {
		const { url } = await rc.control({ op: "pair" });
		t += 5 * 60 * 1000 + 1;
		assert.equal((await request(url)).status, 403);
	} finally { await rc.stop(); }
});

test("revoke removes access and disable closes the listener", async () => {
	const f = await fixture();
	try {
		const { cookie } = await pair(f.rc);
		const id = f.rc.snapshot().devices[0].id;
		await f.rc.control({ op: "revoke", id });
		assert.equal((await request(`${f.base}/`, { headers: { Cookie: cookie } })).status, 401);
		const off = await f.rc.control({ op: "disable" });
		assert.equal(off.listening, false);
		await assert.rejects(request(`${f.base}/`));
	} finally { await f.close(); }
});

test("network picker lists external IPv4 adapters and restarts the listener on the chosen one", async () => {
	const { listNetworks } = require("../electron/remote-control.cjs");
	assert.deepEqual(listNetworks({
		"Loopback": [{ family: "IPv4", address: "127.0.0.1", internal: true }],
		"Wi-Fi": [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "192.168.1.20", internal: false }],
		"Tailscale": [{ family: "IPv4", address: "100.82.105.116", internal: false }],
	}), [{ name: "Wi-Fi", address: "192.168.1.20" }, { name: "Tailscale", address: "100.82.105.116" }]);

	let saved: any = null;
	const store = { load: () => ({ enabled: true, port: 0, devices: [] }), save: (s: unknown) => { saved = s; } };
	const nets = [{ name: "Loop A", address: "127.0.0.1" }, { name: "Loop B", address: "127.0.0.2" }];
	const rc = createRemoteControl({ store, target: () => null, networks: () => nets, lanHost: () => "127.0.0.1", ...noTailscale });
	await rc.boot();
	try {
		assert.match(rc.snapshot().url, /^http:\/\/127\.0\.0\.1:/);
		assert.equal(rc.snapshot().host, null);
		await assert.rejects(rc.control({ op: "setHost", host: "10.9.9.9" }), /isn’t available/);
		const snap = await rc.control({ op: "setHost", host: "127.0.0.2" });
		assert.equal(snap.host, "127.0.0.2");
		assert.match(snap.url, /^http:\/\/127\.0\.0\.2:/);
		assert.equal(saved.host, "127.0.0.2");
		assert.equal((await rc.control({ op: "setHost", host: null })).host, null);
		assert.equal("host" in saved, false);
	} finally { await rc.stop(); }
});

test("phone uploads: paired same-origin only, saved under uploadDir with a safe name, size-capped", async () => {
	const f = await fixture();
	try {
		assert.equal((await request(`${f.base}/_remote/status`)).status, 401, "status needs pairing");
		assert.equal((await request(`${f.base}/_remote/upload?name=a.txt`, { method: "POST", headers: { Origin: f.base } }, "x")).status, 401);
		const { cookie } = await pair(f.rc);
		const status = await request(`${f.base}/_remote/status`, { headers: { Cookie: cookie } });
		assert.deepEqual(JSON.parse(status.body), { remote: true, uploads: true, dictation: false });

		const evil = await request(`${f.base}/_remote/upload?name=a.txt`, { method: "POST", headers: { Cookie: cookie, Origin: "http://evil.invalid" } }, "x");
		assert.equal(evil.status, 403);

		const ok = await request(`${f.base}/_remote/upload?name=${encodeURIComponent("../../evil<1>.txt")}`, { method: "POST", headers: { Cookie: cookie, Origin: f.base } }, "hello phone");
		assert.equal(ok.status, 200);
		const saved: string = JSON.parse(ok.body).path;
		assert.equal(path.basename(saved), "evil_1_.txt");
		assert.ok(path.resolve(saved).startsWith(path.resolve(f.uploadDir) + path.sep), "stays inside uploadDir");
		assert.equal(fs.readFileSync(saved, "utf8"), "hello phone");

		const big = await request(`${f.base}/_remote/upload?name=big.bin`, { method: "POST", headers: { Cookie: cookie, Origin: f.base, "Content-Length": String(101 * 1024 * 1024) } });
		assert.equal(big.status, 413);
		assert.equal(f.seen.length, 0, "upload routes never reach the Next server");
	} finally { await f.close(); }
});

test("stripOwnCookie keeps other cookies only", () => {
	assert.equal(stripOwnCookie(`a=1; ${COOKIE}=x; b=2`), "a=1; b=2");
	assert.equal(stripOwnCookie(`${COOKIE}=x`), undefined);
	assert.equal(stripOwnCookie(undefined), undefined);
});

const { newShortCode, normalizeShortCode, CODE_ALPHABET } = require("../electron/remote-pwa.cjs");

function postForm(url: string, origin: string, code: string) {
	const body = new URLSearchParams({ code }).toString();
	return request(url, { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) } }, body);
}

test("short codes: unambiguous alphabet, forgiving input", () => {
	for (let i = 0; i < 50; i++) {
		const code: string = newShortCode();
		assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		assert.doesNotMatch(code, /[IO01]/);
		assert.equal(normalizeShortCode(code.toLowerCase().replace("-", " ")), code.replace("-", ""));
	}
	assert.equal(normalizeShortCode("ABCD-EFG0"), null, "0 is not in the alphabet");
	assert.equal(normalizeShortCode("ABC"), null);
	assert.ok(!CODE_ALPHABET.includes("I"));
});

test("in-app pairing: the short code pairs once, consumes the QR link too, and wrong codes are capped", async () => {
	const f = await fixture();
	try {
		const unpaired = await request(`${f.base}/`);
		assert.equal(unpaired.status, 401);
		assert.match(unpaired.body, /action="\/_remote\/pair-code"/);
		assert.match(unpaired.body, /rel="manifest"/);

		const { url, shortCode } = await f.rc.control({ op: "pair" });
		assert.equal((await postForm(`${f.base}/_remote/pair-code`, "http://evil.invalid", shortCode)).status, 403, "foreign origin");
		const wrong = await postForm(`${f.base}/_remote/pair-code`, f.base, "AAAA-AAAA");
		assert.equal(wrong.status, 403);
		assert.match(wrong.body, /didn’t match/);

		const ok = await postForm(`${f.base}/_remote/pair-code`, f.base, shortCode.toLowerCase());
		assert.equal(ok.status, 302);
		assert.match(String(ok.headers["set-cookie"]?.[0]), /^lh_remote=[0-9a-f]{64};/);
		assert.equal((await request(url)).status, 403, "QR link consumed by the code");
		assert.equal((await postForm(`${f.base}/_remote/pair-code`, f.base, shortCode)).status, 403, "code is single use");

		const second = await f.rc.control({ op: "pair" });
		for (let i = 0; i < 10; i++) await postForm(`${f.base}/_remote/pair-code`, f.base, "AAAA-AAAA");
		const locked = await postForm(`${f.base}/_remote/pair-code`, f.base, second.shortCode);
		assert.equal(locked.status, 403, "10 wrong attempts cancel the pairing");
		assert.match(locked.body, /No active code/);
	} finally { await f.close(); }
});

test("PWA assets are served without pairing; the worker may control the whole origin", async () => {
	const icons = { 192: Buffer.from("png192"), 512: Buffer.from("png512") };
	const f = await fixture({ icons });
	try {
		const manifest = await request(`${f.base}/_remote/manifest.webmanifest`);
		assert.equal(manifest.status, 200);
		const m = JSON.parse(manifest.body);
		assert.equal(m.display, "standalone");
		assert.equal(m.start_url, "/");
		assert.deepEqual(m.icons.map((i: { sizes: string }) => i.sizes), ["192x192", "512x512"]);
		const sw = await request(`${f.base}/_remote/sw.js`);
		assert.equal(sw.headers["service-worker-allowed"], "/");
		assert.match(sw.body, /Can’t reach your computer/);
		assert.doesNotMatch(sw.body, /caches\./, "install-only worker: no caching");
		assert.equal((await request(`${f.base}/_remote/icon-512.png`)).body, "png512");
		assert.equal(f.seen.length, 0, "never reaches the Next server");
	} finally { await f.close(); }
});

test("Tailscale: HTTPS origin is trusted for writes and used in QR links once serve is verified", async () => {
	const f = await fixture({
		detectTailscale: async () => ({ dnsName: "pc.tail.ts.net", certificates: true }),
		probeHttps: async () => true,
	});
	try {
		const snap = await f.rc.control({ op: "checkTailscale" });
		assert.equal(snap.tailscale.httpsReady, true);
		assert.equal(snap.tailscale.url, "https://pc.tail.ts.net");
		assert.match(snap.tailscale.serveCommand, /^tailscale serve --bg http:\/\/127\.0\.0\.1:\d+$/);
		const { url } = await f.rc.control({ op: "pair" });
		assert.match(url, /^https:\/\/pc\.tail\.ts\.net\/_remote\/pair\?code=/);

		const { shortCode } = await f.rc.control({ op: "pair" });
		const paired = await postForm(`${f.base}/_remote/pair-code`, "https://pc.tail.ts.net", shortCode);
		assert.equal(paired.status, 302, "pairing form accepted from the HTTPS origin");
		const cookie = String(paired.headers["set-cookie"]?.[0]).split(";")[0] ?? "";
		const post = await request(`${f.base}/api/chats`, { method: "POST", headers: { Cookie: cookie, Origin: "https://pc.tail.ts.net", Referer: "https://pc.tail.ts.net/chat/x" } }, "{}");
		assert.equal(post.status, 200);
		const hit = f.seen.at(-1)!;
		assert.equal(hit.headers.origin, f.origin);
		assert.equal(hit.headers.referer, `${f.origin}/chat/x`);
		const up = await request(`${f.base}/_remote/upload?name=a.txt`, { method: "POST", headers: { Cookie: cookie, Origin: "https://pc.tail.ts.net" } }, "x");
		assert.equal(up.status, 200);
	} finally { await f.close(); }
});

test("Tailscale without a working serve keeps LAN links", async () => {
	const f = await fixture({ detectTailscale: async () => ({ dnsName: "pc.tail.ts.net", certificates: true }), probeHttps: async () => false });
	try {
		const snap = await f.rc.control({ op: "checkTailscale" });
		assert.equal(snap.tailscale.httpsReady, false);
		assert.match((await f.rc.control({ op: "pair" })).url, /^http:\/\/127\.0\.0\.1:/);
	} finally { await f.close(); }
});

// ── Phone dictation relay (electron/remote-dictation.cjs over remote-ws.cjs) ──

const { encodeFrame, decodeFrames } = require("../electron/remote-ws.cjs");
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { createHash, randomBytes } from "node:crypto";

/** Masked client frame (browsers always mask). */
function clientFrame(opcode: number, payload: Buffer) {
	const mask = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i & 3]!;
	const len = payload.length;
	const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
	return Buffer.concat([head, mask, masked]);
}

/** Server frames are unmasked: parse text frames out of a socket stream. */
function serverMessages(socket: import("node:net").Socket, head: Buffer = Buffer.alloc(0)) {
	const queue: string[] = [];
	const waiters: Array<(s: string) => void> = [];
	let buf = Buffer.alloc(0);
	const onData = (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 2) {
			const len = buf[1]! & 0x7f;
			const off = len === 126 ? 4 : 2;
			const n = len === 126 ? buf.readUInt16BE(2) : len;
			if (buf.length < off + n) break;
			const text = buf.subarray(off, off + n).toString("utf8");
			const opcode = buf[0]! & 0x0f;
			buf = buf.subarray(off + n);
			if (opcode !== 0x1) continue;
			const w = waiters.shift();
			if (w) w(text); else queue.push(text);
		}
	};
	socket.on("data", onData);
	if (head.length) onData(head);
	return () => new Promise<string>((resolve) => { const q = queue.shift(); if (q !== undefined) resolve(q); else waiters.push(resolve); });
}

function wsConnect(base: string, headers: Record<string, string>) {
	return new Promise<{ status: number; socket?: import("node:net").Socket; head?: Buffer }>((resolve, reject) => {
		const key = randomBytes(16).toString("base64");
		const req = http.request(`${base}/_remote/dictation`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, ...headers } });
		req.on("upgrade", (res, socket, head) => {
			assert.equal(res.headers["sec-websocket-accept"], createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64"));
			resolve({ status: res.statusCode ?? 0, socket, head });
		});
		req.on("response", (res) => resolve({ status: res.statusCode ?? 0 }));
		req.on("error", (e) => (String(e).includes("socket hang up") ? resolve({ status: 0 }) : reject(e)));
		req.end();
	});
}

/** A fake local engine: connect() hands over a MessagePortMain-shaped port; `worker` is its other end. */
function fakeDictation(ok = true) {
	const received: any[] = [];
	let worker: import("node:worker_threads").MessagePort | null = null;
	return {
		received,
		toPhone: (msg: unknown) => worker!.postMessage(msg),
		snapshot: () => ({ available: true, engine: { state: "ready" }, models: { m: { state: "ready" } }, vad: null }),
		connect(webContents: { postMessage: (c: string, m: unknown, ports: unknown[]) => void }) {
			if (!ok) return false;
			const { port1, port2 } = new NodeMessageChannel();
			worker = port1;
			port1.on("message", (data) => received.push(data));
			port1.unref(); port2.unref();
			const mainPort = { on: (_e: string, cb: (ev: { data: unknown }) => void) => port2.on("message", (data) => cb({ data })), postMessage: (m: unknown) => port2.postMessage(m), start: () => {}, close: () => port2.close() };
			webContents.postMessage("lh:dictation:port", null, [mainPort]);
			return true;
		},
	};
}

const until = async (check: () => boolean, ms = 2000) => {
	const end = Date.now() + ms;
	while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); }
};

test("ws frames: encode/decode round-trip, masked only", () => {
	const payload = Buffer.from("x".repeat(300));
	const { frames, rest } = decodeFrames(Buffer.concat([clientFrame(0x1, payload), clientFrame(0x2, Buffer.from([1, 2]))]));
	assert.equal(rest.length, 0);
	assert.equal(frames[0].payload.toString(), payload.toString());
	assert.deepEqual([...frames[1].payload], [1, 2]);
	assert.throws(() => decodeFrames(encodeFrame(0x1, Buffer.from("hi"))), /unmasked/);
	assert.equal(decodeFrames(clientFrame(0x1, payload).subarray(0, 10)).frames.length, 0, "partial frames wait for more bytes");
});

test("phone dictation: status, paired same-origin socket relays control, audio and worker replies", async () => {
	const engine = fakeDictation();
	const f = await fixture({ dictation: () => engine });
	try {
		const { cookie } = await pair(f.rc);
		const st = JSON.parse((await request(`${f.base}/_remote/status`, { headers: { Cookie: cookie } })).body);
		assert.equal(st.dictation, true);
		const snap = JSON.parse((await request(`${f.base}/_remote/dictation/status`, { headers: { Cookie: cookie } })).body);
		assert.equal(snap.models.m.state, "ready");

		assert.equal((await wsConnect(f.base, { Origin: f.base })).status, 403, "unpaired socket refused");
		assert.equal((await wsConnect(f.base, { Cookie: cookie, Origin: "http://evil.example" })).status, 403, "foreign origin refused");

		const { socket, head } = await wsConnect(f.base, { Cookie: cookie, Origin: f.base });
		const next = serverMessages(socket!, head);
		assert.deepEqual(JSON.parse(await next()), { type: "ready" });
		socket!.write(clientFrame(0x1, Buffer.from(JSON.stringify({ type: "start", runId: 7, language: "en", vad: true }))));
		socket!.write(clientFrame(0x1, Buffer.from(JSON.stringify({ type: "download", runId: 7 }))));
		const pcm = Buffer.alloc(4 + 8);
		pcm.writeUInt32LE(7, 0);
		pcm.writeInt16LE(1234, 4);
		socket!.write(clientFrame(0x2, pcm));
		await until(() => engine.received.length >= 2);
		assert.deepEqual(engine.received[0], { type: "start", runId: 7, language: "en", vad: true });
		assert.equal(engine.received[1].type, "audio", "unknown control types are dropped");
		assert.equal(engine.received[1].runId, 7);
		assert.ok(engine.received[1].pcm instanceof ArrayBuffer, "the worker gets an ArrayBuffer");
		assert.equal(new Int16Array(engine.received[1].pcm)[0], 1234);

		engine.toPhone({ type: "text", runId: 7, committed: "hello", tentative: "" });
		assert.deepEqual(JSON.parse(await next()), { type: "text", runId: 7, committed: "hello", tentative: "" });

		socket!.destroy(); // phone vanished mid-run
		await until(() => engine.received.some((m) => m.type === "cancel"));
		assert.deepEqual(engine.received.at(-1), { type: "cancel", runId: 7 });
	} finally { await f.close(); }
});

test("phone dictation: a starting engine answers busy; no engine means no dictation", async () => {
	const f = await fixture({ dictation: () => fakeDictation(false) });
	try {
		const { cookie } = await pair(f.rc);
		const { socket, head } = await wsConnect(f.base, { Cookie: cookie, Origin: f.base });
		assert.deepEqual(JSON.parse(await serverMessages(socket!, head)()), { type: "busy" });
		socket!.destroy();
	} finally { await f.close(); }
	const g = await fixture();
	try {
		const { cookie } = await pair(g.rc);
		assert.equal(JSON.parse((await request(`${g.base}/_remote/status`, { headers: { Cookie: cookie } })).body).dictation, false);
		assert.equal((await wsConnect(g.base, { Cookie: cookie, Origin: g.base })).status, 503);
	} finally { await g.close(); }
});
