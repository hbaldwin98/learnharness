/** The debrief: after the interview ends, one strong-model submit call grades the
 * transcript against the script's key points. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { InterviewDebrief, InterviewScript, InterviewToolDetails } from "./contract.ts";
import { submitCall, type Complete } from "./submit.ts";

export const DEBRIEF_TOOL = "submit_debrief";

export const debriefSchema = Type.Object({
  strengths: Type.Array(Type.String({ minLength: 1 }), { description: "2-4 specific things the candidate did well" }),
  gaps: Type.Array(Type.String({ minLength: 1 }), { description: "2-4 specific gaps, each one teachable" }),
  perQuestion: Type.Array(
    Type.Object({
      questionId: Type.String(),
      summary: Type.String({ minLength: 1, description: "One short line, e.g. 'works · race condition'" }),
      keyPointsHit: Type.Integer({ minimum: 0 }),
      keyPointsTotal: Type.Integer({ minimum: 0 }),
    }),
    { description: "One entry per question that was posed, in order" },
  ),
});

export const DEBRIEF_SYSTEM_PROMPT = `You grade a finished mock interview for the candidate's own learning. You get the interview script (with each question's key points and red flags) and the transcript. Be specific and honest, kind but not flattering.

- strengths: concrete things they did well, citing what they said.
- gaps: concrete misses or misconceptions, each phrased so it can be studied ("How TLS verifies the server certificate"), not a vague "be more thorough".
- perQuestion: one entry per question that was actually posed; keyPointsHit counts the script's key points their answers covered; keyPointsTotal is that question's key point count. Questions never reached are left out.

Submit with the ${DEBRIEF_TOOL} tool.`;

/** Plain text of a user message. */
export function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
}

/** The interview as the grader reads it: learner speech, the interviewer's moves,
 * quiet turns omitted. Pure. */
export function transcriptText(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = userText(m).trim();
      if (text) lines.push(`CANDIDATE: ${text}`);
    } else if (m.role === "toolResult" && !m.isError) {
      const d = m.details as InterviewToolDetails | undefined;
      switch (d?.kind) {
        case "advance": lines.push(`INTERVIEWER [poses ${d.questionId}]: ${d.text}`); break;
        case "choice": lines.push(`INTERVIEWER [multiple choice ${d.questionId}]: ${d.prompt} Options: ${d.choices.join(" | ")}`); break;
        case "code": lines.push(`INTERVIEWER [code question ${d.questionId}]: ${d.prompt}`); break;
        case "interject": lines.push(`INTERVIEWER [interjects]: ${d.text}`); break;
        case "probe": lines.push(`INTERVIEWER [follow-up on ${d.questionId}]: ${d.text}`); break;
        case "wrap_up": lines.push(`INTERVIEWER [wraps up]: ${d.text}`); break;
      }
    }
  }
  return lines.join("\n\n");
}

export function scriptText(script: InterviewScript): string {
  return script.questions.map((q) => {
    const choices = q.choices ? `\nChoices: ${q.choices.map((c) => `${c.text}${c.correct ? " (correct)" : ""}`).join(" | ")}` : "";
    return `${q.id} · ${q.title} (${q.format})\nPrompt: ${q.prompt}${choices}\nKey points (${q.keyPoints.length}): ${q.keyPoints.join("; ")}\nRed flags: ${q.redFlags.join("; ") || "none"}`;
  }).join("\n\n");
}

export function debriefProblem(script: InterviewScript, debrief: InterviewDebrief): string | null {
  const byId = new Map(script.questions.map((q) => [q.id, q]));
  for (const p of debrief.perQuestion) {
    const q = byId.get(p.questionId);
    if (!q) return `perQuestion names "${p.questionId}", which is not in the script.`;
    if (p.keyPointsTotal !== q.keyPoints.length) return `"${p.questionId}" has ${q.keyPoints.length} key points, not ${p.keyPointsTotal}.`;
    if (p.keyPointsHit > p.keyPointsTotal) return `"${p.questionId}": keyPointsHit can't exceed keyPointsTotal.`;
  }
  if (debrief.strengths.length === 0 && debrief.gaps.length === 0) return "Give at least one strength or gap.";
  return null;
}

export function writeDebrief(script: InterviewScript, messages: readonly AgentMessage[], complete: Complete): Promise<InterviewDebrief> {
  return submitCall<InterviewDebrief, InterviewDebrief>({
    complete,
    systemPrompt: DEBRIEF_SYSTEM_PROMPT,
    prompt: `# Script\n\n${scriptText(script)}\n\n# Transcript\n\n${transcriptText(messages) || "(empty)"}`,
    toolName: DEBRIEF_TOOL,
    toolDescription: "Submit the debrief.",
    parameters: debriefSchema,
    fill: (input) => input,
    validate: (d) => debriefProblem(script, d),
    maxAttempts: 3,
    neverSubmitted: "The debrief was never submitted.",
  });
}

/** The teaching session's opening message, seeded with the gaps. Pure. */
export function teachGapsPrompt(topic: string, gaps: readonly string[]): string {
  return `I just did a mock interview on "${topic}". Teach me the gaps it found:\n${gaps.map((g) => `- ${g}`).join("\n")}`;
}
