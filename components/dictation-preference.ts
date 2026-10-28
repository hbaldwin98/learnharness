"use client";

import { useSyncExternalStore } from "react";
import {
	resolveDictationSettings, sanitizeUserSettings,
	type DictationLanguage, type DictationSettings, type ResolvedDictationSettings, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

type Snapshot = {
	/** The record's own (delta) section — what a write starts from. */
	section: DictationSettings | undefined;
	/** The section with factory defaults filled in. */
	settings: ResolvedDictationSettings | undefined;
	saving: boolean;
	error: string | null;
};
const INITIAL: Snapshot = { section: undefined, settings: undefined, saving: false, error: null };

/** One confirmed dictation section and one write in flight, shared by every
 * surface. The PUT replaces the section whole, so every write sends the
 * complete delta (a language-only body would erase the engine choice).
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationSettingsStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<ResolvedDictationSettings> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<Snapshot>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};
	const confirm = (section: DictationSettings) =>
		publish({ section, settings: resolveDictationSettings(section), error: null });

	function load(refresh = false): Promise<ResolvedDictationSettings> {
		if (writing) return get();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.settings !== undefined) return Promise.resolve(snapshot.settings);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return get();
				needsRead = false;
				confirm(record?.dictation ?? {});
				return snapshot.settings!;
			} catch {
				if (version !== revision) return get();
				const message = "Could not load dictation settings. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	/** Write the section `edit` derives from the confirmed one. */
	function save(edit: (section: DictationSettings) => DictationSettings, failure = "Could not save dictation settings. Try again."): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.section === undefined) return Promise.resolve(false);
		const body = edit(snapshot.section);
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) throw new Error();
				const out = await res.json() as { settings: UserSettings };
				const record = sanitizeUserSettings(out.settings);
				if (!record) throw new Error();
				needsRead = false;
				confirm(record.dictation ?? {});
				saved();
				return true;
			} catch {
				publish({ error: failure });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	async function get(): Promise<ResolvedDictationSettings> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.settings === undefined) await load();
			else return snapshot.settings;
		}
	}

	return {
		load, save, get,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

/** The Deepgram-language view of the section store (the language picker's
 *  original contract, kept so its surfaces and pins stay unchanged). */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	return languageView(createDictationSettingsStore(request, saved));
}

type SettingsStore = ReturnType<typeof createDictationSettingsStore>;
const LANGUAGE_INITIAL = { language: undefined as DictationLanguage | undefined, saving: false, error: null as string | null };

function languageView(store: SettingsStore) {
	let from: Snapshot | undefined;
	let view = LANGUAGE_INITIAL;
	const getSnapshot = () => {
		const s = store.getSnapshot();
		if (s !== from) {
			from = s;
			view = { language: s.settings?.language, saving: s.saving, error: s.error && s.error.replace("settings", "language") };
		}
		return view;
	};
	return {
		load: (refresh?: boolean) => store.load(refresh).then((s) => s.language),
		save: (language: DictationLanguage) =>
			store.save((section) => ({ ...section, language }), "Could not save dictation language. Try again."),
		getLanguage: () => store.get().then((s) => s.language),
		getSnapshot,
		getServerSnapshot: () => LANGUAGE_INITIAL,
		subscribe: store.subscribe,
	};
}

let announcingSave = false;
const store = createDictationSettingsStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
const languageStore = languageView(store);
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.get().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationSettings() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, get: store.get };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, languageStore.getSnapshot, languageStore.getServerSnapshot);
	return { ...snapshot, load: languageStore.load, save: languageStore.save, getLanguage: languageStore.getLanguage };
}
