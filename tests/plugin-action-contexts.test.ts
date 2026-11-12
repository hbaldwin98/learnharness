import assert from "node:assert/strict";
import test from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { placedPluginActions } from "../components/plugin-chrome.tsx";
import { pluginSelectionActions, transcriptSelectionContext } from "../components/plugin-selection-popover.tsx";
import type { CapturedSelection } from "../components/selection-text.ts";
import { PLUGIN_SELECTION_TEXT_LIMIT, type PluginActionContext, type PluginFrontendContext, type PluginInfo } from "../src/core/index.ts";

const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "index.js" } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const capture = (text: string) => ({ messageId: "m1", range: {} as Range, selector: { text, start: 0, end: text.length, prefix: "", suffix: "" } }) as CapturedSelection;
const probe: PluginActionContext = { placement: "transcript-selection", surface: "transcript", sessionId: "s", kind: "teaching", selection: { text: "", messageId: "" } };

test("transcript-selection placements are accepted, filtered by location and run with the captured selection", async () => {
	const runs: PluginActionContext[] = [];
	let ctx!: PluginFrontendContext;
	const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(context) {
		ctx = context;
		context.registerAction({ id: "explain", name: "Explain", run(context) { runs.push(context); }, disabled: context => context.placement === "transcript-selection" && context.selection.text === "skip" });
		context.placeAction({ id: "sel", actionId: "explain", location: "transcript-selection" });
		context.placeAction({ id: "side", actionId: "explain", location: "sidebar" });
	} }; } });
	try {
		manager.reconcile([info("one")]); await tick();
		assert.throws(() => ctx.placeAction({ id: "bad", actionId: "explain", location: "nowhere" as never }), /Unknown plugin action placement/);
		const placed = placedPluginActions(manager.getSnapshot().plugins, probe);
		assert.deepEqual(placed.map(item => item.key), ["one/sel"]);
		const actions = pluginSelectionActions(placed, "s", "practice", (item, context) => { void manager.runAction(item.pluginId, item.action, context); });
		const action = actions[0]!;
		assert.equal(action.visible(capture("skip")), false);
		assert.equal(action.visible(capture("ok")), true);
		assert.equal(action.disabledLabel!(capture("x".repeat(PLUGIN_SELECTION_TEXT_LIMIT))), null);
		assert.equal(action.disabledLabel!(capture("é".repeat(PLUGIN_SELECTION_TEXT_LIMIT / 2 + 1))), "Shorten selection");
		assert.equal(action.onSelect(capture("the quote")), true);
		await tick();
		assert.deepEqual(runs, [{ placement: "transcript-selection", surface: "transcript", sessionId: "s", kind: "practice", selection: { text: "the quote", messageId: "m1" } }]);
		assert.ok(Object.isFrozen(transcriptSelectionContext("s", "teaching", capture("a")).selection));
	} finally { await manager.dispose(); }
});
