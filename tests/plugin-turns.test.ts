import assert from "node:assert/strict";
import test from "node:test";
import { createPluginTurnService } from "../src/server/plugin-turns.ts";
import { learnerTriggeredSteers } from "../src/core/plugin-markers.ts";
import { nativeInputCause, toLlmMessages, type LhMarkerMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore } from "../src/core/ports.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
function fixture(over: { updatedAt?: string; messages?: LhMessage[]; running?: boolean; compacting?: boolean } = {}) {
	const delivered: LhMarkerMessage[] = [], discarded: string[] = [];
	let settle: (() => void) | undefined;
	const chatStore = { getChat: (id: string) => id === "c" ? { id, createdAt: "2026-11-12T10:00:00Z", updatedAt: over.updatedAt ?? "2026-11-12T11:50:00Z", messages: over.messages ?? [] } : null } as unknown as ChatStore;
	const controller = new AbortController();
	const service = createPluginTurnService("code", { chatStore, signal: controller.signal, now: () => NOW,
		deliver: steer => { delivered.push(steer); return new Promise<void>(resolve => { settle = resolve; }); },
		discard: (_chat, id) => { discarded.push(id); return true; },
		turnRunning: () => over.running ?? false, compacting: () => over.compacting ?? false });
	return { service, delivered, discarded, controller, settle: () => settle?.() };
}
const input = { displayText: "Ran tests", modelText: "3 failed", idempotencyKey: "k1", trigger: "background" as const };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("steer validates input and limits", async () => {
	const f = fixture();
	await assert.rejects(f.service.steer("c", { ...input, modelText: "x".repeat(8 * 1024 + 1) }), /8 KB/);
	await assert.rejects(f.service.steer("c", { ...input, trigger: "nope" as never }), /trigger/);
	await assert.rejects(f.service.steer("missing", input), /Unknown session/);
	await assert.rejects(fixture({ updatedAt: "2026-11-12T11:00:00Z" }).service.steer("c", input), /30 minutes/);
	await assert.rejects(fixture({ compacting: true }).service.steer("c", input), /compacting/);
	await assert.rejects(f.service.steer("c", { ...input, mode: "steer-only" }), /No live run/);
});

test("delivery classification, marker shape, dedupe and one in-flight steer", async () => {
	const f = fixture();
	assert.deepEqual(await f.service.steer("c", input), { delivery: "woke" });
	const marker = f.delivered[0]!;
	assert.equal(marker.customType, "plugin-marker");
	assert.equal(marker.content, "[plugin code] 3 failed");
	assert.deepEqual(marker.details, { pluginId: "code", typeId: "steer", data: null, idempotencyKey: "k1", displayText: "Ran tests", trigger: "background", chatId: "c" });
	assert.equal(nativeInputCause(marker as never, []), "automatic");
	assert.equal(learnerTriggeredSteers({ type: "steers", steers: [marker] }), false);
	assert.equal((toLlmMessages([marker] as never)[0] as { content: { text: string }[] }).content[0]!.text, "[plugin code] 3 failed");
	assert.deepEqual(await f.service.steer("c", input), { delivery: "queued" }); // same key: same delivery
	await assert.rejects(f.service.steer("c", { ...input, idempotencyKey: "k2" }), /still being delivered/);
	f.settle(); await flush();
	assert.deepEqual(await f.service.steer("c", { ...input, idempotencyKey: "k2", trigger: "learner" }), { delivery: "woke" });
	assert.equal(nativeInputCause(f.delivered[1] as never, []), "learner");
	assert.equal(learnerTriggeredSteers({ type: "steers", steers: [f.delivered[1]!] }), true);
	assert.deepEqual(await fixture({ running: true }).service.steer("c", { ...input, mode: "steer-only" }), { delivery: "steered" });
	const question = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "q", name: "quiz", arguments: {} }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage;
	assert.deepEqual(await fixture({ messages: [question] }).service.steer("c", input), { delivery: "queued" });
});

test("wake rate limit and disable drops queued steers", async () => {
	const f = fixture();
	for (let i = 0; i < 6; i++) { await f.service.steer("c", { ...input, idempotencyKey: `w${i}` }); f.settle(); await flush(); }
	await assert.rejects(f.service.steer("c", { ...input, idempotencyKey: "w6" }), /6 per hour/);
	const g = fixture();
	await g.service.steer("c", input);
	g.controller.abort();
	assert.deepEqual(g.discarded, [g.delivered[0]!.id]);
	await assert.rejects(g.service.steer("c", input), /activation/);
});
