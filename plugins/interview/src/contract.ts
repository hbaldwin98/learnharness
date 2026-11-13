/** Interview plugin contracts. Pure and browser-safe. Grading material (key points,
 * probes, red flags, correct choices) lives only in the backend record and never
 * reaches the frontend: the view types below are the whole frontend surface. */

export type InterviewStyle = "narration" | "coding" | "system-design";
export type InterviewQuestionFormat = "free" | "multiple-choice" | "code";

export const INTERVIEW_STYLES: readonly InterviewStyle[] = ["narration", "coding", "system-design"];
export const INTERVIEW_LENGTHS: readonly number[] = [15, 30, 45];

/** What the learner chose on the start screen. */
export interface InterviewSetup {
  topic: string;
  style: InterviewStyle;
  /** Target length in minutes. */
  minutes: number;
}

export interface InterviewChoice { text: string; correct: boolean }
export interface StarterCode { language: string; code: string }

export interface InterviewQuestion {
  id: string;
  title: string;
  prompt: string;
  format: InterviewQuestionFormat;
  choices?: InterviewChoice[];
  starterCode?: StarterCode;
  keyPoints: string[];
  probes: string[];
  redFlags: string[];
  minutes: number;
}

/** The author's output. */
export interface InterviewScript {
  topic: string;
  style: InterviewStyle;
  questions: InterviewQuestion[];
}

export interface InterviewDebrief {
  strengths: string[];
  gaps: string[];
  perQuestion: { questionId: string; summary: string; keyPointsHit: number; keyPointsTotal: number }[];
}

/** What a tool showed the learner: the toolResult details the view reads. */
export type InterviewToolDetails =
  | { kind: "quiet" }
  | { kind: "interject"; text: string }
  | { kind: "probe"; text: string; questionId: string }
  | { kind: "choice"; questionId: string; prompt: string; choices: string[] }
  | { kind: "code"; questionId: string; prompt: string; starterCode: StarterCode }
  | { kind: "advance"; questionId: string; title: string; text: string }
  | { kind: "wrap_up"; text: string };

/** One rendered transcript entry. Quiet turns are already collapsed into runs. */
export type InterviewEntry =
  | { kind: "you"; id: string; text: string }
  | { kind: "said"; id: string; label: string | null; text: string; accent: boolean }
  | { kind: "quiet"; id: string; count: number }
  | { kind: "choice"; id: string; questionId: string; prompt: string; choices: string[] }
  | { kind: "code"; id: string; questionId: string; prompt: string; starterCode: StarterCode };

/** Settings → Interview, resolved. */
export interface InterviewListening {
  silenceMs: number;
  waitForSubmit: boolean;
}

export interface InterviewModelChoice { provider: string; id: string }

/** As stored in the plugin's settings file (absent = default). */
export interface InterviewSettings {
  silenceMs?: number;
  waitForSubmit?: boolean;
  /** Absent = the cheap slot. Always run at the model's lowest thinking level. */
  interviewerModel?: InterviewModelChoice;
}

export type InterviewRunStatus = "idle" | "running" | "waiting" | "error" | "interrupted";

/** GET (`get` operation): what the Live screen may see. */
export interface InterviewView {
  id: string;
  setup: InterviewSetup;
  listening: InterviewListening;
  questions: { id: string; title: string; format: InterviewQuestionFormat }[];
  currentQuestionId?: string;
  endedAt?: string;
  status: InterviewRunStatus;
  error?: string;
  entries: InterviewEntry[];
  debrief?: InterviewDebrief;
}

/** One row of the interview list. */
export interface InterviewSummary {
  id: string;
  topic: string;
  style: InterviewStyle;
  minutes: number;
  createdAt: string;
  ended: boolean;
  hasDebrief: boolean;
}

/** The notification topic the backend emits when an interview changes. */
export const CHANGED_TOPIC = "interview-changed";

/** The opening line that starts turn 1 (the interviewer answers by posing q1). */
export const INTERVIEW_OPENING = "I'm ready — let's begin.";

export function parseSetup(body: unknown): { ok: true; setup: InterviewSetup } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Expected a JSON object" };
  const b = body as Record<string, unknown>;
  const topic = typeof b.topic === "string" ? b.topic.trim() : "";
  if (!topic) return { ok: false, error: "A topic is required" };
  if (topic.length > 2000) return { ok: false, error: "The topic is too long (2000 characters max)" };
  const style = b.style as InterviewStyle;
  if (!INTERVIEW_STYLES.includes(style)) return { ok: false, error: `style must be one of ${INTERVIEW_STYLES.join(", ")}` };
  const minutes = b.minutes;
  if (typeof minutes !== "number" || !INTERVIEW_LENGTHS.includes(minutes)) {
    return { ok: false, error: `minutes must be one of ${INTERVIEW_LENGTHS.join(", ")}` };
  }
  return { ok: true, setup: { topic, style, minutes } };
}
