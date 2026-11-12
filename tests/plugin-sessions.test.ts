import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { preparePluginSessionSpec } from "../src/core/plugin-sessions.ts";
import { learnerTriggeredSteers } from "../src/core/plugin-markers.ts";
import { nativeInputCause, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { finishPluginSession, PluginSessionError, preparePluginSessionRequest, pluginOpeningMarker } from "../src/server/plugin-sessions.ts";
import { createForkFrontendContext } from "../components/plugin-fork-context.ts";
import { PluginForkRegistry } from "../components/plugin-fork-registry.ts";
import type { ChatStore } from "../src/core/ports.ts";

test("session specs validate and detach", () => {
	assert.throws(() => preparePluginSessionSpec({ kind: "x" as never }), /kind/);
	assert.throws(() => preparePluginSessionSpec({ kind: "teaching", start: true }), /requires an opening/);
	assert.throws(() => preparePluginSessionSpec({ kind: "teaching", opening: { displayText: "", modelText: "m" } }), /opening/);
	assert.throws(() => preparePluginSessionSpec({ kind: "teaching", nodeIds: Array(65).fill("n") }), /nodeIds/);
	assert.deepEqual(preparePluginSessionSpec({ kind: "practice", nodeIds: ["a", "a", "b"] }), { kind: "practice", nodeIds: ["a", "b"] });
});

function fixture() {
	const chats = new Map<string, LhMessage[]>([["chat1", []]]);
	const chatStore = { getChat: (id: string) => chats.has(id) ? { id, title: "T", messages: chats.get(id)! } : null,
		saveMessages: (id: string, messages: LhMessage[]) => { chats.set(id, messages); } } as unknown as ChatStore;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sessions-"));
	const deps = { chatStore, graphStore: { readNodes: () => [{ id: "n1", name: "N1", statement: "S1" }] as never }, isPluginActive: (id: string) => id === "deep", keysFile: path.join(dir, "keys.json") };
	return { chats, deps, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("requests validate plugin, nodes and reuse permanent per-plugin idempotency keys", async () => {
	const f = fixture();
	try {
		await assert.rejects(preparePluginSessionRequest({ pluginId: "other", spec: { kind: "teaching" } }, f.deps), PluginSessionError);
		await assert.rejects(preparePluginSessionRequest({ pluginId: "deep", spec: { kind: "teaching", nodeIds: ["zz"] } }, f.deps), /Unknown graph nodes/);
		const request = await preparePluginSessionRequest({ pluginId: "deep", spec: { kind: "teaching", nodeIds: ["n1"], idempotencyKey: "k", opening: { displayText: "Dive", modelText: "Teach n1" } } }, f.deps);
		assert.deepEqual(request.graphContext, { propositions: [{ id: "n1", name: "N1", statement: "S1" }] });
		assert.equal(request.title, "Dive");
		await finishPluginSession("chat1", request, { ...f.deps, startTurn: async () => 200 });
		const again = await preparePluginSessionRequest({ pluginId: "deep", spec: { kind: "teaching", idempotencyKey: "k" } }, f.deps);
		assert.equal(again.existing, "chat1");
		assert.equal(f.chats.get("chat1")!.length, 1); // not started: opening appended directly
		f.chats.delete("chat1");
		assert.equal((await preparePluginSessionRequest({ pluginId: "deep", spec: { kind: "teaching", idempotencyKey: "k" } }, f.deps)).existing, undefined);
	} finally { f.dispose(); }
});

test("start runs the opening as a learner-triggered turn input; a refused start still records it", async () => {
	const f = fixture();
	try {
		const spec = preparePluginSessionSpec({ kind: "teaching", start: true, opening: { displayText: "Shown", modelText: "Hidden" } });
		const started: LhMessage[] = [];
		await finishPluginSession("chat1", { pluginId: "deep", spec, title: "t" }, { ...f.deps, startTurn: async (_id, opening) => { started.push(opening); return 200; } });
		assert.equal(started.length, 1);
		assert.equal(f.chats.get("chat1")!.length, 0);
		assert.equal(learnerTriggeredSteers({ type: "steers", steers: started }), true);
		assert.equal(nativeInputCause(started[0] as never, []), "learner");
		assert.equal((toLlmMessages(started as never)[0] as { content: { text: string }[] }).content[0]!.text, "[plugin deep] Hidden");
		await finishPluginSession("chat1", { pluginId: "deep", spec, title: "t" }, { ...f.deps, startTurn: async () => 503 });
		assert.equal(((f.chats.get("chat1")![0] as unknown as { details: { displayText: string } }).details).displayText, "Shown");
		assert.equal(pluginOpeningMarker("deep", preparePluginSessionSpec({ kind: "teaching" })), undefined);
	} finally { f.dispose(); }
});

test("app.createSession posts the plugin spec and optionally opens the session", async () => {
	const calls: unknown[] = [], navigations: string[] = [];
	const context = createForkFrontendContext(new PluginForkRegistry(), { pluginId: "deep", pluginName: "Deep", signal: new AbortController().signal, isCurrent: () => true,
		addCleanup: () => () => {}, report() {}, navigate: p => navigations.push(p),
		fetch: (async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Response.json({ id: "new1" }); }) as typeof fetch });
	assert.equal(await context.app.createSession({ kind: "practice" }, { open: true }), "new1");
	assert.deepEqual(calls, [{ plugin: { pluginId: "deep", spec: { kind: "practice" } } }]);
	assert.deepEqual(navigations, ["/chat/new1"]);
	await assert.rejects(context.app.createSession({ kind: "nope" as never }), /kind/);
});
