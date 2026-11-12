import assert from "node:assert/strict";
import test from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { FIELD_ACCESSORIES } from "../components/plugin-fork-context.ts";
import { insertIntoField } from "../components/plugin-field-accessory.tsx";
import { createPluginLearnerField, fieldAccessoryApplies, preparePluginFieldAccessory, type PluginFieldAccessory } from "../src/core/plugin-fields.ts";
import type { PluginFrontendContext, PluginInfo } from "../src/core/index.ts";

const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "index.js" } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const accessory = (over: Partial<PluginFieldAccessory> = {}): PluginFieldAccessory => ({ id: "mermaid", label: "Insert diagram", icon: "<svg/>", run() {}, ...over });

test("field accessories validate, bind receivers and freeze field kinds", () => {
	assert.throws(() => preparePluginFieldAccessory(accessory({ id: "bad id" })), /route-safe/);
	assert.throws(() => preparePluginFieldAccessory(accessory({ label: " " })), /label/);
	assert.throws(() => preparePluginFieldAccessory(accessory({ icon: "" })), /icon/);
	assert.throws(() => preparePluginFieldAccessory(accessory({ fields: [] })), /fields/);
	assert.throws(() => preparePluginFieldAccessory(accessory({ fields: ["nope" as never] })), /fields/);
	assert.throws(() => preparePluginFieldAccessory(accessory({ fields: ["composer", "composer"] })), /fields/);
	const owner = { ...accessory({ fields: ["composer"] }), run() { assert.equal(this, owner); } };
	const prepared = preparePluginFieldAccessory(owner);
	void prepared.run({} as never);
	assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.fields));
	assert.equal(fieldAccessoryApplies(prepared, "composer"), true);
	assert.equal(fieldAccessoryApplies(prepared, "thinking"), false);
	assert.equal(fieldAccessoryApplies(accessory(), "practice-answer"), true);
});

test("learner field handles write through the binding and throw once stale", () => {
	let draft = "ab";
	const controller = new AbortController();
	const field = createPluginLearnerField({ kind: "thinking", sessionId: "s", read: () => draft, write: v => { draft = v; }, insert: v => { draft += v; } }, controller.signal);
	assert.equal(field.read(), "ab");
	field.write("x"); field.insert("y");
	assert.equal(draft, "xy");
	assert.throws(() => field.write(1 as never), TypeError);
	controller.abort();
	assert.throws(() => field.read(), /stale/);
	assert.throws(() => field.write("z"), /stale/);
	assert.throws(() => field.insert("z"), /stale/);
	assert.equal(draft, "xy");
});

test("insert falls back to append without a live editor", () => {
	let draft = "a";
	insertIntoField(null, "b", () => draft, v => { draft = v; });
	assert.equal(draft, "ab");
	const editor = { isConnected: true, dispatchEvent(event: CustomEvent<{ text: string; inserted?: boolean }>) { draft = `[${event.detail.text}]`; event.detail.inserted = true; return true; } };
	insertIntoField(editor as unknown as HTMLElement, "c", () => draft, v => { draft = v; });
	assert.equal(draft, "[c]");
});

test("registrations are per plugin, duplicate ids throw, and unregister/disable abort them", async () => {
	const contexts: PluginFrontendContext[] = [];
	const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(context) {
		contexts.push(context);
		context.registerFieldAccessory(accessory());
	} }; } });
	try {
		manager.reconcile([info("one"), info("two")]); await tick();
		const entries = manager.fork.list<PluginFieldAccessory>(FIELD_ACCESSORIES);
		assert.deepEqual(entries.map(entry => entry.key), ["one/mermaid", "two/mermaid"]);
		assert.throws(() => contexts[0]!.registerFieldAccessory(accessory()), /Duplicate/);
		const off = contexts[0]!.registerFieldAccessory(accessory({ id: "extra" }));
		const extra = manager.fork.get(FIELD_ACCESSORIES, "one/extra")!;
		off();
		assert.equal(extra.signal.aborted, true);
		assert.equal(manager.fork.get(FIELD_ACCESSORIES, "one/extra"), undefined);
		const first = entries[0]!;
		manager.reconcile([info("two")]);
		assert.equal(first.signal.aborted, true);
		assert.deepEqual(manager.fork.list(FIELD_ACCESSORIES).map(entry => entry.key), ["two/mermaid"]);
	} finally { await manager.dispose(); }
});
