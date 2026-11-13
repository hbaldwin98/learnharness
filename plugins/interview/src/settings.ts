/** Settings → Interview: how the interviewer listens and which model it runs.
 * Pure and browser-safe. */
import type { InterviewListening, InterviewModelChoice, InterviewSettings } from "./contract.ts";

export const SILENCE_MS_MIN = 500;
export const SILENCE_MS_MAX = 5000;
export const SILENCE_MS_DEFAULT = 1500;

function modelChoice(raw: unknown): InterviewModelChoice | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return typeof r.provider === "string" && r.provider && typeof r.id === "string" && r.id ? { provider: r.provider, id: r.id } : undefined;
}

/** Lenient read of the stored file: drops what's bad. */
export function sanitizeSettings(raw: unknown): InterviewSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: InterviewSettings = {};
  if (typeof r.silenceMs === "number" && r.silenceMs >= SILENCE_MS_MIN && r.silenceMs <= SILENCE_MS_MAX) out.silenceMs = r.silenceMs;
  if (typeof r.waitForSubmit === "boolean") out.waitForSubmit = r.waitForSubmit;
  const model = modelChoice(r.interviewerModel);
  if (model) out.interviewerModel = model;
  return out;
}

/** Strict read of a settings patch: a message on anything bad. `interviewerModel:
 * null` clears the override (back to the cheap slot). */
export function parseSettingsPatch(raw: unknown, current: InterviewSettings): { ok: true; value: InterviewSettings } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Settings must be an object" };
  const r = raw as Record<string, unknown>;
  const value: InterviewSettings = { ...current };
  if (r.silenceMs !== undefined) {
    if (typeof r.silenceMs !== "number" || !(r.silenceMs >= SILENCE_MS_MIN && r.silenceMs <= SILENCE_MS_MAX)) {
      return { ok: false, error: `silenceMs must be between ${SILENCE_MS_MIN} and ${SILENCE_MS_MAX}` };
    }
    value.silenceMs = r.silenceMs;
  }
  if (r.waitForSubmit !== undefined) {
    if (typeof r.waitForSubmit !== "boolean") return { ok: false, error: "waitForSubmit must be a boolean" };
    value.waitForSubmit = r.waitForSubmit;
  }
  if (r.interviewerModel === null) delete value.interviewerModel;
  else if (r.interviewerModel !== undefined) {
    const model = modelChoice(r.interviewerModel);
    if (!model) return { ok: false, error: "interviewerModel must be {provider, id} or null" };
    value.interviewerModel = model;
  }
  return { ok: true, value };
}

export function resolveListening(stored: InterviewSettings): InterviewListening {
  return { silenceMs: stored.silenceMs ?? SILENCE_MS_DEFAULT, waitForSubmit: stored.waitForSubmit ?? false };
}

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The lowest thinking level a model supports (undefined when it reports none). */
export function lowestThinkingLevel<T extends string>(supported: readonly T[]): T | undefined {
  return [...supported].sort((a, b) => rank(a) - rank(b))[0];
}
function rank(level: string): number {
  const i = LEVEL_ORDER.indexOf(level);
  return i < 0 ? LEVEL_ORDER.length : i;
}
