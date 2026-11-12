/**
 * LANGUAGE SERVERS WITHOUT DOCKER (ported from the fork's code-lsp tests):
 * JSON-RPC framing, diagnostics normalization, the client against a fake
 * server, and one item's session over a fake runner.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { frame, LspClient, LspFramer, normalizeDiagnostics } from "../src/server/lsp-client.ts";
import { createDiagnosticsSession } from "../src/server/diagnostics.ts";
import { languageSpec, LSP_ROOT } from "../src/server/languages.ts";
import type { SpawnedProcess } from "../src/server/docker-runner.ts";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("condition not met");
		await tick();
	}
}

describe("framing", () => {
	it("splits coalesced messages and joins split ones", () => {
		const framer = new LspFramer();
		const a = frame({ id: 1 });
		const b = frame({ id: 2, text: "héllo" });
		const both = Buffer.concat([a, b]);
		assert.deepEqual(framer.push(both.subarray(0, 5)), []);
		assert.deepEqual(framer.push(both.subarray(5, a.length + 3)), [{ id: 1 }]);
		assert.deepEqual(framer.push(both.subarray(a.length + 3)), [{ id: 2, text: "héllo" }]);
	});

	it("skips stray non-header output", () => {
		const framer = new LspFramer();
		assert.deepEqual(framer.push(Buffer.concat([Buffer.from("noise\r\n\r\n"), frame({ ok: true })])), [{ ok: true }]);
	});
});

describe("normalizeDiagnostics", () => {
	it("keeps errors and warnings (absent severity = error), drops information and hints", () => {
		const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
		const out = normalizeDiagnostics("a.py", [
			{ range, severity: 1, message: "bad", source: "basedpyright" },
			{ range, severity: 2, message: "meh" },
			{ range, severity: 3, message: "info" },
			{ range, severity: 4, message: "hint" },
			{ range, message: "no severity" },
		]);
		assert.deepEqual(
			out.map((d) => [d.severity, d.message]),
			[
				["error", "bad"],
				["warning", "meh"],
				["error", "no severity"],
			],
		);
		assert.deepEqual(out[0], { path: "a.py", line: 2, column: 4, endLine: 2, endColumn: 9, severity: "error", message: "bad", source: "basedpyright" });
	});
});

/** A fake language server on a pair of streams: answers initialize, asks
 *  for configuration once, and publishes one error per synced file whose
 *  text contains "ERR" (none otherwise). Records what it was sent. */
function fakeServer() {
	const toServer = new PassThrough();
	const toClient = new PassThrough();
	const framer = new LspFramer();
	const seen: Array<{ method?: string; params?: any; id?: unknown; result?: unknown }> = [];
	const send = (m: unknown) => toClient.write(frame(m));
	toServer.on("data", (chunk: Buffer) => {
		for (const raw of framer.push(chunk)) {
			const m = raw as { method?: string; params?: any; id?: unknown; result?: unknown };
			seen.push(m);
			if (m.method === "initialize") {
				send({ jsonrpc: "2.0", id: 900, method: "workspace/configuration", params: { items: [{ section: "python.analysis" }] } });
				send({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } });
			}
			if (m.method === "shutdown") send({ jsonrpc: "2.0", id: m.id, result: null });
			if (m.method === "textDocument/didOpen" || m.method === "textDocument/didChange") {
				const uri = m.params.textDocument.uri as string;
				const text = (m.params.textDocument.text ?? m.params.contentChanges[0].text) as string;
				send({
					jsonrpc: "2.0",
					method: "textDocument/publishDiagnostics",
					params: {
						uri,
						diagnostics: text.includes("ERR") ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "found ERR" }] : [],
					},
				});
			}
		}
	});
	return { stdin: toServer, stdout: toClient, seen, publish: send };
}

describe("LspClient", () => {
	it("initializes with diagnostics-only capabilities, answers configuration, maps diagnostics to paths", async () => {
		const server = fakeServer();
		const got: Array<[string, number]> = [];
		const client = new LspClient(server.stdin, server.stdout, {
			root: "/work/lsp",
			settings: { python: { analysis: { typeCheckingMode: "standard" } } },
			onDiagnostics: (path, list) => got.push([path, list.length]),
		});
		await client.initialize();
		const init = server.seen.find((m) => m.method === "initialize")!;
		assert.equal(init.params.rootUri, "file:///work/lsp");
		assert.deepEqual(Object.keys(init.params.capabilities.textDocument).sort(), ["publishDiagnostics", "synchronization"]);
		await until(() => server.seen.some((m) => m.id === 900));
		assert.deepEqual(server.seen.find((m) => m.id === 900)!.result, [{ typeCheckingMode: "standard" }]);
		assert.ok(server.seen.some((m) => m.method === "workspace/didChangeConfiguration"));

		client.sync("src/a b.py", "python", "ERR here");
		client.sync("src/a b.py", "python", "fine");
		await until(() => got.length === 2);
		assert.deepEqual(got, [
			["src/a b.py", 1],
			["src/a b.py", 0],
		]);
		const change = server.seen.find((m) => m.method === "textDocument/didChange")!;
		assert.equal(change.params.textDocument.version, 2);
		assert.equal(change.params.textDocument.uri, "file:///work/lsp/src/a%20b.py");
		assert.equal(server.seen.filter((m) => m.method === "textDocument/didSave").length, 2);

		// Diagnostics for files outside the root are ignored.
		server.publish({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///usr/lib/x.py", diagnostics: [] } });
		await tick(30);
		assert.equal(got.length, 2);
	});
});

describe("an item's diagnostics session", () => {
	const python = languageSpec("python")!;

	function fakeRunner(opts: { crashes?: number } = {}) {
		const writes: Array<{ dir: string; files: string[]; fresh: boolean }> = [];
		let crashes = opts.crashes ?? 0;
		const runner = {
			writeFiles: async ({ dir, files, fresh }: { dir: string; files: { path: string }[]; fresh?: boolean }) => {
				writes.push({ dir, files: files.map((f) => f.path), fresh: Boolean(fresh) });
			},
			spawn: async () => {
				const server = fakeServer();
				let end!: () => void;
				const exited = new Promise<void>((r) => (end = r));
				const proc: SpawnedProcess = { stdin: server.stdin, stdout: server.stdout, exited, kill: () => end() };
				if (crashes > 0) {
					crashes--;
					setTimeout(() => { server.stdout.end(); end(); }, 5);
				}
				return proc;
			},
		};
		return { runner, writes };
	}

	it("writes the config and the learner's code (never the tests) and goes ready", async () => {
		const { runner, writes } = fakeRunner();
		const session = createDiagnosticsSession({ runner: runner as never, key: { chatId: "c", itemId: "p" }, spec: python, code: "def rev(xs): ...\n", onChange: () => {} });
		await until(() => session.snapshot().status === "ready");
		assert.deepEqual(writes[0], { dir: LSP_ROOT, files: ["pyrightconfig.json", "answer.py"], fresh: true });
		assert.equal(session.snapshot().name, "Python");
		await session.stop();
	});

	it("feeds changes to disk and the server, and keeps the latest diagnostics", async () => {
		const { runner, writes } = fakeRunner();
		const session = createDiagnosticsSession({ runner: runner as never, key: { chatId: "c", itemId: "p" }, spec: python, code: "ok\n", onChange: () => {} });
		await until(() => session.snapshot().status === "ready");
		session.update("ERR\n");
		await until(() => session.snapshot().diagnostics.length === 1);
		assert.deepEqual(writes.at(-1), { dir: LSP_ROOT, files: ["answer.py"], fresh: false });
		session.update("fine\n");
		await until(() => session.snapshot().diagnostics.length === 0);
		await session.stop();
	});

	it("restarts once after a crash, then reports crashed", async () => {
		const { runner } = fakeRunner({ crashes: 2 });
		const session = createDiagnosticsSession({ runner: runner as never, key: { chatId: "c", itemId: "p" }, spec: python, code: "x\n", onChange: () => {} });
		await until(() => session.snapshot().status === "crashed");
		await session.stop();
	});
});
