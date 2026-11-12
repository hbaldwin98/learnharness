/**
 * Fork: the Home / new-session draft survives navigation
 * (components/draft-persistence.ts).
 */
import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	HOME_DRAFT_KEY,
	clearDraft,
	loadDraft,
	newSessionDraftKey,
	saveDraft,
	useDraftPersistence,
	type SavedDraft,
} from "../components/draft-persistence.ts";

class MemoryStorage {
	private map = new Map<string, string>();
	getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
	setItem(k: string, v: string) { this.map.set(k, String(v)); }
	removeItem(k: string) { this.map.delete(k); }
	clear() { this.map.clear(); }
}

const pick = { id: "n1", name: "Prop", statement: "A statement" };

describe("draft storage", () => {
	beforeEach(() => { Object.assign(globalThis, { sessionStorage: new MemoryStorage() }); });

	it("round-trips text, picks and mode", () => {
		saveDraft(HOME_DRAFT_KEY, { text: "hello", picks: [pick], mode: "practice" });
		assert.deepEqual(loadDraft(HOME_DRAFT_KEY), { text: "hello", picks: [pick], mode: "practice" });
	});

	it("an empty draft removes the entry; clear removes it", () => {
		saveDraft(HOME_DRAFT_KEY, { text: "x", picks: [] });
		saveDraft(HOME_DRAFT_KEY, { text: "  ", picks: [] });
		assert.equal(loadDraft(HOME_DRAFT_KEY), null);
		saveDraft(newSessionDraftKey("teach"), { text: "x", picks: [] });
		clearDraft(newSessionDraftKey("teach"));
		assert.equal(loadDraft(newSessionDraftKey("teach")), null);
	});

	it("malformed entries read as null", () => {
		sessionStorage.setItem(HOME_DRAFT_KEY, "{not json");
		assert.equal(loadDraft(HOME_DRAFT_KEY), null);
		sessionStorage.setItem(HOME_DRAFT_KEY, JSON.stringify({ text: "x", picks: [{ id: 1 }] }));
		assert.equal(loadDraft(HOME_DRAFT_KEY), null);
	});

	it("teach and practice new-session drafts are kept apart", () => {
		assert.notEqual(newSessionDraftKey("teach"), newSessionDraftKey("practice"));
	});
});

describe("useDraftPersistence", () => {
	const dom = parseHTML("<html><body></body></html>");
	let root: Root | undefined;
	let setText: ((t: string) => void) | undefined;
	let shown: SavedDraft | undefined;
	beforeEach(() => {
		Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, sessionStorage: new MemoryStorage() });
	});
	afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; });

	function Screen() {
		const [text, set] = useState("");
		const [picks, setPicks] = useState<SavedDraft["picks"]>([]);
		setText = set;
		useDraftPersistence(HOME_DRAFT_KEY, { text, picks }, (saved) => { set(saved.text); setPicks(saved.picks); });
		shown = { text, picks };
		return null;
	}

	const mount = async () => {
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		root = createRoot(host as unknown as HTMLElement);
		await act(async () => { root!.render(<Screen />); });
	};

	it("saves while typing and restores on the next mount, whatever the navigation", async () => {
		await mount();
		await act(async () => { setText!("draft topic"); });
		await act(async () => { root!.unmount(); });
		root = undefined;
		await mount();
		assert.equal(shown?.text, "draft topic");
		assert.deepEqual(loadDraft(HOME_DRAFT_KEY), { text: "draft topic", picks: [] });
	});

	it("restores a saved draft with picks", async () => {
		saveDraft(HOME_DRAFT_KEY, { text: "t", picks: [pick] });
		await mount();
		assert.deepEqual(shown, { text: "t", picks: [pick] });
	});
});
