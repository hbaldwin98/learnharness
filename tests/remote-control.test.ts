import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { createRemoteControl, stripOwnCookie, COOKIE } = require("../electron/remote-control.cjs");
const { HEADER } = require("../electron/desktop-api.cjs");
const secret = "s".repeat(64);

type Seen = { url?: string; headers: http.IncomingHttpHeaders; method?: string };

async function fixture() {
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
	const rc = createRemoteControl({ store, target: () => ({ origin, secret }) });
	const snap = await rc.control({ op: "enable" });
	const base: string = snap.url;
	const close = async () => { await rc.stop(); await new Promise((r) => upstream.close(r)); };
	return { rc, base, origin, seen, close, saved: () => saved };
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
	const rc = createRemoteControl({ store, target: () => null, now: () => t });
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
	const rc = createRemoteControl({ store, target: () => null, networks: () => nets, lanHost: () => "127.0.0.1" });
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

test("stripOwnCookie keeps other cookies only", () => {
	assert.equal(stripOwnCookie(`a=1; ${COOKIE}=x; b=2`), "a=1; b=2");
	assert.equal(stripOwnCookie(`${COOKIE}=x`), undefined);
	assert.equal(stripOwnCookie(undefined), undefined);
});
