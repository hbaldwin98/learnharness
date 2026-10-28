"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { LocalDictationModelId, ResolvedDictationSettings } from "@/src/core";

/**
 * The window's view of the local engine (electron/dictation.cjs): model
 * downloads, the worker's load state, and a direct MessagePort per run.
 * Browser builds have no bridge — `available` stays false.
 */

export type LocalModelState = {
	state: "absent" | "partial" | "downloading" | "verifying" | "ready";
	received: number;
	total: number;
	error?: string | null;
};

export type LocalEngineState = {
	state: "none" | "loading" | "ready" | "idle" | "error";
	model: LocalDictationModelId | null;
	backend: string | null;
	device: string | null;
	error: string | null;
	/** The GPU was lost while loading; this session runs on the CPU. */
	gpuFallback: boolean;
};

export type LocalDictationSnapshot = {
	available: boolean;
	engine: LocalEngineState;
	models: Partial<Record<LocalDictationModelId, LocalModelState>>;
	vad: LocalModelState | null;
};

export type LocalDictationCommand =
	| { op: "status" }
	| { op: "configure"; config: { model: LocalDictationModelId; device: string; vad: boolean } | null }
	| { op: "download" | "cancel" | "delete"; id: LocalDictationModelId }
	| { op: "connect" };

export type LocalDictationBridge = {
	control: (command: LocalDictationCommand) => Promise<unknown>;
	onChange: (cb: (snapshot: LocalDictationSnapshot) => void) => () => void;
};

const UNAVAILABLE: LocalDictationSnapshot = {
	available: false,
	engine: { state: "none", model: null, backend: null, device: null, error: null, gpuFallback: false },
	models: {},
	vad: null,
};

const bridge = (): LocalDictationBridge | undefined =>
	typeof window === "undefined" ? undefined : window.lh?.dictation;

let snapshot = UNAVAILABLE;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

function publish(next: LocalDictationSnapshot) {
	snapshot = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	const b = bridge();
	if (b && !stop) {
		stop = b.onChange(publish);
		void b.control({ op: "status" }).then((s) => publish(s as LocalDictationSnapshot)).catch(() => {});
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) { stop?.(); stop = undefined; }
	};
}

export function useLocalDictation(): LocalDictationSnapshot {
	return useSyncExternalStore(subscribe, () => snapshot, () => UNAVAILABLE);
}

export function getLocalDictationSnapshot(): LocalDictationSnapshot { return snapshot; }

export async function refreshLocalDictation(): Promise<LocalDictationSnapshot> {
	const b = bridge();
	if (!b) return UNAVAILABLE;
	publish(await b.control({ op: "status" }) as LocalDictationSnapshot);
	return snapshot;
}

export function localDictationCommand(command: LocalDictationCommand): Promise<unknown> {
	const b = bridge();
	if (!b) return Promise.reject(new Error("Local dictation needs the desktop app"));
	return b.control(command).then((s) => {
		if (s && typeof s === "object" && "engine" in s) publish(s as LocalDictationSnapshot);
		return s;
	});
}

let configured: string | undefined;

/** Tell the worker what to preload — the model when Local is the engine,
 *  nothing otherwise (Deepgram users hold no model in memory). Deduped. */
export function configureLocalDictation(settings: ResolvedDictationSettings): void {
	const b = bridge();
	if (!b) return;
	const config = settings.engine === "local"
		? { model: settings.local.model, device: settings.local.device, vad: settings.local.vad }
		: null;
	const key = JSON.stringify(config);
	if (key === configured) return;
	configured = key;
	void b.control({ op: "configure", config }).then((s) => publish(s as LocalDictationSnapshot)).catch(() => { configured = undefined; });
}

/** Keep the worker's config in step with the dictation settings. */
export function useLocalDictationSync(settings: ResolvedDictationSettings | undefined): void {
	useEffect(() => { if (settings) configureLocalDictation(settings); }, [settings]);
}

/** A fresh direct port to the worker (one per run: the worker keeps the
 *  newest, so a restarted worker can never leave a dead port behind). */
export function openLocalDictationPort(timeoutMs = 5000): Promise<MessagePort> {
	const b = bridge();
	if (!b) return Promise.reject(new Error("Local dictation needs the desktop app"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { window.removeEventListener("message", onMessage); reject(new Error("The dictation engine is not responding")); }, timeoutMs);
		const onMessage = (event: MessageEvent) => {
			if (event.source !== window || event.data?.type !== "lh:dictation:port" || !event.ports[0]) return;
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			resolve(event.ports[0]);
		};
		window.addEventListener("message", onMessage);
		void b.control({ op: "connect" }).then((ok) => {
			if (ok) return;
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			reject(new Error("The dictation engine is starting — try again"));
		}, (e: unknown) => {
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			reject(e instanceof Error ? e : new Error(String(e)));
		});
	});
}
