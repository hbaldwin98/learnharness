/** The live interviewer: the cheap model, one end-turn tool per turn, steering
 * through the script the author wrote. Its instructions are fixed per interview
 * (doctrine + script); the current position reaches it through tool results. */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import type { InterviewQuestion, InterviewScript, InterviewSetup, InterviewToolDetails } from "./contract.ts";

export const INTERVIEW_TOOLS = ["stay_quiet", "interject", "probe", "ask_choice", "open_code", "advance", "wrap_up"] as const;
export type InterviewToolName = (typeof INTERVIEW_TOOLS)[number];

export const INTERVIEWER_DOCTRINE = `You are a calm, experienced technical interviewer running a live interview. The candidate answers mostly by speaking; each message you receive is a stretch of their finished speech (sent when they paused or pressed Submit), or a choice they picked ("My answer: …"). During a code question their message may end with a "My code so far" block — the current editor contents, sent whenever the code changed. Judge the code with what they said about it.

# Your job each turn

Call exactly ONE tool, then stop. Write no other text — anything outside a tool is discarded.

- **stay_quiet** — your default. Real interviewers mostly listen. A pause usually means the candidate is thinking, not finished. Stay quiet while they are making progress, even if the answer is incomplete so far.
- **interject** — only when it clearly helps: they are stuck, going in circles, have drifted off the question, or stated something plainly wrong that will derail them. One or two sentences. Never give the answer away.
- **probe** — they have finished a thought on the current question and a key point is missing or shallow. Prefer a scripted probe, reworded naturally.
- **advance / ask_choice / open_code** — pose the next question once the current one is covered well enough, or has had a fair try. Use the tool that matches the question's format.
- **wrap_up** — after the last question, or when the candidate asks to stop.

# Judging a turn

Compare what they have said so far on the current question against its key points and red flags. Count the whole conversation, not just the latest message. Keep an eye on the question's minutes — move on rather than drill one question forever.

Never grade out loud, never lecture, and never reveal key points, red flags or which choice is correct. The debrief happens afterwards.`;

/** The interview's fixed context block. Pure — tests pin it. */
export function interviewContext(setup: InterviewSetup, script: InterviewScript): string {
  const lines = [
    "# This interview",
    "",
    `Topic: ${script.topic}`,
    `Style: ${script.style} · about ${setup.minutes} minutes`,
    "It starts before the first question: when the candidate says they are ready, pose the first question (advance, ask_choice or open_code, by its format). After that, each tool result names the current question.",
    "",
    "## Script",
  ];
  for (const q of script.questions) {
    lines.push("", `### ${q.id} · ${q.title} (${q.format}, ${q.minutes} min)`, `Prompt: ${q.prompt}`);
    lines.push(`Key points: ${q.keyPoints.join("; ")}`);
    if (q.probes.length) lines.push(`Probes: ${q.probes.join(" | ")}`);
    if (q.redFlags.length) lines.push(`Red flags: ${q.redFlags.join("; ")}`);
  }
  return lines.join("\n");
}

export function interviewerInstructions(setup: InterviewSetup, script: InterviewScript): string {
  return `${INTERVIEWER_DOCTRINE}\n\n${interviewContext(setup, script)}`;
}

/** The interview state the tools read and change. */
export interface InterviewerState {
  script: InterviewScript;
  currentQuestionId?: string;
  endedAt?: string;
}
export interface InterviewerStateAccess {
  read(): InterviewerState | null;
  setCurrent(questionId: string): void;
  end(): void;
}

export interface InterviewerTool {
  name: InterviewToolName;
  description: string;
  parameters: TSchema;
  execute: AgentTool<any>["execute"];
  endRun: true;
}

function done(text: string, details: InterviewToolDetails): AgentToolResult<InterviewToolDetails> {
  return { content: [{ type: "text", text }], details };
}

function where(script: InterviewScript, questionId: string): string {
  const i = script.questions.findIndex((q) => q.id === questionId);
  const next = script.questions[i + 1];
  return `Current question: ${questionId} (${i + 1} of ${script.questions.length})${next ? `; next is ${next.id} (${next.format})` : "; it is the last one"}.`;
}

/** The seven end-turn tools. Invalid calls throw (an error result the model sees
 * and can correct within the run's turn budget). */
export function interviewerTools(state: InterviewerStateAccess): InterviewerTool[] {
  const live = (name: string) => {
    const s = state.read();
    if (!s) throw new Error(`${name}: the interview is unavailable`);
    if (s.endedAt) throw new Error(`${name}: the interview has ended — call stay_quiet`);
    return s;
  };
  const find = (name: string, s: InterviewerState, id: string): InterviewQuestion => {
    const q = s.script.questions.find((x) => x.id === id);
    if (!q) throw new Error(`${name}: no question with id "${id}" in the script`);
    return q;
  };
  const tool = (name: InterviewToolName, description: string, parameters: TSchema, run: (input: any) => AgentToolResult<InterviewToolDetails>): InterviewerTool => ({
    name, description, parameters, endRun: true,
    execute: async (_id, input, signal) => {
      if (signal?.aborted) throw new Error("Cancelled");
      return run(input);
    },
  });
  return [
    tool("stay_quiet",
      "The default. End your turn showing nothing: the candidate is mid-thought and doing fine, or nothing you'd say would help yet.",
      Type.Object({ note: Type.Optional(Type.String({ description: "Private; never shown." })) }),
      () => done("Stayed quiet. The turn ends.", { kind: "quiet" })),
    tool("interject",
      "Say one short thing: a nudge, a clarifying question, or a correction of a clear factual error. One or two sentences.",
      Type.Object({ text: Type.String({ minLength: 1 }) }),
      (input: { text: string }) => done("Shown to the candidate. The turn ends.", { kind: "interject", text: input.text })),
    tool("probe",
      "Ask a follow-up on the current question — prefer one of its scripted probes, reworded naturally.",
      Type.Object({ text: Type.String({ minLength: 1 }) }),
      (input: { text: string }) => {
        const s = live("probe");
        if (!s.currentQuestionId) throw new Error("probe: no current question — pose the first question first");
        return done("Shown to the candidate. The turn ends.", { kind: "probe", text: input.text, questionId: s.currentQuestionId });
      }),
    tool("ask_choice",
      "Show a multiple-choice question from the script. The candidate can pick an answer or keep talking.",
      Type.Object({ questionId: Type.String() }),
      (input: { questionId: string }) => {
        const s = live("ask_choice");
        const q = find("ask_choice", s, input.questionId);
        if (q.format !== "multiple-choice" || !q.choices) throw new Error(`ask_choice: question "${q.id}" is not multiple-choice`);
        state.setCurrent(q.id);
        // The correct flag never reaches the learner's screen.
        return done(`Choices shown. ${where(s.script, q.id)} The turn ends.`, { kind: "choice", questionId: q.id, prompt: q.prompt, choices: q.choices.map((c) => c.text) });
      }),
    tool("open_code",
      "Open the code editor for a code question from the script, with its starter code.",
      Type.Object({ questionId: Type.String() }),
      (input: { questionId: string }) => {
        const s = live("open_code");
        const q = find("open_code", s, input.questionId);
        if (q.format !== "code" || !q.starterCode) throw new Error(`open_code: question "${q.id}" is not a code question`);
        state.setCurrent(q.id);
        return done(`Editor opened. ${where(s.script, q.id)} The turn ends.`, { kind: "code", questionId: q.id, prompt: q.prompt, starterCode: q.starterCode });
      }),
    tool("advance",
      "Move to the next free-form question (or the one named) and pose it. For multiple-choice or code questions use ask_choice or open_code instead.",
      Type.Object({
        questionId: Type.Optional(Type.String({ description: "Default: the question after the current one." })),
        text: Type.Optional(Type.String({ description: "How you pose it; default: the script's prompt." })),
      }),
      (input: { questionId?: string; text?: string }) => {
        const s = live("advance");
        let q: InterviewQuestion | undefined;
        if (input.questionId) q = find("advance", s, input.questionId);
        else {
          const at = s.script.questions.findIndex((x) => x.id === s.currentQuestionId);
          q = s.script.questions[at + 1];
          if (!q) throw new Error("advance: that was the last question — call wrap_up");
        }
        state.setCurrent(q.id);
        return done(`Question posed. ${where(s.script, q.id)} The turn ends.`, { kind: "advance", questionId: q.id, title: q.title, text: input.text ?? q.prompt });
      }),
    tool("wrap_up",
      "End the interview: the last question is done or time is up. Say a brief closing line; the debrief follows.",
      Type.Object({ text: Type.String({ minLength: 1 }) }),
      (input: { text: string }) => {
        live("wrap_up");
        state.end();
        return done("Interview ended. The turn ends.", { kind: "wrap_up", text: input.text });
      }),
  ];
}
