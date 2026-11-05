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
const pwa = require("./remote-pwa.cjs");
const { acceptWebSocket } = require("./remote-ws.cjs");
const { relayDictation, openWorkerPort, dictationStatus } = require("./remote-dictation.cjs");

const COOKIE = "lh_remote";
const PAIR_PATH = "/_remote/pair";
const STATUS_PATH = "/_remote/status";
const UPLOAD_PATH = "/_remote/upload";
const DICTATION_PATH = "/_remote/dictation";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const PAIR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PORT = 47800;
const TOKEN_MAX_AGE_S = 365 * 24 * 60 * 60;

/** A filesystem-safe basename; never empty, never a path. */
function safeFileName(raw) {
	const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
	const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
	return cleaned || "upload";
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function safeEqualHex(a, b) {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Non-internal IPv4 adapters, in OS order: [{name, address}]. */
function listNetworks(interfaces = os.networkInterfaces()) {
	const out = [];
	for (const [name, list] of Object.entries(interfaces)) {
		for (const addr of list ?? []) {
			if ((addr.family === "IPv4" || addr.family === 4) && !addr.internal) out.push({ name, address: addr.address });
		}
	}
	return out;
}

/** Fallback when no network was picked: the first non-internal IPv4, or null. */
function defaultLanHost(interfaces = os.networkInterfaces()) {
	return listNetworks(interfaces)[0]?.address ?? null;
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
 * @param {() => {name: string, address: string}[]} [o.networks]
 * @param {(snapshot: any) => void} [o.onChange]
 * @param {string | null} [o.uploadDir] where phone attachments are saved (null = uploads off)
 * @param {{192?: Buffer, 512?: Buffer}} [o.icons] PWA icons
 * @param {() => Promise<{dnsName: string, certificates: boolean} | null>} [o.detectTailscale]
 * @param {(dnsName: string) => Promise<boolean>} [o.probeHttps]
 * @param {() => any} [o.dictation] the desktop's local dictation engine (electron/dictation.cjs), or null
 */
function createRemoteControl({ store, target, log = () => {}, now = Date.now, lanHost = defaultLanHost, networks = listNetworks, onChange = () => {}, uploadDir = null, icons = {}, detectTailscale = pwa.detectTailscale, probeHttps = (dnsName, listenerUrl) => pwa.serveConfigured(dnsName, listenerUrl).then((ok) => ok || pwa.probeHttps(dnsName)), dictation = () => null }) {
	let state = store.load();
	let server = null;
	let loopback = null; // 127.0.0.1 twin: `tailscale serve` on Windows can't reach the machine's own Tailscale IP
	let listening = null; // {host, port}
	let lastError = null;
	let pairing = null; // {hash, codeHash, expiresAt, failures}
	let tailscale = null; // {dnsName, certificates, httpsReady}
	const MAX_CODE_FAILURES = 10;

	const lanOrigin = () => (listening ? `http://${listening.host}:${listening.port}` : null);
	const httpsOrigin = () => (tailscale?.httpsReady ? `https://${tailscale.dnsName}` : null);
	/** Origins the phone may legitimately use: the LAN listener and, once verified, the Tailscale HTTPS name. */
	const ownOrigins = () => [lanOrigin(), tailscale ? `https://${tailscale.dnsName}` : null].filter(Boolean);
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
			host: state.host ?? null, // null = automatic (first adapter)
			networks: networks(),
			tailscale: tailscale && {
				dnsName: tailscale.dnsName,
				certificates: tailscale.certificates,
				httpsReady: tailscale.httpsReady,
				url: `https://${tailscale.dnsName}`,
				serveCommand: listening ? `tailscale serve --bg http://127.0.0.1:${listening.port}` : null,
			},
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
		completePairing(req, res);
	}

	/** POST /_remote/pair-code (form: code=XXXX-XXXX) — in-app pairing for installed home-screen apps. */
	function handlePairCode(req, res) {
		if (req.method !== "POST" || !ownOrigins().includes(req.headers.origin)) return send(res, 403, pwa.notPairedPage("Request rejected."));
		let body = "";
		req.on("data", (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
		req.on("end", () => {
			const entered = pwa.normalizeShortCode(new URLSearchParams(body).get("code"));
			const live = pairing && pairing.expiresAt > now();
			if (live && entered && safeEqualHex(pairing.codeHash, sha256(entered))) return completePairing(req, res);
			if (live) {
				pairing.failures++;
				if (pairing.failures >= MAX_CODE_FAILURES) { pairing = null; log("[remote] pairing cancelled after too many wrong codes"); }
			}
			send(res, 403, pwa.notPairedPage(live && pairing ? "That code didn’t match. Check it and try again." : "No active code. Tap “Show QR code” on your computer to get a new one."));
		});
	}

	function completePairing(req, res) {
		pairing = null; // single use: consumes both the QR link and the short code
		const token = randomBytes(32).toString("hex");
		const stamp = new Date(now()).toISOString();
		state.devices.push({ id: randomBytes(8).toString("hex"), name: deviceName(req.headers["user-agent"]), hash: sha256(token), createdAt: stamp, lastSeen: stamp });
		persist();
		log("[remote] device paired");
		// A real page, not an empty 302: through `tailscale serve`, iOS Safari saved the
		// empty redirect body as a "pair.txt" download. The page forwards to the app.
		send(res, 200, `<!doctype html><html><head><meta charset="utf-8">${pwa.HEAD_TAGS}<meta http-equiv="refresh" content="0;url=/"><title>Paired</title></head><body style="font-family:system-ui;background:#141414;color:#e5e5e5;padding:32px 24px"><p>Paired. Opening LearnHarness…</p><script>location.replace("/")</script></body></html>`, {
			"Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TOKEN_MAX_AGE_S}; Expires=${new Date(now() + TOKEN_MAX_AGE_S * 1000).toUTCString()}`, // Lax: iOS home-screen cold launches drop Strict cookies; writes are origin-checked
		});
	}

	/** Shared header rewrite for HTTP and upgrade requests. Returns null to reject. */
	function forwardHeaders(req, upstream) {
		const owns = ownOrigins();
		const headers = { ...req.headers };
		for (const name of Object.keys(headers)) if (name.toLowerCase() === HEADER) delete headers[name];
		const origin = headers.origin;
		if (origin && !owns.includes(origin)) {
			const method = (req.method ?? "GET").toUpperCase();
			if (method !== "GET" && method !== "HEAD") return null;
		}
		if (origin) headers.origin = upstream.origin;
		headers.host = new URL(upstream.origin).host;
		const via = owns.find((o) => headers.referer?.startsWith(o));
		if (via) headers.referer = upstream.origin + headers.referer.slice(via.length);
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

	const json = (res, status, body) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	};

	/** Raw-body upload (?name=…) → saved under uploadDir/<date>/<random>/<name>; replies {path}. */
	function handleUpload(req, res, url) {
		if (req.method !== "POST" || !ownOrigins().includes(req.headers.origin)) return json(res, 403, { error: "Forbidden." });
		if (!uploadDir) return json(res, 503, { error: "Uploads are unavailable." });
		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > MAX_UPLOAD_BYTES) { req.resume(); return json(res, 413, { error: "File is larger than 100 MB." }); }
		const day = new Date(now()).toISOString().slice(0, 10);
		const dir = require("node:path").join(uploadDir, day, randomBytes(4).toString("hex"));
		const file = require("node:path").join(dir, safeFileName(url.searchParams.get("name")));
		fs.mkdirSync(dir, { recursive: true });
		const out = fs.createWriteStream(file, { flags: "wx" });
		let bytes = 0;
		let failed = false;
		const fail = (status, error) => {
			if (failed) return;
			failed = true;
			req.unpipe(out); out.destroy(); req.resume();
			fs.rm(dir, { recursive: true, force: true }, () => {});
			json(res, status, { error });
		};
		req.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_UPLOAD_BYTES) fail(413, "File is larger than 100 MB."); });
		req.on("aborted", () => fail(400, "Upload interrupted."));
		out.on("error", () => fail(500, "Could not save the file."));
		out.on("finish", () => { if (!failed) { log("[remote] upload saved"); json(res, 200, { path: file }); } });
		req.pipe(out);
	}

	function onRequest(req, res) {
		const url = new URL(req.url ?? "/", "http://remote.invalid");
		if (url.pathname === PAIR_PATH) return handlePair(req, res, url);
		if (url.pathname === "/_remote/pair-code") return handlePairCode(req, res);
		if (pwa.servePwaAsset(url.pathname, res, icons)) return;
		if (!authorize(req)) return send(res, 401, pwa.notPairedPage(null));
		if (url.pathname === STATUS_PATH) return json(res, 200, { remote: true, uploads: !!uploadDir, dictation: !!dictation() });
		if (url.pathname === `${DICTATION_PATH}/status`) return json(res, 200, dictationStatus(dictation()));
		if (url.pathname === UPLOAD_PATH) return handleUpload(req, res, url);
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
		if (new URL(req.url ?? "/", "http://remote.invalid").pathname === DICTATION_PATH) return onDictationUpgrade(req, socket, head);
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

	/** Phone dictation: a WebSocket relayed onto the local dictation worker. */
	function onDictationUpgrade(req, socket, head) {
		const engine = dictation();
		if (!authorize(req) || !ownOrigins().includes(req.headers.origin)) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
		if (!engine) { socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
		const ws = acceptWebSocket(req, socket, head);
		if (ws) relayDictation(ws, () => openWorkerPort(engine));
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
				if (host !== "127.0.0.1") {
					const lo = http.createServer(onRequest);
					lo.on("upgrade", onUpgrade);
					lo.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
					lo.once("error", (err) => log(`[remote] loopback listener unavailable (${err.code ?? err.message})`));
					lo.listen(listening.port, "127.0.0.1", () => { loopback = lo; });
				}
				onChange(snapshot());
				resolve();
				void refreshTailscale();
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
		loopback?.close();
		loopback = null;
		return new Promise((resolve) => srv.close(() => { log("[remote] stopped"); onChange(snapshot()); resolve(); }));
	}

	async function setEnabled(enabled) {
		state.enabled = !!enabled;
		persist();
		if (state.enabled) await start(); else await stop();
		return snapshot();
	}

	/** Pick the adapter to listen on (null = automatic); restarts a live listener. */
	async function setHost(host) {
		if (host !== null && !networks().some((n) => n.address === host)) throw new Error("That network isn’t available on this computer.");
		if (host === null) delete state.host; else state.host = host;
		persist();
		if (state.enabled) { await stop(); await start(); }
		return snapshot();
	}

	/** New one-time pairing URL; replaces any previous unused code. */
	function newPairing() {
		if (!listening) throw new Error("Remote control is not listening.");
		const code = randomBytes(16).toString("hex");
		const shortCode = pwa.newShortCode();
		const expiresAt = now() + PAIR_TTL_MS;
		pairing = { hash: sha256(code), codeHash: sha256(pwa.normalizeShortCode(shortCode)), expiresAt, failures: 0 };
		const base = httpsOrigin() ?? lanOrigin();
		return { url: `${base}${PAIR_PATH}?code=${code}`, shortCode, expiresAt };
	}

	/** Re-detect Tailscale and whether `tailscale serve` reaches this listener. */
	async function refreshTailscale() {
		const found = await detectTailscale().catch(() => null);
		const httpsReady = !!(found && listening && (await probeHttps(found.dnsName, [lanOrigin(), `http://127.0.0.1:${listening.port}`]).catch(() => false)));
		tailscale = found ? { ...found, httpsReady } : null;
		onChange(snapshot());
		return snapshot();
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
			case "setHost": return setHost(typeof command.host === "string" ? command.host : null);
			case "checkTailscale": return refreshTailscale();
			case "revoke": return revoke(String(command.id ?? ""));
			default: throw new Error("Unknown remote control request.");
		}
	}

	return { start, stop, control, snapshot, boot: () => (state.enabled ? start() : Promise.resolve()) };
}

/** 192/512 PNGs for the PWA manifest, from the 512px app icon (main process only). */
function pwaIcons(file, log) {
	try {
		const { nativeImage } = require("electron");
		const img = nativeImage.createFromPath(file);
		if (img.isEmpty()) throw new Error("icon not found");
		return { 512: img.toPNG(), 192: img.resize({ width: 192, height: 192, quality: "best" }).toPNG() };
	} catch (e) {
		log(`[remote] PWA icons unavailable: ${e instanceof Error ? e.message : e}`);
		return {};
	}
}

/** All main-process wiring in one call, so electron/main.cjs carries a
 *  single hunk (upstream-merge isolation). `trusted(event)` is main.cjs's
 *  own trusted-window check. */
function installRemoteControl({ app, ipcMain, BrowserWindow, path, trusted, origin, secret, log, dictation = () => null }) {
	const rc = createRemoteControl({
		store: fileStore(path.join(app.getPath("userData"), "remote-control.json")),
		target: () => ({ origin, secret: secret() }),
		log,
		uploadDir: path.join(app.getPath("userData"), "remote-uploads"),
		icons: pwaIcons(path.join(__dirname, "remote-icon.png"), log),
		dictation,
		onChange: (snapshot) => {
			for (const win of BrowserWindow.getAllWindows()) win.webContents.send("lh:remote:changed", snapshot);
		},
	});
	ipcMain.handle("lh:remote:control", async (event, command) => {
		if (!trusted(event)) throw new Error("Untrusted desktop request.");
		return rc.control(command);
	});
	app.on("before-quit", () => { void rc.stop(); });
	void rc.boot();
	return rc;
}

module.exports = { safeFileName, createRemoteControl, installRemoteControl, fileStore, defaultLanHost, listNetworks, stripOwnCookie, parseCookies, COOKIE, PAIR_PATH };
