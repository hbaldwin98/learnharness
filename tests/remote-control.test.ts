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
		assert.deepEqual(JSON.parse(status.body), { remote: true, uploads: true });

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
