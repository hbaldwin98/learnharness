/**
 * LANGUAGE SERVERS — the parts without Docker (docs/practice-workspaces-plan.md,
 * step 4): JSON-RPC framing, the diagnostics normalization (errors and
 * warnings only), the client against a fake server (initialize, answering
 * the server's configuration request, publishDiagnostics → paths), one
 * problem's session over a fake runner (hidden tests never written, saves
 * fed in, unknown files ignored, one restart then "crashed"), the language
 * table's server entries, and the editor's position mapping.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { Text } from "@codemirror/state";

import { frame, LspClient, LspFramer, normalizeDiagnostics } from "../src/agent/workspaces/code/lsp-client.ts";
import { createDiagnosticsSession } from "../src/agent/workspaces/code/diagnostics.ts";
import { CODE_LANGUAGES, LANGUAGES, LSP_ROOT } from "../src/agent/workspaces/code/languages.ts";
import type { CodeRunner, SpawnedProcess } from "../src/agent/workspaces/code/runner.ts";
import type { CodeFile } from "../src/core/contracts/workspaces.ts";
import { toEditorDiagnostics } from "../components/workspaces/code/diagnostic-positions.ts";

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

describe("a problem's diagnostics session", () => {
	const FILES: CodeFile[] = [{ path: "solution.py", content: "def rev(xs): ...\n" }];
	const VISIBLE: CodeFile[] = [{ path: "test_visible.py", content: "def test_a(): ...\n" }];

	function fakeRunner(opts: { crashes?: number } = {}) {
		const writes: Array<{ dir: string; files: string[]; fresh: boolean }> = [];
		const servers: Array<ReturnType<typeof fakeServer> & { proc: SpawnedProcess; end: () => void }> = [];
		let crashes = opts.crashes ?? 0;
		const runner: CodeRunner = {
			status: async () => "running",
			ensureImage: async () => ({ ok: true }),
			run: async () => ({ steps: [], report: null }),
			remove: async () => {},
			writeFiles: async ({ dir, files, fresh }) => {
				writes.push({ dir, files: files.map((f) => f.path), fresh: Boolean(fresh) });
			},
			spawn: async () => {
				const server = fakeServer();
				let end!: () => void;
				const exited = new Promise<void>((r) => (end = r));
				const proc: SpawnedProcess = { stdin: server.stdin, stdout: server.stdout, exited, kill: () => end() };
				servers.push({ ...server, proc, end });
				if (crashes > 0) {
					crashes--;
					setTimeout(() => {
						server.stdout.end();
						end();
					}, 5);
				}
				return proc;
			},
		};
		return { runner, writes, servers };
	}

	it("writes config + learner files + visible tests (never the hidden ones) and goes ready", async () => {
		const { runner, writes } = fakeRunner();
		const changes: number[] = [];
		const session = createDiagnosticsSession({
			runner,
			key: { chatId: "c", problemCallId: "p" },
			language: "python",
			files: FILES,
			visibleTests: VISIBLE,
			onChange: () => changes.push(1),
		});
		await until(() => session.snapshot().status === "ready");
		assert.deepEqual(writes[0], { dir: LSP_ROOT, files: ["pyrightconfig.json", "solution.py", "test_visible.py"], fresh: true });
		assert.equal(session.snapshot().name, "Python");
		await session.stop();
	});

	it("feeds saves (changed files only, to disk and to the server) and keeps diagnostics per known file", async () => {
		const { runner, writes, servers } = fakeRunner();
		const session = createDiagnosticsSession({ runner, key: { chatId: "c", problemCallId: "p" }, language: "python", files: FILES, visibleTests: VISIBLE, onChange: () => {} });
		await until(() => session.snapshot().status === "ready");
		session.update([{ path: "solution.py", content: "ERR\n" }, { path: "not-a-file.py", content: "ERR" }]);
		await until(() => (session.snapshot().files["solution.py"] ?? []).length === 1);
		assert.deepEqual(writes.at(-1), { dir: LSP_ROOT, files: ["solution.py"], fresh: false });
		// Unchanged content is not re-sent.
		const before = servers[0]!.seen.length;
		session.update([{ path: "solution.py", content: "ERR\n" }]);
		await tick(30);
		assert.equal(servers[0]!.seen.length, before);
		// A diagnostic for a file the learner can't see is dropped.
		servers[0]!.publish({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///work/lsp/pyrightconfig.json", diagnostics: [{ message: "x" }] } });
		await tick(30);
		assert.equal(session.snapshot().files["pyrightconfig.json"], undefined);
		session.update([{ path: "solution.py", content: "ok\n" }]);
		await until(() => (session.snapshot().files["solution.py"] ?? []).length === 0);
		await session.stop();
	});

	it("restarts once after a crash, then reports crashed", async () => {
		const once = fakeRunner({ crashes: 1 });
		const s1 = createDiagnosticsSession({ runner: once.runner, key: { chatId: "c", problemCallId: "p" }, language: "python", files: FILES, visibleTests: VISIBLE, onChange: () => {} });
		await until(() => once.servers.length === 2 && s1.snapshot().status === "ready");
		await s1.stop();

		const twice = fakeRunner({ crashes: 2 });
		const s2 = createDiagnosticsSession({ runner: twice.runner, key: { chatId: "c", problemCallId: "p" }, language: "python", files: FILES, visibleTests: VISIBLE, onChange: () => {} });
		await until(() => s2.snapshot().status === "crashed");
		assert.equal(twice.servers.length, 2);
		await s2.stop();
	});
});

describe("the language table's servers", () => {
	it("every language has a server command, a name and a language id", () => {
		for (const id of CODE_LANGUAGES) {
			const lsp = LANGUAGES[id].lsp;
			assert.ok(lsp.command.length > 0, id);
			assert.ok(lsp.name.length > 0, id);
			assert.ok(lsp.languageId("x").length > 0, id);
			for (const f of lsp.config) assert.ok(!LANGUAGES[id].scaffold.includes(f.path), `${id} config ${f.path} doesn't shadow a scaffold file`);
		}
		assert.equal(LANGUAGES.typescript.lsp.languageId("a.js"), "javascript");
		assert.equal(LANGUAGES.typescript.lsp.languageId("a.ts"), "typescript");
	});
});

describe("editor positions", () => {
	it("maps 0-based line/column to offsets and clamps past the end", () => {
		const doc = Text.of(["abc", "defgh"]);
		const [inLine, pastColumn, pastLine] = toEditorDiagnostics(doc, [
			{ path: "a", line: 1, column: 1, endLine: 1, endColumn: 3, severity: "error", message: "m" },
			{ path: "a", line: 0, column: 9, endLine: 0, endColumn: 12, severity: "warning", message: "w", source: "s" },
			{ path: "a", line: 7, column: 0, endLine: 8, endColumn: 0, severity: "error", message: "gone" },
		]);
		assert.deepEqual(inLine, { from: 5, to: 7, severity: "error", message: "m" });
		assert.deepEqual(pastColumn, { from: 3, to: 3, severity: "warning", message: "w", source: "s" });
		assert.deepEqual(pastLine, { from: doc.length, to: doc.length, severity: "error", message: "gone" });
	});
});
