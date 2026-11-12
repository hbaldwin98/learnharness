/**
 * Fork remote control vs the browser-only API gate (proxy.ts): a request a
 * paired phone sends through the LAN proxy must pass proxy.ts, both in
 * browser-only mode (`next dev -H localhost`, no desktop secret) and in
 * desktop mode (per-launch secret), including when the dev server listens
 * on IPv6 ::1 behind the name `localhost` (Windows).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";

const require = createRequire(import.meta.url);
const { createRemoteControl, COOKIE } = require("../electron/remote-control.cjs");
const secret = "s".repeat(64);

type Env = Record<string, string | undefined>;
function withEnv<T>(values: Env, run: () => T): T {
	const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	try { return run(); } finally {
		for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	}
}

const BROWSER_ONLY: Env = { LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined, LH_ALLOWED_HOSTS: undefined };
const DESKTOP: Env = { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret, LH_ALLOWED_HOSTS: undefined };

/** An upstream that answers every request with what proxy.ts decides. */
async function gatedUpstream(env: Env, listenHost: string, originHost: string) {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
			const method = req.method ?? "GET";
			const request = new NextRequest(`http://${req.headers.host}${req.url}`, {
				method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
			});
			const decision = withEnv(env, () => proxy(request));
			res.writeHead(decision.status === 200 ? 200 : decision.status, { "Content-Type": "text/plain" });
			res.end(decision.status === 200 ? "passed" : "refused");
		});
	});
	await new Promise<void>((r) => server.listen(0, listenHost, r));
	const origin = `http://${originHost}:${(server.address() as AddressInfo).port}`;
	return { origin, close: () => new Promise((r) => server.close(r)) };
}

function request(url: string, opts: http.RequestOptions = {}, body?: string) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = http.request(url, opts, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function pairCookie(pairUrl: string) {
	return new Promise<string>((resolve, reject) => {
		http.get(pairUrl, { headers: { "User-Agent": "Mozilla/5.0 (iPhone)" } }, (res) => {
			res.resume();
			const raw = String(res.headers["set-cookie"]?.[0] ?? "");
			resolve(raw.split(";")[0] ?? "");
		}).on("error", reject);
	});
}

async function exercise(env: Env, desktopSecret: string | null, listenHost: string, originHost: string) {
	const upstream = await gatedUpstream(env, listenHost, originHost);
	const store = { load: () => ({ enabled: false, port: 0, host: "127.0.0.1", devices: [] }), save: () => {} };
	const rc = createRemoteControl({ store, target: () => ({ origin: upstream.origin, secret: desktopSecret }), detectTailscale: async () => null });
	try {
		const { url: base } = await rc.control({ op: "enable" });
		const { url: pairUrl } = await rc.control({ op: "pair" });
		const cookie = await pairCookie(pairUrl);
		assert.match(cookie, new RegExp(`^${COOKIE}=`));
		const phoneOrigin = new URL(base).origin;
		const read = await request(`${base}/api/chats`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } });
		assert.equal(read.status, 200, read.body);
		assert.equal(read.body, "passed");
		const write = await request(`${base}/api/chats`, {
			method: "POST",
			headers: { Cookie: cookie, Origin: phoneOrigin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
		}, "{}");
		assert.equal(write.status, 200, write.body);
		assert.equal(write.body, "passed");
	} finally {
		await rc.stop();
		await upstream.close();
	}
}

test("a paired phone's reads and writes pass proxy.ts in browser-only mode (next dev -H localhost)", async () => {
	await exercise(BROWSER_ONLY, null, "127.0.0.1", "localhost");
});

test("a paired phone's reads and writes pass proxy.ts in desktop mode (per-launch secret)", async () => {
	await exercise(DESKTOP, secret, "127.0.0.1", "127.0.0.1");
});

test("the proxy reaches a dev server that listens on IPv6 ::1 as localhost", async (t) => {
	const ipv6 = await new Promise<boolean>((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.listen(0, "::1", () => probe.close(() => resolve(true)));
	});
	if (!ipv6) { t.skip("no IPv6 loopback on this machine"); return; }
	await exercise(BROWSER_ONLY, null, "::1", "localhost");
});

test("a cross-site write through the proxy is still refused", async () => {
	const upstream = await gatedUpstream(BROWSER_ONLY, "127.0.0.1", "localhost");
	const store = { load: () => ({ enabled: false, port: 0, host: "127.0.0.1", devices: [] }), save: () => {} };
	const rc = createRemoteControl({ store, target: () => ({ origin: upstream.origin, secret: null }), detectTailscale: async () => null });
	try {
		const { url: base } = await rc.control({ op: "enable" });
		const { url: pairUrl } = await rc.control({ op: "pair" });
		const cookie = await pairCookie(pairUrl);
		const res = await request(`${base}/api/chats`, { method: "POST", headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } }, "{}");
		assert.equal(res.status, 403);
	} finally {
		await rc.stop();
		await upstream.close();
	}
});
