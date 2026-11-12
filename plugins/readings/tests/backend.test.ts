import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate, importForkData, openStore } from "../src/backend.ts";

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-readings-"));
}
const reading = (id: string, extra: object = {}) => ({ id, kind: "recap", mode: "model", status: "ready", title: `R ${id}`, anchor: { chatId: "c1" }, snapshot: {}, body: "b", createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z", ...extra });

test("import of the fork's stores is idempotent, settles live work and never touches the old files", () => {
	const root = tmp();
	try {
		const learning = path.join(root, "learning");
		fs.mkdirSync(path.join(learning, "readings"), { recursive: true });
		fs.mkdirSync(path.join(learning, "reading-discussions"), { recursive: true });
		fs.writeFileSync(path.join(learning, "readings", "rd_a.json"), JSON.stringify(reading("rd_a")));
		fs.writeFileSync(path.join(learning, "readings", "rd_b.json"), JSON.stringify(reading("rd_b", { status: "writing", activity: "web_fetch" })));
		fs.writeFileSync(path.join(learning, "readings", "rd_new.json"), JSON.stringify(reading("rd_new", { version: 9 })));
		const side = { id: "side", createdAt: "x", exchanges: [{ id: "dx1", question: "q", mode: "model", status: "answering", askedAt: "x" }] };
		fs.writeFileSync(path.join(learning, "reading-discussions", "rd_a.json"), JSON.stringify({ readingId: "rd_a", side, threads: [], createdAt: "x", updatedAt: "x" }));
		const before = fs.readFileSync(path.join(learning, "readings", "rd_b.json"), "utf8");
		const store = openStore(path.join(root, "data"));
		assert.deepEqual(importForkData(learning, store), { readings: ["rd_a", "rd_b"], discussions: ["rd_a"] });
		assert.equal(store.getReading("rd_b")!.status, "error");
		assert.equal(store.getReading("rd_b")!.activity, undefined);
		assert.equal(store.getReading("rd_a")!.importedFrom, "fork-host");
		assert.equal(store.getDiscussion("rd_a")!.side.exchanges[0]!.status, "error");
		assert.deepEqual(importForkData(learning, store), { readings: [], discussions: [] });
		assert.equal(fs.readFileSync(path.join(learning, "readings", "rd_b.json"), "utf8"), before);
		assert.equal(store.getReading("rd_new"), null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function fixture(root: string) {
	const handlers = new Map<string, (input: unknown) => unknown>();
	const workerDefs = new Map<string, any>();
	const started: any[] = [];
	const tools: any[] = [];
	const instructions: any[] = [];
	const events: any[] = [];
	const controller = new AbortController();
	const ctx = {
		dataDirectory: path.join(root, "data"),
		signal: controller.signal,
		cleanup() {},
		learning: {
			directory: path.join(root, "learning"),
			listSessions: () => [{ id: "c1", title: "Chain rule" }],
			getSession: (id: string) => (id === "c1" ? { id, title: "Chain rule", kind: "teach", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "Hello." }] }], tree: { nodes: [{ id: "n1", title: "N1" }], edges: [], version: 1 } } : null),
			graph: () => ({ propositions: [{ id: "p1", name: "P1", statement: "S1", provenance: [{ chatId: "c1" }] }], chains: [] }),
		},
		inference: { catalog: async () => ({ models: [{ provider: "x", id: "m", supportedLevels: ["off"] }], slots: { strong: { model: { provider: "x", id: "m" } } } }) },
		workers: {
			register(def: any) { workerDefs.set(def.id, def); return () => workerDefs.delete(def.id); },
			start(id: string, opts: any) { started.push({ id, opts }); return { id: `task_${started.length}`, status: "queued" }; },
			subscribe: () => () => undefined,
			wait: () => new Promise(() => undefined),
			get: () => { throw new Error("unknown"); },
			cancel() {},
		},
		agents: { register: () => () => undefined },
		registerInstructions(i: any) { instructions.push(i); return () => undefined; },
		registerTools(t: any) { tools.push(t); return () => undefined; },
		handle(name: string, h: any) { handlers.set(name, h); return () => handlers.delete(name); },
		events: { emit: (topic: string, data: unknown) => events.push({ topic, data }), on: () => () => undefined },
		markers: { append: async () => ({ messageId: "m", chatId: "c1" }) },
	} as unknown as PluginBackendContext;
	return { ctx, handlers, workerDefs, started, tools, instructions, events, call: (n: string, i: object = {}) => handlers.get(n)!(i) };
}

test("create starts a writer task with the frozen snapshot; the offer tool records its session", async () => {
	const root = tmp();
	try {
		const host = fixture(root);
		const dispose = activate(host.ctx);
		assert.equal(host.workerDefs.size, 10);
		assert.deepEqual(host.instructions[0].agents, ["teacher"]);
		const { id } = (await host.call("create", { kind: "recap", chatId: "c1", mode: "model" })) as { id: string };
		assert.equal(host.started[0].id, "writer-recap-model");
		assert.equal(host.started[0].opts.maxTurns, 3);
		assert.deepEqual(host.started[0].opts.model, { provider: "x", id: "m" });
		const r = (await host.call("get", { id })) as any;
		assert.equal(r.taskId, "task_1");
		assert.deepEqual(r.snapshot.propositions, [{ id: "p1", name: "P1", statement: "S1" }]);
		assert.deepEqual(r.practice.map((p: any) => p.id), ["p1"]);
		await assert.rejects(async () => host.call("create", { kind: "deep-dive", chatId: "c1", planNodeId: "zz" }), /Unknown plan node/);
		const [tool] = host.tools[0].create({ chatId: "c1", agent: "teacher" });
		await assert.rejects(tool.execute("call1", { kind: "deep-dive", planNodeId: "nope", title: "t", why: "w" }), /matches no node/);
		await tool.execute("call2", { kind: "deep-dive", planNodeId: "n1", title: "t", why: "w" });
		assert.deepEqual(await host.call("offer", { toolCallId: "call2" }), { chatId: "c1" });
		const accepted = (await host.call("accept-offer", { toolCallId: "call2", mode: "researched" })) as any;
		assert.equal(host.started[1].id, "writer-deep-dive-researched");
		assert.deepEqual(await host.call("offer", { toolCallId: "call2" }), { chatId: "c1", readingId: accepted.id });
		const def = host.workerDefs.get("writer-recap-model");
		assert.throws(() => def.validateResult({ title: "x", body: "short" }, { taskId: "task_1", input: { readingId: id } }), /too short/);
		dispose();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
