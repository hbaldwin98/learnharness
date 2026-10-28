"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import {
	cleanDictation, deepgramListenUrl, localDictationModel, resolveLocalLanguage,
	type DictationLanguage, type ResolvedDictationSettings,
} from "@/src/core";
import { useDictationSettings } from "@/components/dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
import { DictationSpans, type DictationTarget } from "@/components/dictation-spans";
import {
	openLocalDictationPort, refreshLocalDictation, useLocalDictationSync,
} from "@/components/local-dictation";
export { isDictationActive } from "@/components/dictation-state";
export type { DictationTarget } from "@/components/dictation-spans";

/**
 * Voice dictation — two engines behind one run (engines wave, 2026-10-27).
 *
 *   local     transcribe.cpp (the library Handy runs) in an Electron utility
 *             process (electron/dictation-worker.mjs). The window gets a
 *             direct MessagePort per run; frames go window → worker.
 *   deepgram  the cloud engine (STT wave 1, 2026-09-17): a streaming
 *             WebSocket opened DIRECTLY with a short-lived token minted by
 *             /api/stt/token (the real key stays server-side).
 *
 * Both share the capture: an AudioWorklet (public/worklets/pcm-capture.js →
 * linear16 16kHz mono, 128ms frames) and the meter.
 *
 * LIVE TEXT (owner, 2026-10-27 — supersedes round 2's deferred flush):
 * committed text lands in the primary input AS IT STREAMS; the volatile
 * guess (local tentative / Deepgram interim) shows greyed in the strip
 * beside the meter. The run's text is cleaned live — Handy's filler-word
 * removal (src/core/dictation-text.ts) — and at the end swapped for the
 * cleaned FULL transcript (Handy finalizes from `full`, not `committed`).
 * Esc removes this run's text (components/dictation-spans.ts).
 *
 * Ported patterns from the owner's pi `dictate` extension (his words:
 * "very well tuned") — see ~/.pi/agent/extensions/dictate:
 *   - generation counter: every start/stop increments it; all async
 *     handlers no-op when stale, so a dying session can never tear down
 *     the current one.
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value (60ms tick samples the ref); dB floor −50 / ceiling −10.
 *   - stop: mic dies FIRST (no more audio enqueues), then the engine's
 *     flush, then a safety net in case it never answers.
 *
 * Owner round 1 (2026-09-17): ONE primary transcription input at all
 * times — the pending quiz/ask question's field while one waits, else the
 * page's composer (the module-level registry below). Click → meter
 * IMMEDIATELY (optimistic); connection + TCC run behind it.
 *
 * Start-latency mitigations (owner, 2026-09-27), kept for both engines:
 * QUEUE-DON'T-DROP (frames before the engine is open buffer, capped, and
 * flush in order), PARALLEL HANDSHAKE (mic-gated, never token-gated),
 * PERSISTENT GRAPH (one app-lifetime AudioContext + memoized worklet), and
 * for Deepgram a WARM TOKEN pre-minted at mount and after every run.
 */

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;
/** ≈32s of 128ms frames held while an engine opens. */
const PENDING_FRAMES_CAP = 256;
/** Deepgram's CloseStream backstop (dictate pattern). */
const DEEPGRAM_STOP_SAFETY_MS = 3000;
/** The local finalize can fall back to a batch pass over the whole run. */
const LOCAL_STOP_SAFETY_MS = 30_000;

/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored KEYLESS line (zero-keys wave, owner 2026-09-25):
 * the token route's raw 503 message is dev-speak — the surface says the
 * short truth instead; the errored idle button deep-links Settings → Keys →
 * the Deepgram row. */
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";
/** The local twin: no downloaded model yet (Local is the default engine). */
export const DICTATION_NO_LOCAL_MODEL = "Dictation needs a local model";
export const DICTATION_DESKTOP_ONLY = "Local dictation needs the desktop app";
/** Where the errored button leads: the dictation group in Settings. */
export const DICTATION_SETTINGS_ROW = "dictation";

/** Mint a fresh short-lived token (the route holds the real key
 *  server-side). The keyless 503 is the route's ONLY 503. */
async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest. */
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph (mitigation C, owner 2026-09-27): one
 * app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's own target (the composer) is the
 * fallback when nobody claims. Module-level by design: one window, one
 * pending question, one target at a time.
 */
let claimedTarget: DictationTarget | null = null;
let composerTarget: DictationTarget | null = null;

/** File references use the very same default destination as dictation,
 * including claims whose dock is currently collapsed. A focused editor can
 * insert at its caret instead; callers use this only as the fallback. */
export function appendToPrimaryInput(text: string): boolean {
	const target = claimedTarget ?? composerTarget;
	if (!target) return false;
	target.write(joinDictation(target.read(), text));
	return true;
}

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Empty
 * registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join dictated text onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * claim is a stable wrapper over the latest read/write, so a field switch
 * (text answer ↔ thinking) is honored without re-claiming; the unmount
 * guard is identity-based so dev-mode double-invoked effects can't clear
 * another claimant.
 */
export function useDictationTarget(target: DictationTarget, claimed: boolean) {
	const ref = useRef(target);
	ref.current = target;
	useEffect(() => {
		if (!claimed) return;
		const entry: DictationTarget = { read: () => ref.current.read(), write: (v) => ref.current.write(v) };
		claimedTarget = entry;
		return () => {
			if (claimedTarget === entry) claimedTarget = null;
		};
	}, [claimed]);
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** The current volatile guess (cleaned), sampled by the strip's tick. */
	tentativeRef: { current: string };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** Start, or end + KEEP the text (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost"): if a
	 *  run is live, stop it and resolve only when its final text is in the
	 *  target field. Idle → resolves immediately. Cancel resolves too. */
	finish: () => Promise<void>;
	/** End + DISCARD: this run's text comes back out of the field (Esc). */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave). */
	clearError: () => void;
};

/** One run's text state — the engine reports raw text, the run renders it. */
type Run = {
	settings: ResolvedDictationSettings;
	/** Evidence for the OUTPUT language (Handy's gate for the gated fillers). */
	language: string | null;
	committed: string;
	tentative: string;
	spans: DictationSpans;
};

/** Deepgram's finals end on word boundaries; local commits can end mid-word. */
const completeWords = (run: Run) => run.settings.engine === "deepgram";

/** An open engine: frames in, flush/close out. */
type Engine = {
	send: (frame: ArrayBuffer) => void;
	stop: () => void;
	close: () => void;
};

/** What the run's output language is KNOWN to be (null = unknown). */
function outputLanguage(settings: ResolvedDictationSettings): string | null {
	if (settings.engine === "deepgram") return settings.language === "multi" ? null : settings.language;
	const model = localDictationModel(settings.local.model);
	if (model.fixedLanguage) return model.fixedLanguage;
	const language = resolveLocalLanguage(model, settings.local.language);
	return language && language !== "auto" ? language : null;
}

/**
 * One dictation instance per composer-bearing page. `target` is the
 * page's composer; the mounted question form's claim wins while a
 * question waits.
 */
export function useDictation({ target }: { target: DictationTarget }): Dictation {
	const { settings: resolved, get: getSettings } = useDictationSettings();
	useLocalDictationSync(resolved);
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	/** Latest RMS from the worklet — the meter samples this (dictate pattern). */
	const levelRef = useRef(0);
	const tentativeRef = useRef("");
	/** The page's own target — kept fresh per render so a mid-run retarget
	 *  (composer↔question) is honored on the very next update. */
	const targetRef = useRef(target);
	targetRef.current = target;
	/** Stable identity: a run's segments are keyed by target, and callers
	 *  pass a fresh {read, write} literal every render. */
	const [pageTarget] = useState<DictationTarget>(() => ({
		read: () => targetRef.current.read(),
		write: (v) => targetRef.current.write(v),
	}));
	const currentTarget = useCallback(() => claimedTarget ?? pageTarget, [pageTarget]);
	useEffect(() => {
		composerTarget = pageTarget;
		return () => {
			if (composerTarget === pageTarget) composerTarget = null;
		};
	}, [pageTarget]);

	// Live machinery (non-render values).
	const engineRef = useRef<Engine | null>(null);
	const runRef = useRef<Run | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	/** Per-run graph nodes — the CONTEXT outlives runs (mitigation C). */
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	/** Frames captured before an engine exists (mitigation A). */
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0); // stale-handler guard (dictate pattern)
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Resolvers waiting for the run to fully end (finish()). */
	const waitersRef = useRef<Array<() => void>>([]);

	/** Render the run's text into its target(s): cleaned, live or final. */
	const render = useCallback((final: boolean) => {
		const run = runRef.current;
		if (!run) return;
		const clean = (raw: string, isFinal: boolean) => cleanDictation(raw, {
			removeFillers: run.settings.removeFillerWords, language: run.language, final: isFinal,
			complete: completeWords(run),
		});
		let text = clean(run.committed, final);
		if (final && text && run.settings.appendTrailingSpace) text += " ";
		run.spans.set(text);
		tentativeRef.current = final ? "" : clean(run.tentative, true);
	}, []);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by
	 *  callers. A kept run renders its final text first (held-back words). */
	const cleanup = useCallback((opts: { keep?: boolean; warmNext?: boolean } = {}) => {
		const { keep = true, warmNext = true } = opts;
		genRef.current++;
		setDictationActive(false);
		if (keep) render(true);
		const engine = runRef.current?.settings.engine;
		runRef.current = null;
		tentativeRef.current = "";
		if (safetyRef.current) {
			clearTimeout(safetyRef.current);
			safetyRef.current = null;
		}
		pendingRef.current = [];
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		// The AudioContext is app-lifetime (mitigation C) — nodes die, it stays.
		engineRef.current?.close();
		engineRef.current = null;
		setPhase("idle");
		// The finish() waiters ride until NOW — post-render, post-teardown.
		for (const w of waitersRef.current.splice(0)) w();
		// Pre-mint for the next Deepgram run (mitigation D) — best-effort.
		if (warmNext && engine === "deepgram") warmTokens.refresh();
	}, [render]);

	/** Hand an engine the frames captured while it was opening. */
	const attach = useCallback((engine: Engine) => {
		engineRef.current = engine;
		for (const frame of pendingRef.current) engine.send(frame);
		pendingRef.current = [];
	}, []);

	/** Deepgram: the socket, its reconnect-once, and its messages. */
	const openDeepgram = useCallback((gen: number, token: string, settings: ResolvedDictationSettings) => {
		let ws: WebSocket;
		let queued: ArrayBuffer[] = [];
		let reconnects = 0;
		const url = deepgramListenUrl(settings.language as DictationLanguage, {
			interim: true, keepFillerWords: !settings.removeFillerWords,
		});
		const connect = (tok: string) => {
			// Minted JWTs authenticate via the "bearer" subprotocol (verified
			// live; "token" is for raw API keys only).
			ws = new WebSocket(url, ["bearer", tok]);
			ws.addEventListener("open", () => {
				if (gen !== genRef.current) return;
				// Mitigation A: everything captured during the handshake (or a
				// reconnect gap) goes out now, in order.
				for (const frame of queued) ws.send(frame);
				queued = [];
				setPhase((p) => (p === "connecting" ? "recording" : p));
			});
			ws.addEventListener("message", (ev) => {
				if (gen !== genRef.current) return;
				let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				const run = runRef.current;
				if (msg.type !== "Results" || !run) return;
				const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
				if (msg.is_final) {
					if (text) run.committed = run.committed ? `${run.committed} ${text}` : text;
					run.tentative = "";
				} else {
					run.tentative = text;
				}
				render(false);
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					// Our own CloseStream landing: finalize now.
					cleanup();
					return;
				}
				// Abnormal close mid-run: ONE reconnect with a FRESH token.
				if (reconnects < 1) {
					reconnects++;
					mintFreshToken()
						.then((t) => { if (gen === genRef.current) connect(t); })
						.catch(() => {
							if (gen === genRef.current) {
								setError("Deepgram reconnect failed");
								cleanup();
							}
						});
				} else {
					setError(`Deepgram connection lost (${ev.code})`);
					cleanup();
				}
			});
		};
		connect(token);
		const engine: Engine = {
			send: (frame) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(frame);
				else {
					queued.push(frame);
					if (queued.length > PENDING_FRAMES_CAP) queued.shift();
				}
			},
			stop: () => {
				if (ws.readyState !== WebSocket.OPEN) { cleanup(); return; }
				try {
					ws.send(JSON.stringify({ type: "CloseStream" }));
				} catch {
					cleanup();
					return;
				}
				// Deepgram flushes remaining finals then closes; if it never
				// does, the safety net ends the run anyway (dictate pattern).
				safetyRef.current = setTimeout(() => { if (gen === genRef.current) cleanup(); }, DEEPGRAM_STOP_SAFETY_MS);
			},
			close: () => {
				if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
					try { ws.close(); } catch {}
				}
			},
		};
		attach(engine);
	}, [attach, cleanup, render]);

	/** Local: a direct port to the worker for this run. */
	const openLocal = useCallback((gen: number, port: MessagePort, settings: ResolvedDictationSettings) => {
		const model = localDictationModel(settings.local.model);
		const language = resolveLocalLanguage(model, settings.local.language);
		/** The worker already ended this run (final or error). */
		let ended = false;
		port.onmessage = ({ data }) => {
			if (data?.runId === gen && (data.type === "final" || data.type === "error")) ended = true;
			if (gen !== genRef.current || data?.runId !== gen) return;
			const run = runRef.current;
			if (!run) return;
			switch (data.type) {
				case "started":
					setPhase((p) => (p === "connecting" ? "recording" : p));
					break;
				case "text":
					run.committed = data.committed;
					run.tentative = data.tentative;
					render(false);
					break;
				case "final":
					// Handy: the final text is the stream's FULL transcript; the
					// detected language (Auto) is the gate's best evidence.
					run.committed = data.text;
					run.tentative = "";
					if (!run.language && data.language) run.language = String(data.language).split("-")[0]!;
					cleanup();
					break;
				case "error":
					setError(data.message ?? "Local dictation failed");
					cleanup();
					break;
			}
		};
		port.start();
		port.postMessage({ type: "start", runId: gen, language, vad: settings.local.vad });
		attach({
			// Cloned, never transferred: Electron silently drops a message
			// that transfers an ArrayBuffer to the utility process (verified
			// on Electron 44, 2026-10-28). A frame is 4 KB per 128 ms.
			send: (frame) => port.postMessage({ type: "audio", runId: gen, pcm: frame }),
			stop: () => {
				port.postMessage({ type: "stop", runId: gen });
				safetyRef.current = setTimeout(() => {
					if (gen !== genRef.current) return;
					setError("The local engine did not finish");
					cleanup();
				}, LOCAL_STOP_SAFETY_MS);
			},
			close: () => {
				// cleanup() has already moved the generation on, so the run's
				// own flag decides: a run the worker didn't end is cancelled
				// there (Esc, unmount, a timed-out stop) — else its stream
				// lease would block the idle unload. The close waits a beat so
				// the cancel is delivered; the next run's connect replaces the
				// worker's port anyway.
				port.onmessage = null;
				if (!ended) port.postMessage({ type: "cancel", runId: gen });
				setTimeout(() => port.close(), 1000);
			},
		});
	}, [attach, cleanup, render]);

	const start = useCallback(async () => {
		setDictationActive(true);
		setError(null);
		setPhase("connecting");
		pendingRef.current = []; // fresh run, fresh queue (mitigation A)
		tentativeRef.current = "";
		const gen = ++genRef.current;
		let settings: ResolvedDictationSettings;
		try {
			settings = await getSettings();
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "Dictation settings unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		runRef.current = {
			settings, language: outputLanguage(settings),
			committed: "", tentative: "", spans: new DictationSpans(currentTarget),
		};

		// The engine's own setup runs CONCURRENTLY with the mic (the long pole).
		let connection: Promise<string | MessagePort>;
		if (settings.engine === "local") {
			connection = (async () => {
				const local = await refreshLocalDictation();
				if (!local.available) throw new Error(DICTATION_DESKTOP_ONLY);
				if (local.models[settings.local.model]?.state !== "ready") throw new Error(DICTATION_NO_LOCAL_MODEL);
				return openLocalDictationPort();
			})();
		} else {
			// Mitigation D: the warm token resolves ~instantly.
			connection = warmTokens.mint();
		}
		connection.catch(() => {}); // surfaced below; no unhandled rejection
		const micPromise = navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		try {
			const stream = await micPromise;
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
				} else if (msg.type === "audio") {
					const engine = engineRef.current;
					if (engine) engine.send(msg.buffer!);
					else {
						// Mitigation A: no engine yet — queue, capped.
						pendingRef.current.push(msg.buffer!);
						if (pendingRef.current.length > PENDING_FRAMES_CAP) pendingRef.current.shift();
					}
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			// Pull the graph with silence out — an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const msg =
				e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
					? "Microphone permission denied"
					: e instanceof Error
						? e.message
						: "mic unavailable";
			setError(msg);
			cleanup({ keep: false });
			return;
		}
		if (gen !== genRef.current) return;
		let opened: string | MessagePort;
		try {
			opened = await connection;
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "dictation unavailable");
			cleanup({ keep: false });
			return;
		}
		if (gen !== genRef.current) {
			if (typeof opened !== "string") opened.close();
			return;
		}
		// Mitigation B: the engine opens the moment the graph is live.
		if (typeof opened === "string") openDeepgram(gen, opened, settings);
		else openLocal(gen, opened, settings);
	}, [cleanup, currentTarget, getSettings, openDeepgram, openLocal]);

	const stop = useCallback(() => {
		if (phase !== "recording" && phase !== "connecting") return;
		setPhase("stopping");
		// Mic dies FIRST — no more audio enqueues (dictate pattern).
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		const engine = engineRef.current;
		if (engine) engine.stop();
		else cleanup();
	}, [phase, cleanup]);

	const cancel = useCallback(() => {
		if (phase === "idle") return;
		// Discard first, teardown second: this run's text leaves the field
		// (owner, 2026-10-27), and nothing renders after it.
		runRef.current?.spans.remove();
		cleanup({ keep: false });
	}, [phase, cleanup]);

	const finish = useCallback((): Promise<void> => {
		return new Promise((resolve) => {
			if (phase === "idle") {
				resolve();
				return;
			}
			waitersRef.current.push(resolve);
			// "stopping" is already ending — the waiter just rides to cleanup.
			if (phase === "recording" || phase === "connecting") stop();
		});
	}, [phase, stop]);

	// Publish finish() for the sibling subtrees (the pending question's dock).
	useEffect(() => {
		dictationFinisher = finish;
		return () => {
			if (dictationFinisher === finish) dictationFinisher = null;
		};
	}, [finish]);

	const toggle = useCallback(() => {
		if (phase === "idle") void start();
		else if (phase === "recording" || phase === "connecting") stop();
		// "stopping" presses are ignored — the flush is in flight.
	}, [phase, start, stop]);

	// Shortcut seams (keyboard wave A): ⌘D toggles from anywhere on the
	// page; the Esc chain lands here as a CANCEL (owner, round 3).
	// Pre-mint at mount (mitigation D) — Deepgram users only; silent if keyless.
	const deepgram = resolved?.engine === "deepgram";
	useEffect(() => { if (deepgram) warmTokens.refresh(); }, [deepgram]);
	useEffect(() => {
		return () => {
			// Navigation ends capture: invalidate every pending await before
			// releasing resources, and never write into a different page's input.
			runRef.current = null;
			cleanup({ keep: false, warmNext: false });
		};
	}, [cleanup]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => window.removeEventListener("lh:kbd-cancel-dictation", cancel);
	}, [cancel]);

	return {
		phase,
		error,
		levelRef,
		tentativeRef,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
		cancel,
		clearError: () => setError(null),
	};
}

/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out).
 *   active    optimistic from the CLICK: red stop pill + the meter, and the
 *             engine's live guess greyed at the meter's end (live text,
 *             2026-10-27). Spinner while the engine flushes.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, tentativeRef, toggle, active, clearError } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The setup click (zero-keys wave): the errored idle button deep-links
	 *  Settings to what's missing and clears the error. Any other error
	 *  keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS;
	const modelless = error === DICTATION_NO_LOCAL_MODEL;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	const [tentative, setTentative] = useState("");
	/** Adaptive cell count (owner round 2): derived from the meter's measured width. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The strip's own heartbeat — 60ms samples of the level and guess refs.
	// Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		setTentative("");
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
			setTentative(tentativeRef.current);
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef, tentativeRef]);

	// Fit the cell count to the available width (4px pitch per cell, 8..48).
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	if (!active) {
		return (
			<Hint
				// The error line truncates in the button; its tooltip reveals it.
				label={error ?? "Dictate"}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", DEEPGRAM_KEY_ID);
						} else if (modelless) {
							clearError();
							openSettings("keys", DICTATION_SETTINGS_ROW);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
					className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
				>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
		);
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint label="Stop dictation (Esc cancels)" side="top">
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
					data-testid="dictation-toggle"
					className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
				>
					{phase === "stopping" ? <Loader2Icon className="size-3.5 animate-spin" /> : <MicIcon className="size-3.5" />}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
			{tentative && (
				<span
					className="min-w-0 max-w-[45%] shrink truncate text-xs italic text-muted-foreground/60"
					dir="rtl"
					data-testid="dictation-tentative"
					title={tentative}
				>
					{/* rtl keeps the NEWEST words visible when the guess truncates */}
					<bdi>{tentative}</bdi>
				</span>
			)}
		</div>
	);
}
