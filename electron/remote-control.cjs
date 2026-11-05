"use strict";
/*
 * Phone remote control (fork feature, docs/remote-control.md).
 *
 * A LAN-facing HTTP proxy owned by the Electron main process. The Next
 * server keeps its 127.0.0.1 bind; this listener authenticates a paired
 * device by cookie, then forwards to the loopback server and adds the
 * per-launch desktop capability header. Upstream server code is untouched.
 */
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { HEADER } = require("./desktop-api.cjs");

const COOKIE = "lh_remote";
const PAIR_PATH = "/_remote/pair";
const PAIR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PORT = 47800;
const TOKEN_MAX_AGE_S = 365 * 24 * 60 * 60;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function safeEqualHex(a, b) {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** First non-internal IPv4 address, or null. */
function defaultLanHost(interfaces = os.networkInterfaces()) {
	for (const list of Object.values(interfaces)) {
		for (const addr of list ?? []) {
			if ((addr.family === "IPv4" || addr.family === 4) && !addr.internal) return addr.address;
		}
	}
	return null;
}

function parseCookies(header) {
	const out = {};
	for (const part of String(header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

/** The cookie header minus our own cookie (never forwarded to the server). */
function stripOwnCookie(header) {
	if (!header) return undefined;
	const kept = String(header).split(";").map((p) => p.trim()).filter((p) => p && !p.startsWith(`${COOKIE}=`));
	return kept.length ? kept.join("; ") : undefined;
}

function deviceName(userAgent) {
	const ua = String(userAgent ?? "");
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android device";
	return "Browser";
}

/** JSON file store: {enabled, port?, host?, devices: [{id, name, hash, createdAt, lastSeen}]}. */
function fileStore(file) {
	return {
		load() {
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8"));
				return { enabled: !!raw.enabled, port: raw.port, host: raw.host, devices: Array.isArray(raw.devices) ? raw.devices : [] };
			} catch {
				return { enabled: false, devices: [] };
			}
		},
		save(state) {
			fs.writeFileSync(file, JSON.stringify(state, null, "\t"), { mode: 0o600 });
		},
	};
}

/**
 * @param {object} o
 * @param {{load(): any, save(s: any): void}} o.store
 * @param {() => {origin: string, secret: string | null} | null} o.target loopback server
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {() => string | null} [o.lanHost]
 * @param {(snapshot: any) => void} [o.onChange]
 */
function createRemoteControl({ store, target, log = () => {}, now = Date.now, lanHost = defaultLanHost, onChange = () => {} }) {
	let state = store.load();
	let server = null;
	let listening = null; // {host, port}
	let lastError = null;
	let pairing = null; // {hash, expiresAt}
	const sockets = new Set();
	const socketDevice = new WeakMap();

	const stripRuntime = (s) => ({ ...s, devices: s.devices.map(({ _touched, ...d }) => d) });
	const persist = () => { store.save(stripRuntime(state)); onChange(snapshot()); };

	function snapshot() {
		return {
			enabled: state.enabled,
			listening: !!listening,
			url: listening ? `http://${listening.host}:${listening.port}` : null,
			error: lastError,
			devices: state.devices.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })),
		};
	}

	function deviceFor(req) {
		const token = parseCookies(req.headers.cookie)[COOKIE];
		if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
		const hash = sha256(token);
		return state.devices.find((d) => safeEqualHex(d.hash, hash)) ?? null;
	}

	function send(res, status, body, headers = {}) {
		res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
		res.end(body);
	}

	const page = (title, text) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;background:#141414;color:#e5e5e5;padding:24px"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`;

	function handlePair(req, res, url) {
		const code = url.searchParams.get("code") ?? "";
		const valid = pairing && pairing.expiresAt > now() && /^[0-9a-f]{32}$/.test(code) && safeEqualHex(pairing.hash, sha256(code));
		if (!valid) return send(res, 403, page("Pairing failed", "This pairing code is invalid or expired. Generate a new QR code in the desktop app under Settings → Remote."));
		pairing = null; // single use
		const token = randomBytes(32).toString("hex");
		const stamp = new Date(now()).toISOString();
		state.devices.push({ id: randomBytes(8).toString("hex"), name: deviceName(req.headers["user-agent"]), hash: sha256(token), createdAt: stamp, lastSeen: stamp });
		persist();
		log("[remote] device paired");
		send(res, 302, "", {
			Location: "/",
			"Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_MAX_AGE_S}`,
		});
	}

	/** Shared header rewrite for HTTP and upgrade requests. Returns null to reject. */
	function forwardHeaders(req, upstream) {
		const own = listening ? `http://${listening.host}:${listening.port}` : null;
		const headers = { ...req.headers };
		for (const name of Object.keys(headers)) if (name.toLowerCase() === HEADER) delete headers[name];
		const origin = headers.origin;
		if (origin && origin !== own) {
			const method = (req.method ?? "GET").toUpperCase();
			if (method !== "GET" && method !== "HEAD") return null;
		}
		if (origin) headers.origin = upstream.origin;
		headers.host = new URL(upstream.origin).host;
		if (headers.referer && own && headers.referer.startsWith(own)) headers.referer = upstream.origin + headers.referer.slice(own.length);
		const cookie = stripOwnCookie(headers.cookie);
		if (cookie) headers.cookie = cookie; else delete headers.cookie;
		if (upstream.secret) headers[HEADER] = upstream.secret;
		return headers;
	}

	function rewriteLocation(location, upstreamOrigin) {
		if (typeof location === "string" && location.startsWith(upstreamOrigin)) return location.slice(upstreamOrigin.length) || "/";
		return location;
	}

	function authorize(req) {
		const device = deviceFor(req);
		if (!device) return null;
		socketDevice.set(req.socket, device.id);
		const t = now();
		if (!device._touched || t - device._touched > 60_000) {
			device._touched = t;
			device.lastSeen = new Date(t).toISOString();
			try { store.save(stripRuntime(state)); } catch { /* best effort */ }
		}
		return device;
	}

	function onRequest(req, res) {
		const url = new URL(req.url ?? "/", "http://remote.invalid");
		if (url.pathname === PAIR_PATH) return handlePair(req, res, url);
		if (!authorize(req)) return send(res, 401, page("Not paired", "Open LearnHarness on your computer, go to Settings → Remote, and scan the QR code with this device."));
		const upstream = target();
		if (!upstream) return send(res, 503, page("Unavailable", "The desktop server is not running."));
		const headers = forwardHeaders(req, upstream);
		if (!headers) return send(res, 403, page("Forbidden", "Cross-origin request rejected."));
		const out = http.request(upstream.origin + (req.url ?? "/"), { method: req.method, headers }, (up) => {
			const resHeaders = { ...up.headers };
			if (resHeaders.location) resHeaders.location = rewriteLocation(resHeaders.location, upstream.origin);
			res.writeHead(up.statusCode ?? 502, resHeaders);
			up.pipe(res);
		});
		out.on("error", () => { if (!res.headersSent) send(res, 502, page("Unavailable", "The desktop server did not answer.")); else res.destroy(); });
		res.on("close", () => out.destroy());
		req.pipe(out);
	}

	function onUpgrade(req, socket, head) {
		const upstream = target();
		const headers = upstream && authorize(req) ? forwardHeaders(req, upstream) : null;
		if (!headers) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
		const out = http.request(upstream.origin + (req.url ?? "/"), { method: req.method, headers });
		out.on("upgrade", (up, upSocket, upHead) => {
			const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
			for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
			socket.write(lines.join("\r\n") + "\r\n\r\n");
			if (upHead?.length) socket.write(upHead);
			if (head?.length) upSocket.write(head);
			upSocket.pipe(socket).pipe(upSocket);
			upSocket.on("error", () => socket.destroy());
			socket.on("error", () => upSocket.destroy());
		});
		out.on("error", () => socket.destroy());
		out.end();
	}

	function start() {
		if (server) return Promise.resolve();
		const host = state.host ?? lanHost();
		const port = state.port ?? DEFAULT_PORT;
		if (!host) { lastError = "No network address found. Connect this computer to your home network."; onChange(snapshot()); return Promise.resolve(); }
		return new Promise((resolve) => {
			const srv = http.createServer(onRequest);
			srv.on("upgrade", onUpgrade);
			srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
			srv.once("error", (err) => {
				lastError = `Couldn’t listen on ${host}:${port} (${err.code ?? err.message}).`;
				log(`[remote] ${lastError}`);
				server = null;
				onChange(snapshot());
				resolve();
			});
			srv.listen(port, host, () => {
				server = srv;
				listening = { host, port: srv.address().port };
				lastError = null;
				log(`[remote] listening on http://${listening.host}:${listening.port}`);
				onChange(snapshot());
				resolve();
			});
		});
	}

	function stop() {
		pairing = null;
		if (!server) return Promise.resolve();
		const srv = server;
		server = null;
		listening = null;
		for (const s of sockets) s.destroy();
		sockets.clear();
		return new Promise((resolve) => srv.close(() => { log("[remote] stopped"); onChange(snapshot()); resolve(); }));
	}

	async function setEnabled(enabled) {
		state.enabled = !!enabled;
		persist();
		if (state.enabled) await start(); else await stop();
		return snapshot();
	}

	/** New one-time pairing URL; replaces any previous unused code. */
	function newPairing() {
		if (!listening) throw new Error("Remote control is not listening.");
		const code = randomBytes(16).toString("hex");
		const expiresAt = now() + PAIR_TTL_MS;
		pairing = { hash: sha256(code), expiresAt };
		return { url: `http://${listening.host}:${listening.port}${PAIR_PATH}?code=${code}`, expiresAt };
	}

	function revoke(id) {
		state.devices = state.devices.filter((d) => d.id !== id);
		persist();
		// Drop the revoked device's live connections (SSE, keep-alive, upgrades).
		for (const s of sockets) if (socketDevice.get(s) === id) s.destroy();
		return snapshot();
	}

	/** IPC dispatcher for "lh:remote:control". */
	async function control(command) {
		switch (command?.op) {
			case "status": return snapshot();
			case "enable": return setEnabled(true);
			case "disable": return setEnabled(false);
			case "pair": return newPairing();
			case "revoke": return revoke(String(command.id ?? ""));
			default: throw new Error("Unknown remote control request.");
		}
	}

	return { start, stop, control, snapshot, boot: () => (state.enabled ? start() : Promise.resolve()) };
}

module.exports = { createRemoteControl, fileStore, defaultLanHost, stripOwnCookie, parseCookies, COOKIE, PAIR_PATH };
