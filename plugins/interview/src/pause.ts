/** The pause trigger: decides when the learner's finished speech goes to the
 * interviewer. Pure and browser-safe; the Live screen samples it on a short tick
 * and the replay harness runs the same rule over timed chunks. */
import type { InterviewListening } from "./contract.ts";

export interface PauseState {
  /** Finished (committed) text not yet sent. */
  unsent: string;
  /** The dictation's volatile guess, when known — non-empty means mid-word. */
  tentative: string;
  /** Time since the unsent or tentative text last changed. */
  msSinceChange: number;
  silenceMs: number;
  waitForSubmit: boolean;
  /** A turn is in flight — hold until it settles. */
  busy: boolean;
}

export function shouldSendOnPause(s: PauseState): boolean {
  if (s.waitForSubmit || s.busy) return false;
  if (!s.unsent.trim() || s.tentative.trim()) return false;
  return s.msSinceChange >= s.silenceMs;
}

/** 0..1 — how far through the silence window (the countdown bar). 0 while there is
 * nothing to send, they are still speaking, or pauses are off. */
export function pauseProgress(s: PauseState): number {
  if (s.waitForSubmit || !s.unsent.trim() || s.tentative.trim()) return 0;
  return Math.max(0, Math.min(1, s.msSinceChange / s.silenceMs));
}

/** One stretch of finished speech, arriving `atMs` after the start. */
export interface ReplayChunk { atMs: number; text: string }

/** The turns the Live screen would send for these chunks. The last batch goes as
 * a Submit. A turn is assumed to settle before the next chunk. */
export function turnsFromChunks(chunks: readonly ReplayChunk[], listening: InterviewListening): string[] {
  const ordered = [...chunks].sort((a, b) => a.atMs - b.atMs);
  const turns: string[] = [];
  let pending: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const chunk = ordered[i]!;
    pending.push(chunk.text.trim());
    const next = ordered[i + 1];
    const quietFor = next ? next.atMs - chunk.atMs : Infinity;
    const send = shouldSendOnPause({
      unsent: pending.join(" "), tentative: "", msSinceChange: quietFor,
      silenceMs: listening.silenceMs, waitForSubmit: listening.waitForSubmit, busy: false,
    });
    if (send || !next) {
      turns.push(pending.join(" "));
      pending = [];
    }
  }
  return turns.filter((t) => t.length > 0);
}
