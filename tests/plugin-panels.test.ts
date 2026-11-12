import assert from "node:assert/strict";
import test from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { SESSION_PANELS } from "../components/plugin-fork-context.ts";
import { pluginPanelStore, PluginPanelStore } from "../components/plugin-panel-store.ts";
import { placedPluginActions } from "../components/plugin-chrome.tsx";
import { clampPanelWidth, panelsForSession } from "../components/plugin-session-panel.tsx";
import { preparePluginSessionPanel, type PluginFrontendContext, type PluginInfo, type PluginSessionPanel } from "../src/core/index.ts";

const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "index.js" } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const panel = (over: Partial<PluginSessionPanel> = {}): PluginSessionPanel => ({ id: "reader", title: "Reader", mount() {}, ...over });

test("panel definitions validate and get host defaults", () => {
	assert.throws(() => preparePluginSessionPanel(panel({ id: "a b" })), /route-safe/);
	assert.throws(() => preparePluginSessionPanel(panel({ title: "" })), /title/);
	assert.throws(() => preparePluginSessionPanel(panel({ sessions: [] })), /targets/);
	assert.throws(() => preparePluginSessionPanel(panel({ minWidth: -1 })), /minWidth/);
	const prepared = preparePluginSessionPanel(panel({ defaultWidth: 100, minWidth: 300, sessions: ["practice"] }));
	assert.equal(prepared.defaultWidth, 300);
	assert.deepEqual(prepared.sessions, ["practice"]);
	assert.equal(preparePluginSessionPanel(panel()).defaultWidth, 360);
	assert.equal(clampPanelWidth(100, 240, 1000), 240);
	assert.equal(clampPanelWidth(900, 240, 1000), 700);
});

test("open and width state persist per session and panel, and survive storage failure", () => {
	const data = new Map<string, string>();
	const fake = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } } as unknown as Storage;
	const store = new PluginPanelStore(() => fake);
	let changes = 0; store.subscribe(() => changes++);
	store.setOpen("s1", "p/reader"); store.setWidth("s1", "p/reader", 420.4);
	const fresh = new PluginPanelStore(() => fake);
	assert.equal(fresh.openPanel("s1"), "p/reader");
	assert.equal(fresh.openPanel("s2"), null);
	assert.equal(fresh.width("s1", "p/reader", 360), 420);
	assert.equal(fresh.width("s2", "p/reader", 360), 360);
	store.setOpen("s1", null);
	assert.equal(new PluginPanelStore(() => fake).openPanel("s1"), null);
	assert.equal(changes, 3);
	const broken = new PluginPanelStore(() => { throw new Error("blocked"); });
	broken.setOpen("s", "p/x");
	assert.equal(broken.openPanel("s"), "p/x");
});

test("registration, session filtering, app open/close and top-bar opens targets", async () => {
	let ctx!: PluginFrontendContext;
	const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(context) {
		ctx = context;
		context.registerSessionPanel(panel());
		context.registerSessionPanel(panel({ id: "practice-only", sessions: ["practice"] }));
		context.registerAction({ id: "open", name: "Open", run() {} });
		context.placeAction({ id: "top", actionId: "open", location: "top-bar", sessions: ["teaching"], opens: "reader" });
	} }; } });
	try {
		manager.reconcile([info("one")]); await tick();
		assert.throws(() => ctx.registerSessionPanel(panel()), /Duplicate/);
		assert.throws(() => ctx.placeAction({ id: "bad", actionId: "open", location: "top-bar", sessions: ["teaching"], opens: "" }), /panel target/);
		const entries = manager.fork.list<Readonly<PluginSessionPanel>>(SESSION_PANELS);
		assert.deepEqual(panelsForSession(entries, "teaching").map(entry => entry.key), ["one/reader"]);
		assert.deepEqual(panelsForSession(entries, "practice").map(entry => entry.key), ["one/reader", "one/practice-only"]);
		ctx.app.openSessionPanel("chat-x", "reader");
		assert.equal(pluginPanelStore.openPanel("chat-x"), "one/reader");
		ctx.app.closeSessionPanel("chat-x");
		assert.equal(pluginPanelStore.openPanel("chat-x"), null);
		assert.throws(() => ctx.app.openSessionPanel("", "reader"), /session id/);
		const placed = placedPluginActions(manager.getSnapshot().plugins, { placement: "top-bar", surface: "session", sessionId: "s", kind: "teaching", surfaceTarget: {} as never, view: {} as never });
		assert.equal(placed[0]!.opens, "reader");
		const first = entries[0]!;
		manager.reconcile([]);
		assert.equal(first.signal.aborted, true);
		ctx.app.openSessionPanel("chat-y", "reader");
		assert.equal(pluginPanelStore.openPanel("chat-y"), null);
	} finally { await manager.dispose(); }
});
