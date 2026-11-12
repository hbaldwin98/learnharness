"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Fork: the Home / new-session draft survives navigation. The draft
 * (picks, typed text, Teach/Practice mode) is mirrored to sessionStorage
 * on every change and restored when its screen mounts again, whatever
 * navigation took the learner away. A successful start clears it; an
 * empty draft removes the entry. Storage is best-effort: when it is
 * unavailable the draft is simply not kept.
 */

export type DraftPick = { id: string; name: string; statement: string };
export type SavedDraft = { text: string; picks: DraftPick[]; mode?: "teach" | "practice" };

export const HOME_DRAFT_KEY = "lh:draft:home";
export const newSessionDraftKey = (mode: "teach" | "practice") => `lh:draft:new-session:${mode}`;

export function isEmptyDraft(draft: SavedDraft): boolean {
	return draft.text.trim() === "" && draft.picks.length === 0;
}

export function saveDraft(key: string, draft: SavedDraft): void {
	try {
		if (isEmptyDraft(draft)) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, JSON.stringify(draft));
	} catch {
		// Best-effort: no storage, no restore.
	}
}

export function clearDraft(key: string): void {
	try {
		sessionStorage.removeItem(key);
	} catch {
		// Best-effort.
	}
}

/** Reads the saved draft; null when absent or malformed. */
export function loadDraft(key: string): SavedDraft | null {
	let raw: string | null;
	try {
		raw = sessionStorage.getItem(key);
	} catch {
		return null;
	}
	if (raw === null) return null;
	try {
		return parseDraft(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function parseDraft(value: unknown): SavedDraft | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.text !== "string" || !Array.isArray(v.picks)) return null;
	const picks: DraftPick[] = [];
	for (const p of v.picks) {
		if (typeof p !== "object" || p === null) return null;
		const { id, name, statement } = p as Record<string, unknown>;
		if (typeof id !== "string" || typeof name !== "string" || typeof statement !== "string") return null;
		picks.push({ id, name, statement });
	}
	const mode = v.mode === "teach" || v.mode === "practice" ? v.mode : undefined;
	return { text: v.text, picks, ...(mode ? { mode } : {}) };
}

/**
 * Restores the draft under `key` once on mount (via `restore`), then
 * saves `draft` whenever it changes. Returns `clear` for a successful
 * start. Changing `key` restores the draft saved under the new key.
 */
export function useDraftPersistence(key: string, draft: SavedDraft, restore: (saved: SavedDraft) => void): { clear: () => void } {
	const restoredKey = useRef<string | null>(null);
	const restoreRef = useRef(restore);
	useEffect(() => {
		restoreRef.current = restore;
	});
	useEffect(() => {
		if (restoredKey.current === key) return;
		restoredKey.current = key;
		const saved = loadDraft(key);
		if (saved) restoreRef.current(saved);
	}, [key]);
	const serialized = JSON.stringify(draft);
	useEffect(() => {
		// Skip the pre-restore render so the empty initial state never
		// overwrites what is about to be restored.
		if (restoredKey.current !== key) return;
		const parsed = parseDraft(JSON.parse(serialized));
		if (parsed) saveDraft(key, parsed);
	}, [key, serialized]);
	const clear = useCallback(() => clearDraft(key), [key]);
	return { clear };
}
