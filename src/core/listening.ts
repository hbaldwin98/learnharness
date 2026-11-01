/**
 * THE LISTENING CUE ENGINE (practice workspaces, plan step 6): pure
 * decisions over an injected clock. The server module
 * (src/server/listening.ts) feeds it the learner's activity and the gates;
 * this decides which cues are due and whether an update may fire.
 *
 * Owner rulings (2026-11-01): all four cues; at most one listening update
 * in flight; cues arriving meanwhile coalesce; at least 60 s between
 * updates; only while the pane is open and visible; Ask and Submit bypass
 * the cap (they are the learner's, not listening).
 */

export type ListenCue = "run" | "silence" | "interval" | "struggle";

export const LISTEN_TIMING = {
	/** Silence: this long with no edit, narration or Run. */
	silenceMs: 90_000,
	/** Interval: this long since the agent last looked, with activity. */
	intervalMs: 5 * 60_000,
	/** The floor between listening updates. */
	minGapMs: 60_000,
	/** A pane heartbeat keeps listening present this long. */
	presenceMs: 45_000,
} as const;

/** The struggle phrases (case-insensitive, matched in recorded narration). */
export const STRUGGLE_PHRASES: readonly string[] = [
	"i'm stuck",
	"i am stuck",
	"i don't know why",
	"i don't understand",
	"this isn't working",
	"this doesn't work",
	"no idea",
	"what am i missing",
	"i'm lost",
	"i give up",
	"why isn't this",
	"why is this not",
];

/** Does a narration line carry a struggle phrase? Curly apostrophes count. */
export function isStruggle(text: string): boolean {
	const t = text.toLowerCase().replace(/[‘’]/g, "'");
	return STRUGGLE_PHRASES.some((p) => t.includes(p));
}

/** One problem's listening state (owned by the server module). */
export interface ListenState {
	/** The learner's last edit, narration or Run (ms; 0 = none yet). */
	lastActivityAt: number;
	/** The last listening update fired (ms; 0 = none). */
	lastListenAt: number;
	/** The activity time a silence cue already fired for (re-arms on new activity). */
	silenceFiredFor: number;
	/** Cues waiting to be delivered (coalesced, in arrival order). */
	pending: ListenCue[];
	/** The pane's last heartbeat while visible (ms; 0 = never). */
	presentAt: number;
}

export function newListenState(now: number): ListenState {
	// The pose counts as the start of the quiet stretch.
	return { lastActivityAt: now, lastListenAt: 0, silenceFiredFor: -1, pending: [], presentAt: 0 };
}

/** Add a cue to the pending set (coalescing duplicates). */
export function addCue(state: ListenState, cue: ListenCue): void {
	if (!state.pending.includes(cue)) state.pending.push(cue);
}

/**
 * The timer cues due now. `lastLookAt` is when the agent's last turn ended
 * (any turn: a reply to an Ask counts as a look). Mutates `state` to mark
 * silence fired for this stretch.
 */
export function timerCues(state: ListenState, now: number, lastLookAt: number): void {
	const quietSince = Math.max(state.lastActivityAt, lastLookAt);
	if (now - quietSince >= LISTEN_TIMING.silenceMs && state.silenceFiredFor !== state.lastActivityAt) {
		state.silenceFiredFor = state.lastActivityAt;
		addCue(state, "silence");
	}
	if (now - lastLookAt >= LISTEN_TIMING.intervalMs && state.lastActivityAt > lastLookAt) addCue(state, "interval");
}

/** Everything outside the engine that can hold an update back. */
export interface ListenGates {
	/** The global setting (Settings → Coding → Listening). */
	enabled: boolean;
	/** The connection allows background (automatic) turns. */
	backgroundAllowed: boolean;
	/** Any turn is running for the chat. */
	turnRunning: boolean;
	/** The record can't take an automatic turn now (a dangling question, a
	 *  pending dismissal, a failed turn awaiting retry). */
	recordBlocked: boolean;
}

export type ListenDecision = { fire: true; cues: ListenCue[] } | { fire: false; why: "nothing" | "absent" | "off" | "paused" | "busy" | "gap" };

/** May a listening update fire now? Never mutates. */
export function listenDecision(state: ListenState, now: number, gates: ListenGates): ListenDecision {
	if (!gates.enabled) return { fire: false, why: "off" };
	if (state.pending.length === 0) return { fire: false, why: "nothing" };
	if (now - state.presentAt > LISTEN_TIMING.presenceMs) return { fire: false, why: "absent" };
	if (!gates.backgroundAllowed) return { fire: false, why: "paused" };
	if (gates.turnRunning || gates.recordBlocked) return { fire: false, why: "busy" };
	if (state.lastListenAt > 0 && now - state.lastListenAt < LISTEN_TIMING.minGapMs) return { fire: false, why: "gap" };
	return { fire: true, cues: [...state.pending] };
}

/** The learner-facing reason for a look ("after your Run"). */
export function cueLabel(cues: readonly ListenCue[]): string {
	const words: Record<ListenCue, string> = {
		run: "after your Run",
		silence: "after a quiet stretch",
		interval: "a periodic check",
		struggle: "you sounded stuck",
	};
	return cues.map((c) => words[c]).join(" · ");
}

/** The model-facing reason. */
export function cueText(cues: readonly ListenCue[]): string {
	const words: Record<ListenCue, string> = {
		run: "they just ran the visible tests",
		silence: `they have been quiet for ${LISTEN_TIMING.silenceMs / 1000} s (no edits, narration or Runs)`,
		interval: `a periodic check (${LISTEN_TIMING.intervalMs / 60_000} min since you last looked)`,
		struggle: "their narration sounds stuck",
	};
	return cues.map((c) => words[c]).join("; ");
}
