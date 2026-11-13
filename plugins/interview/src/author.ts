/** The interview author: one strong-model submit call that writes the script the
 * live interviewer steers through. */
import { Type } from "typebox";
import type { InterviewScript, InterviewSetup } from "./contract.ts";
import { submitCall, type Complete } from "./submit.ts";

export const AUTHOR_TOOL = "submit_interview";

const choiceSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  correct: Type.Boolean(),
});

const questionSchema = Type.Object({
  id: Type.String({ minLength: 1, description: "Short unique id, e.g. q1" }),
  title: Type.String({ minLength: 1, description: "A few words, shown in the plan panel" }),
  prompt: Type.String({ minLength: 1, description: "What the interviewer says to pose the question" }),
  format: Type.Union([Type.Literal("free"), Type.Literal("multiple-choice"), Type.Literal("code")]),
  choices: Type.Optional(Type.Array(choiceSchema, { description: "multiple-choice only: 3-5 options, exactly one correct" })),
  starterCode: Type.Optional(Type.Object(
    { language: Type.String({ minLength: 1 }), code: Type.String() },
    { description: "code only: the editor's starting file" },
  )),
  keyPoints: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "What a strong answer covers" }),
  probes: Type.Array(Type.String({ minLength: 1 }), { description: "Follow-up questions the interviewer may ask" }),
  redFlags: Type.Array(Type.String({ minLength: 1 }), { description: "Signs of a weak or wrong answer" }),
  minutes: Type.Number({ exclusiveMinimum: 0 }),
});

export const interviewScriptSchema = Type.Object({
  questions: Type.Array(questionSchema, { minItems: 1 }),
});

const STYLE_GUIDE: Record<InterviewSetup["style"], string> = {
  narration:
    "A narration interview: the candidate explains a process out loud, end to end. Mostly free-form questions, with an occasional multiple-choice check on a specific fact. No code questions.",
  coding:
    "A coding interview: mostly code questions with starter code, plus free-form questions about approach, complexity and trade-offs.",
  "system-design":
    "A system-design interview: free-form questions that walk from requirements to high-level design to deep dives and trade-offs. Multiple choice only for quick fact checks.",
};

export const AUTHOR_SYSTEM_PROMPT = `You write structured interviews. A separate, smaller interviewer model will run your interview live: it poses each question, listens to the candidate's spoken answers, and uses your key points, probes and red flags to decide when to stay quiet, ask a follow-up, or move on. A grader later scores the candidate against your key points.

Write for that reader:
- prompt: exactly what the interviewer says, conversational, one question at a time.
- keyPoints: concrete, checkable items a strong answer covers.
- probes: short follow-ups, ordered from most to least useful.
- redFlags: specific misconceptions or omissions.
- Order questions from warm-up to hardest. Question minutes should add up to roughly the requested length.

Submit with the ${AUTHOR_TOOL} tool.`;

export function authorPrompt(setup: InterviewSetup): string {
  return `Topic: ${setup.topic}
Style: ${STYLE_GUIDE[setup.style]}
Length: about ${setup.minutes} minutes.`;
}

/** The rules the schema can't express. null = valid. */
export function scriptProblem(script: InterviewScript): string | null {
  const ids = new Set<string>();
  for (const q of script.questions) {
    if (ids.has(q.id)) return `Question id "${q.id}" is used twice; ids must be unique.`;
    ids.add(q.id);
    if (q.format === "multiple-choice") {
      const choices = q.choices ?? [];
      if (choices.length < 2) return `Question "${q.id}" is multiple-choice but has fewer than 2 choices.`;
      if (choices.filter((c) => c.correct).length !== 1) return `Question "${q.id}" must have exactly one correct choice.`;
    }
    if (q.format === "code" && !q.starterCode) return `Question "${q.id}" is a code question but has no starterCode.`;
    if (script.style === "narration" && q.format === "code") return `Question "${q.id}": narration interviews have no code questions.`;
  }
  return null;
}

export function authorInterview(setup: InterviewSetup, complete: Complete): Promise<InterviewScript> {
  return submitCall<{ questions: InterviewScript["questions"] }, InterviewScript>({
    complete,
    systemPrompt: AUTHOR_SYSTEM_PROMPT,
    prompt: authorPrompt(setup),
    toolName: AUTHOR_TOOL,
    toolDescription: "Submit the finished interview.",
    parameters: interviewScriptSchema,
    fill: (input) => ({
      topic: setup.topic,
      style: setup.style,
      questions: input.questions.map((q) => ({ ...q, probes: q.probes ?? [], redFlags: q.redFlags ?? [] })),
    }),
    validate: scriptProblem,
    maxAttempts: 3,
    neverSubmitted: "The interview author never submitted a valid interview.",
  });
}
