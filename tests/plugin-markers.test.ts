import assert from "node:assert/strict";
import test from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { MARKER_RENDERERS } from "../components/plugin-fork-context.ts";
import { appendPluginMarker, applyParkedPluginMarkers } from "../src/server/plugin-markers.ts";
import { preparePluginMarker, PLUGIN_MARKER_DETAILS_LIMIT } from "../src/core/plugin-markers.ts";
import { nativeInputCause, needsContinuation, toLlmMessages, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { ChatStore } from "../src/core/ports.ts";
import type { PluginFrontendContext, PluginInfo } from "../src/core/index.ts";

const marker = (content: string, details: unknown = { pluginId: "p", typeId: "card", data: 1 }): LhMarkerMessage =>
	({ id: `pm-${content || "none"}`, role: "custom", customType: "plugin-marker", content, display: true, details, timestamp: 1 });

test("marker input validation, detachment and model framing", () => {
	assert.throws(() => preparePluginMarker("p", { typeId: "Bad", details: {} }), /typeId/);
	assert.throws(() => preparePluginMarker("p", { typeId: "card", details: undefined }), /JSON/);
	assert.throws(() => preparePluginMarker("p", { typeId: "card", details: "x".repeat(PLUGIN_MARKER_DETAILS_LIMIT) }), /64 KB/);
	assert.throws(() => preparePluginMarker("p", { typeId: "card", details: {}, modelText: " " }), /modelText/);
	assert.throws(() => preparePluginMarker("p", { typeId: "card", details: {}, idempotencyKey: "" }), /idempotencyKey/);
	const data = { nested: [1] };
	const prepared = preparePluginMarker("p", { typeId: "card", details: data, modelText: "Read it", idempotencyKey: "k" });
	data.nested.push(2);
	assert.deepEqual(prepared.details, { pluginId: "p", typeId: "card", data: { nested: [1] }, idempotencyKey: "k" });
	assert.equal(prepared.content, "[plugin p] Read it");
	assert.equal(preparePluginMarker("p", { typeId: "card", details: null }).content, "");
});

test("markers are model-visible only with modelText, neutral, tail-neutral and projected as data parts", () => {
	const user = { id: "u", role: "user", content: "hi", timestamp: 1 } as LhMessage;
	const llm = toLlmMessages([user, marker(""), marker("[plugin p] seen")] as never);
	assert.equal(llm.length, 2);
	assert.deepEqual((llm[1] as { content: { text: string }[] }).content[0]!.text, "[plugin p] seen");
	assert.equal(nativeInputCause(marker("") as never, []), "neutral");
	const call = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "c", name: "tool", arguments: {} }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage;
	const result = { id: "r", role: "toolResult", toolCallId: "c", toolName: "tool", content: [], isError: false, timestamp: 1 } as unknown as LhMessage;
	assert.equal(needsContinuation([user, call, result]), needsContinuation([user, call, result, marker("")]));
	const view = projectView([user, marker("")]);
	assert.deepEqual(view.at(-1), { id: "pm-none", role: "user", parts: [{ type: "data-plugin-marker", id: "pm_pm-none", data: { pluginId: "p", typeId: "card", data: 1 } }] });
});

function store(initial: LhMessage[]) {
	const chats = new Map<string, LhMessage[]>([["chat", initial]]);
	const fake = {
		getChat: (id: string) => chats.has(id) ? { id, title: "", createdAt: "", updatedAt: "", messages: chats.get(id)! } : null,
		saveMessages: (id: string, messages: LhMessage[]) => { chats.set(id, messages); },
	} as unknown as ChatStore;
	return { fake, messages: () => chats.get("chat")! };
}

test("idle append writes at once, dedupes by key, and an ended activation rejects", async () => {
	const { fake, messages } = store([]);
	const signal = new AbortController();
	const deps = { chatStore: fake, signal: signal.signal, turnRunning: () => false, compacting: () => false };
	const first = await appendPluginMarker("p", "chat", { typeId: "card", details: { a: 1 }, idempotencyKey: "k" }, deps);
	const again = await appendPluginMarker("p", "chat", { typeId: "card", details: { a: 2 }, idempotencyKey: "k" }, deps);
	const other = await appendPluginMarker("q", "chat", { typeId: "card", details: {}, idempotencyKey: "k" }, deps);
	assert.equal(first.messageId, again.messageId);
	assert.notEqual(first.messageId, other.messageId);
	assert.equal(messages().length, 2);
	await assert.rejects(appendPluginMarker("p", "missing", { typeId: "card", details: {} }, deps), /Unknown session/);
	signal.abort();
	await assert.rejects(appendPluginMarker("p", "chat", { typeId: "card", details: {} }, deps), /activation/);
});

test("busy append parks until the settle hook, after the turn's messages; compaction is waited out", async () => {
	const { fake, messages } = store([]);
	let busy = true, compacting = true;
	const deps = { chatStore: fake, signal: new AbortController().signal, turnRunning: () => busy, compacting: () => compacting, delay: async () => { compacting = false; } };
	const receipt = await appendPluginMarker("p", "chat", { typeId: "card", details: {}, idempotencyKey: "k" }, deps);
	assert.equal(messages().length, 0);
	assert.equal((await appendPluginMarker("p", "chat", { typeId: "card", details: {}, idempotencyKey: "k" }, deps)).messageId, receipt.messageId);
	fake.saveMessages("chat", [{ id: "turn", role: "user", content: "x", timestamp: 1 } as LhMessage]);
	busy = false;
	applyParkedPluginMarkers(fake, "chat");
	assert.deepEqual(messages().map(m => m.id), ["turn", receipt.messageId]);
	applyParkedPluginMarkers(fake, "chat");
	assert.equal(messages().length, 2);
});

test("marker renderers are plugin-scoped, validated and removed with activation", async () => {
	const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "index.js" } });
	let ctx!: PluginFrontendContext;
	const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(context) {
		ctx = context; context.registerMarkerRenderer({ typeId: "card", mount() {} });
	} }; } });
	try {
		manager.reconcile([info("one")]); await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(manager.fork.get(MARKER_RENDERERS, "one/card"));
		assert.throws(() => ctx.registerMarkerRenderer({ typeId: "card", mount() {} }), /Duplicate/);
		assert.throws(() => ctx.registerMarkerRenderer({ typeId: "Card", mount() {} }), /typeId/);
		manager.reconcile([]);
		assert.equal(manager.fork.get(MARKER_RENDERERS, "one/card"), undefined);
	} finally { await manager.dispose(); }
});
