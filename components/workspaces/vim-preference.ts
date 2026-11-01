"use client";

/**
 * Vim mode for the code editor (practice workspaces, plan step 3; owner
 * ruling 2026-11-01): ON by default, toggled from the workspace toolbar and
 * Settings → Keyboard, stored on this device (localStorage, like lh:keymap).
 * Both toggles share this one store; mounted editors follow live.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "lh:vim";
const listeners = new Set<() => void>();

export function vimEnabled(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setVimEnabled(on: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
	} catch {
		// storage unavailable: the toggle still applies to this page
	}
	for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

/** The live preference (SSR renders the default). */
export function useVimEnabled(): boolean {
	return useSyncExternalStore(subscribe, vimEnabled, () => true);
}
