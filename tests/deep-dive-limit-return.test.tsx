/**
 * Deep dive's over-limit confirm and the pick-mode way back
 * (docs/readings.md §6.1): a request over MAX_NODE_PICKS asks first and
 * then covers the first MAX_NODE_PICKS in the order given; pick mode
 * deep-dives the ticked propositions in tick order; the interrupted
 * draft (picks, text, mode) is saved and restored exactly once.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableBody, deepDiveScope } from "../components/chain-table.tsx";
import { DeepDiveLimitBody } from "../components/deep-dive-limit-dialog.tsx";
import { HOME_RETURN_KEY, newSessionReturnKey, saveDeepDiveReturn, takeDeepDiveReturn } from "../components/deep-dive-return.ts";
import { MAX_NODE_PICKS, type GraphNode } from "../src/core/index.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n_${i}`);

describe("deepDiveScope", () => {
	it("passes a selection at the limit through without a confirm", () => {
		assert.deepEqual(deepDiveScope(ids(MAX_NODE_PICKS)), { nodeIds: ids(MAX_NODE_PICKS), overLimit: false });
	});

	it("over the limit asks first and keeps the first MAX_NODE_PICKS in order", () => {
		const scope = deepDiveScope(ids(MAX_NODE_PICKS + 10));
		assert.equal(scope.overLimit, true);
		assert.deepEqual(scope.nodeIds, ids(MAX_NODE_PICKS));
	});
});

describe("the over-limit confirm", () => {
	it("states how many of the selection will be covered", () => {
		const html = renderToStaticMarkup(<DeepDiveLimitBody total={210} onCancel={() => {}} onConfirm={() => {}} />);
		assert.match(html, new RegExp(`Only ${MAX_NODE_PICKS} of 210 selected propositions will be included`));
		assert.match(html, /data-testid="deep-dive-limit-cancel"/);
		assert.match(html, /Deep dive anyway/);
	});
});

describe("pick-mode Deep dive", () => {
	const dom = parseHTML("<html><body></body></html>");
	let root: Root | undefined, host: HTMLElement | undefined;
	beforeEach(() => {
		Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	});
	afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });

	it("sends the ticked propositions in tick order", async () => {
		const node = (id: string): GraphNode => ({ id, name: id, statement: id, aliases: [], createdAt: "2026-10-30", provenance: [{ chatId: "c1", messageId: "m" }] });
		const sent: string[][] = [];
		host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
		await act(async () => {
			root!.render(<ChainTableBody nodes={[node("a"), node("b"), node("c")]} chains={[]} sessions={{}} fileSources={{}}
				query="" onQuery={() => {}} sort={{ col: "name", dir: 1 }} onSort={() => {}} selection={new Set(["c", "a"])}
				expandedClusters={new Set()} expandedChains={new Set()} onToggleCluster={() => {}} onToggleChain={() => {}}
				onToggleNodes={() => {}} onClear={() => {}} onDelete={() => {}} onClose={() => {}}
				selectMode onSelect={() => {}} onDeepDive={(nodeIds) => sent.push(nodeIds)} keyboardActive={false} />);
		});
		const button = host.querySelector('[data-testid="chain-deep-dive"]') as HTMLElement | null;
		assert.ok(button);
		await act(async () => { button.click(); });
		assert.deepEqual(sent, [["c", "a"]]);
	});
});

describe("the pick-mode way back", () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = new Map();
		Object.assign(globalThis, { sessionStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => { store.set(k, v); },
			removeItem: (k: string) => { store.delete(k); },
		} });
	});

	const picks = [{ id: "n1", name: "Chain rule", statement: "d/dx f(g(x))" }];

	it("restores the home draft once", () => {
		saveDeepDiveReturn(HOME_RETURN_KEY, { text: "practice derivatives", picks, mode: "practice" });
		assert.deepEqual(takeDeepDiveReturn(HOME_RETURN_KEY), { text: "practice derivatives", picks, mode: "practice" });
		assert.equal(takeDeepDiveReturn(HOME_RETURN_KEY), null);
	});

	it("keeps each new-session mode's draft apart", () => {
		saveDeepDiveReturn(newSessionReturnKey("practice"), { text: "p", picks });
		assert.equal(takeDeepDiveReturn(newSessionReturnKey("teach")), null);
		assert.deepEqual(takeDeepDiveReturn(newSessionReturnKey("practice")), { text: "p", picks });
	});

	it("drops a malformed draft instead of restoring it", () => {
		store.set(HOME_RETURN_KEY, JSON.stringify({ text: "x", picks: [{ id: 1 }] }));
		assert.equal(takeDeepDiveReturn(HOME_RETURN_KEY), null);
		assert.equal(store.has(HOME_RETURN_KEY), false);
	});

	it("survives unavailable storage", () => {
		Object.assign(globalThis, { sessionStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } });
		assert.doesNotThrow(() => saveDeepDiveReturn(HOME_RETURN_KEY, { text: "x", picks: [] }));
		assert.equal(takeDeepDiveReturn(HOME_RETURN_KEY), null);
	});
});
