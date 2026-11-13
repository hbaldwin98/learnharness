import assert from "node:assert/strict";
import { test } from "node:test";
import { createForkFrontendContext, type ForkViewHistory } from "../components/plugin-fork-context.ts";
import { PluginForkRegistry } from "../components/plugin-fork-registry.ts";
import { pluginPanelStore } from "../components/plugin-panel-store.ts";
import { preparePluginViewState, pluginViewStateQuery } from "../src/core/index.ts";

function fixture(path = "/plugins/deep/reader", search = "") {
	const url = { path, search }; const writes: [string, boolean][] = []; const navigations: string[] = [];
	const pops = new Set<() => void>(); const cleanups: (() => void)[] = []; const errors: unknown[] = [];
	let current = true;
	const history: ForkViewHistory = {
		pathname: () => url.path, search: () => url.search,
		write: (next, replace) => { writes.push([next, replace]); const [p, q = ""] = next.split("?"); url.path = p!; url.search = q ? `?${q}` : ""; },
		onPop: listener => { pops.add(listener); return () => { pops.delete(listener); }; },
	};
	const context = createForkFrontendContext(new PluginForkRegistry(), { pluginId: "deep", pluginName: "Deep", signal: new AbortController().signal,
		isCurrent: () => current, addCleanup: cleanup => { const run = () => { void cleanup(); }; cleanups.push(run); return run; },
		report: error => errors.push(error), navigate: p => navigations.push(p) }, pluginPanelStore, history);
	const pop = (next: string, q = "") => { url.path = next; url.search = q; for (const listener of [...pops]) listener(); };
	return { context, url, writes, navigations, pops, cleanups, errors, pop, expire: () => { current = false; } };
}

test("viewState.get reads the open view's query and nothing elsewhere", () => {
	assert.deepEqual(fixture("/plugins/deep/reader", "?reading=r1&page=2").context.app.viewState.get(), { reading: "r1", page: "2" });
	assert.deepEqual(fixture("/plugins/other/reader", "?reading=r1").context.app.viewState.get(), {});
	assert.deepEqual(fixture("/chat/c1", "?reading=r1").context.app.viewState.get(), {});
});

test("viewState.set pushes or replaces the query only on this plugin's view", () => {
	const f = fixture();
	f.context.app.viewState.set({ reading: "a b" });
	f.context.app.viewState.set({}, { replace: true });
	assert.deepEqual(f.writes, [["/plugins/deep/reader?reading=a+b", false], ["/plugins/deep/reader", true]]);
	const elsewhere = fixture("/chat/c1"); elsewhere.context.app.viewState.set({ reading: "x" });
	assert.deepEqual(elsewhere.writes, []);
	assert.throws(() => f.context.app.viewState.set({ reading: 1 } as never), /strings/);
	f.expire(); f.context.app.viewState.set({ reading: "late" }); assert.equal(f.writes.length, 2);
});

test("viewState.open navigates to this plugin's view with state", () => {
	const f = fixture("/");
	f.context.app.viewState.open("reader", { reading: "r1" });
	f.context.app.viewState.open("list");
	assert.deepEqual(f.navigations, ["/plugins/deep/reader?reading=r1", "/plugins/deep/list"]);
	assert.throws(() => f.context.app.viewState.open(""), /view id/);
});

test("viewState.onChange fires on Back/Forward within this plugin's views and is scoped", () => {
	const f = fixture(); const seen: unknown[] = [];
	const stop = f.context.app.viewState.onChange(state => seen.push(state));
	f.pop("/plugins/deep/reader", "?reading=r0");
	f.pop("/chat/c1");
	f.context.app.viewState.onChange(() => { throw new Error("boom"); });
	f.pop("/plugins/deep/reader");
	assert.deepEqual(seen, [{ reading: "r0" }, {}]);
	assert.equal(f.errors.length, 1);
	stop(); assert.equal(f.pops.size, 1);
	for (const cleanup of f.cleanups) cleanup();
	assert.equal(f.pops.size, 0);
});

test("view state helpers validate and encode", () => {
	assert.deepEqual(preparePluginViewState({ a: "1" }), { a: "1" });
	assert.throws(() => preparePluginViewState(["a"]));
	assert.equal(pluginViewStateQuery({}), "");
	assert.equal(pluginViewStateQuery({ id: "x&y" }), "?id=x%26y");
});
