/**
 * LISTENING (practice workspaces, plan step 6): the server side of the
 * agent looking in on a learner's coding work. One listener per active
 * coding problem whose pane has reported in; the pane's heartbeat keeps it
 * present (owner ruling: only while the pane is open and visible). The
 * learner's saves, narration and Runs feed it; a ticker evaluates the
 * timer cues and fires a listening update through the wake pipeline's turn
 * runner when the gates open (src/core/listening.ts decides).
 *
 * The engine takes its dependencies, so tests drive it with a fake clock;
 * the process-wide instance (globalThis, like the other registries) wires
 * the real ones.
 */

import {
	addCue,
	isStruggle,
	listenDecision,
	newListenState,
	timerCues,
	type ListenCue,
	type ListenState,
} from "../core/listening.ts";
import {
	activeProblemOf,
	endsInDismissal,
	hasUnresolvedQuestion,
	pendingProblemDismissalOf,
	type LhMessage,
} from "../core/native-messages.ts";
import { endsInFailedTurn, type ListenInput } from "../core/input-events.ts";

/** What the pane shows: listening, paused by the connection, or switched off. */
export type ListeningStatus = "on" | "paused" | "off";

export interface ListeningDeps {
	now(): number;
	messages(chatId: string): readonly LhMessage[] | null;
	enabled(): boolean;
	backgroundAllowed(chatId: string): boolean;
	turnRunning(chatId: string): boolean;
	/** Fire the turn; resolves to the HTTP-ish status (200 = started). */
	run(chatId: string, input: ListenInput): Promise<number>;
}

type Key = string;
const keyOf = (chatId: string, problemCallId: string): Key => `${chatId}\0${problemCallId}`;

/** A listener whose pane has been gone this long is dropped. */
const FORGET_AFTER_MS = 10 * 60_000;

export function createListening(deps: ListeningDeps) {
	const listeners = new Map<Key, ListenState & { chatId: string; problemCallId: string; firing: boolean }>();

	const lastLookAt = (messages: readonly LhMessage[]): number => {
		for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant") return messages[i]!.timestamp;
		return 0;
	};

	const isActive = (chatId: string, problemCallId: string): readonly LhMessage[] | null => {
		const messages = deps.messages(chatId);
		if (!messages || activeProblemOf(messages)?.toolCallId !== problemCallId) return null;
		return messages;
	};

	function status(chatId: string): ListeningStatus {
		if (!deps.enabled()) return "off";
		return deps.backgroundAllowed(chatId) ? "on" : "paused";
	}

	/** The pane's heartbeat (visible) or its leaving (hidden). */
	function presence(chatId: string, problemCallId: string, visible: boolean): ListeningStatus {
		const key = keyOf(chatId, problemCallId);
		let l = listeners.get(key);
		if (!l && visible) {
			if (!isActive(chatId, problemCallId)) return status(chatId);
			l = { ...newListenState(deps.now()), chatId, problemCallId, firing: false };
			listeners.set(key, l);
		}
		if (l) l.presentAt = visible ? deps.now() : 0;
		return status(chatId);
	}

	/** The learner did something: an edit, a narration line, a Run. */
	function activity(chatId: string, problemCallId: string, kind: "edit" | "narration" | "run", text?: string): void {
		const l = listeners.get(keyOf(chatId, problemCallId));
		if (!l) return;
		l.lastActivityAt = deps.now();
		if (kind === "run") addCue(l, "run");
		if (kind === "narration" && text && isStruggle(text)) addCue(l, "struggle");
		void evaluate(l);
	}

	/** One listener: timer cues, then the gates, then maybe fire. */
	async function evaluate(l: ListenState & { chatId: string; problemCallId: string; firing: boolean }): Promise<void> {
		if (l.firing) return;
		const now = deps.now();
		const messages = isActive(l.chatId, l.problemCallId);
		if (!messages) {
			listeners.delete(keyOf(l.chatId, l.problemCallId));
			return;
		}
		if (now - l.presentAt > FORGET_AFTER_MS && l.presentAt !== 0) {
			listeners.delete(keyOf(l.chatId, l.problemCallId));
			return;
		}
		timerCues(l, now, lastLookAt(messages));
		const decision = listenDecision(l, now, {
			enabled: deps.enabled(),
			backgroundAllowed: deps.backgroundAllowed(l.chatId),
			turnRunning: deps.turnRunning(l.chatId),
			recordBlocked:
				hasUnresolvedQuestion(messages as LhMessage[]) ||
				endsInDismissal(messages as LhMessage[]) ||
				pendingProblemDismissalOf(messages as LhMessage[]) !== null ||
				endsInFailedTurn(messages),
		});
		if (!decision.fire) return;
		const previous = l.lastListenAt;
		l.firing = true;
		l.lastListenAt = now;
		l.pending = [];
		try {
			const result = await deps.run(l.chatId, { type: "listen", problemCallId: l.problemCallId, cues: decision.cues });
			if (result === 400) listeners.delete(keyOf(l.chatId, l.problemCallId));
			else if (result !== 200) {
				// Not started (a raced turn, background refused): put the cues back.
				l.lastListenAt = previous;
				for (const cue of decision.cues) addCue(l, cue);
			}
		} catch (err) {
			console.error(`[listening ${l.chatId}] the listening turn failed to start:`, err);
			l.lastListenAt = previous;
			for (const cue of decision.cues) addCue(l, cue);
		} finally {
			l.firing = false;
		}
	}

	/** The ticker's body: every listener. */
	async function tick(): Promise<void> {
		await Promise.all([...listeners.values()].map((l) => evaluate(l)));
	}

	/** Stop listening to a chat's problems (conclude, deletion). */
	function forget(chatId: string): void {
		for (const [key, l] of listeners) if (l.chatId === chatId) listeners.delete(key);
	}

	/** Test seam: a listener's state. */
	function peek(chatId: string, problemCallId: string): Readonly<ListenState> | undefined {
		return listeners.get(keyOf(chatId, problemCallId));
	}

	return { presence, activity, tick, forget, status, peek };
}

export type Listening = ReturnType<typeof createListening>;

// ─── the process-wide instance ───────────────────────────────────────────────

const TICK_MS = 5_000;
const STATE_KEY = Symbol.for("learnharness.listening");

interface ListeningProcessState {
	listening: Listening;
	timer: ReturnType<typeof setInterval> | null;
}

/** The process's listener (real dependencies; the ticker starts on first use). */
export async function processListening(): Promise<Listening> {
	const g = globalThis as unknown as Record<symbol, ListeningProcessState | undefined>;
	const existing = g[STATE_KEY];
	if (existing) return existing.listening;
	// Lazy imports: keep this module light for its pure users and tests.
	const { stores, effectiveSettings } = await import("./stores.ts");
	const { isTurnRunning } = await import("./turn-liveness.ts");
	const { automaticFollowUpAllowed, runServerTurn } = await import("./jobs.ts");
	const again = g[STATE_KEY];
	if (again) return again.listening;
	const listening = createListening({
		now: () => Date.now(),
		messages: (chatId) => stores.chatStore.getChat(chatId)?.messages ?? null,
		enabled: () => effectiveSettings().agent.listening.enabled ?? true,
		backgroundAllowed: (chatId) => automaticFollowUpAllowed(chatId),
		turnRunning: (chatId) => isTurnRunning(chatId),
		run: (chatId, input) => runServerTurn(chatId, input),
	});
	const timer = setInterval(() => void listening.tick().catch(() => {}), TICK_MS);
	(timer as { unref?: () => void }).unref?.();
	g[STATE_KEY] = { listening, timer };
	return listening;
}

/** Feed the learner's activity (fire-and-forget; never throws). */
export function noteCodingActivity(chatId: string, problemCallId: string, kind: "edit" | "narration" | "run", text?: string): void {
	const g = globalThis as unknown as Record<symbol, ListeningProcessState | undefined>;
	g[STATE_KEY]?.listening.activity(chatId, problemCallId, kind, text);
}

export type { ListenCue };
