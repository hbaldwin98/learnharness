import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { authorInterview, authorPrompt, scriptProblem } from "../src/author.ts";
import type { InterviewScript, InterviewSetup } from "../src/contract.ts";
import { debriefProblem, teachGapsPrompt, transcriptText, writeDebrief } from "../src/debrief.ts";

const setup: InterviewSetup = { topic: "How a web request travels", style: "narration", minutes: 15 };

const goodQuestions = [
  { id: "q1", title: "URL to response", prompt: "Walk me through it.", format: "free", keyPoints: ["DNS"], probes: ["Which transport?"], redFlags: [], minutes: 8 },
  {
    id: "q2", title: "DNS transport", prompt: "Which transport does DNS use?", format: "multiple-choice",
    choices: [{ text: "UDP 53", correct: true }, { text: "TCP 443", correct: false }],
    keyPoints: ["UDP, TCP fallback"], probes: [], redFlags: [], minutes: 2,
  },
];

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
  return {
    role: "assistant", content, api: "faux", provider: "faux", model: "faux", stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as AssistantMessage;
}
const call = (name: string, args: unknown, id: string) => reply([{ type: "toolCall", id, name, arguments: args as never }]);

function scripted(replies: AssistantMessage[]) {
  const seen: Context[] = [];
  return {
    seen,
    complete: async (context: Context) => {
      seen.push(structuredClone(context));
      const next = replies.shift();
      if (!next) throw new Error("no more replies");
      return next;
    },
  };
}

describe("author", () => {
  it("returns the submitted script with the setup's topic and style", async () => {
    const { complete } = scripted([call("submit_interview", { questions: goodQuestions }, "ok")]);
    const script = await authorInterview(setup, complete);
    assert.equal(script.topic, setup.topic);
    assert.equal(script.style, "narration");
    assert.deepEqual(script.questions.map((q) => q.id), ["q1", "q2"]);
  });

  it("sends a rule violation back as a tool error and accepts the retry", async () => {
    const bad = [{ ...goodQuestions[1], choices: [{ text: "a", correct: true }, { text: "b", correct: true }] }];
    const { complete, seen } = scripted([call("submit_interview", { questions: bad }, "bad"), call("submit_interview", { questions: goodQuestions }, "good")]);
    const script = await authorInterview(setup, complete);
    assert.equal(script.questions.length, 2);
    const feedback = seen[1]!.messages.at(-1)!;
    assert.equal(feedback.role, "toolResult");
    assert.match(JSON.stringify(feedback), /exactly one correct choice/);
  });

  it("rejects schema-invalid input as a tool error", async () => {
    const { complete, seen } = scripted([call("submit_interview", { questions: [{ id: "q1" }] }, "bad"), call("submit_interview", { questions: goodQuestions }, "good")]);
    await authorInterview(setup, complete);
    assert.match(JSON.stringify(seen[1]!.messages.at(-1)), /Invalid input/);
  });

  it("gives up after three attempts", async () => {
    const { complete } = scripted([reply([{ type: "text", text: "no" }], "stop"), reply([{ type: "text", text: "no" }], "stop"), reply([{ type: "text", text: "no" }], "stop")]);
    await assert.rejects(authorInterview(setup, complete), /never submitted/);
  });

  it("surfaces a provider error", async () => {
    const { complete } = scripted([{ ...reply([], "error"), errorMessage: "boom" }]);
    await assert.rejects(authorInterview(setup, complete), /boom/);
  });

  it("checks the rules the schema can't express", () => {
    const base: InterviewScript = { topic: "t", style: "narration", questions: goodQuestions as InterviewScript["questions"] };
    assert.equal(scriptProblem(base), null);
    assert.match(scriptProblem({ ...base, questions: [base.questions[0]!, base.questions[0]!] })!, /used twice/);
    assert.match(scriptProblem({ ...base, questions: [{ ...base.questions[0]!, format: "code", starterCode: { language: "ts", code: "" } }] })!, /narration interviews have no code/);
    assert.match(scriptProblem({ ...base, style: "coding", questions: [{ ...base.questions[0]!, format: "code" }] })!, /no starterCode/);
  });

  it("puts the topic, style and length in the prompt", () => {
    const prompt = authorPrompt(setup);
    assert.match(prompt, /web request/);
    assert.match(prompt, /narration interview/);
    assert.match(prompt, /15 minutes/);
  });
});

const script: InterviewScript = { topic: "t", style: "narration", questions: goodQuestions as InterviewScript["questions"] };
const transcript: AgentMessage[] = [
  { role: "user", content: "I'm ready", timestamp: 0 },
  { role: "toolResult", toolCallId: "a", toolName: "advance", isError: false, content: [], details: { kind: "advance", questionId: "q1", title: "URL", text: "Walk me through it." }, timestamp: 0 },
  { role: "user", content: [{ type: "text", text: "DNS first" }], timestamp: 0 },
  { role: "toolResult", toolCallId: "b", toolName: "stay_quiet", isError: false, content: [], details: { kind: "quiet" }, timestamp: 0 },
  { role: "toolResult", toolCallId: "c", toolName: "probe", isError: true, content: [], details: { kind: "probe", text: "hidden", questionId: "q1" }, timestamp: 0 },
  { role: "toolResult", toolCallId: "d", toolName: "ask_choice", isError: false, content: [], details: { kind: "choice", questionId: "q2", prompt: "Which?", choices: ["UDP 53", "TCP 443"] }, timestamp: 0 },
] as AgentMessage[];

describe("debrief", () => {
  it("reads the transcript as the grader sees it", () => {
    assert.equal(transcriptText(transcript), [
      "CANDIDATE: I'm ready",
      "INTERVIEWER [poses q1]: Walk me through it.",
      "CANDIDATE: DNS first",
      "INTERVIEWER [multiple choice q2]: Which? Options: UDP 53 | TCP 443",
    ].join("\n\n"));
  });

  it("checks per-question counts against the script", () => {
    const ok = { strengths: ["a"], gaps: [], perQuestion: [{ questionId: "q1", summary: "s", keyPointsHit: 1, keyPointsTotal: 1 }] };
    assert.equal(debriefProblem(script, ok), null);
    assert.match(debriefProblem(script, { ...ok, perQuestion: [{ ...ok.perQuestion[0]!, questionId: "zz" }] })!, /not in the script/);
    assert.match(debriefProblem(script, { ...ok, perQuestion: [{ ...ok.perQuestion[0]!, keyPointsTotal: 3 }] })!, /has 1 key points/);
    assert.match(debriefProblem(script, { ...ok, strengths: [] })!, /at least one/);
  });

  it("writes a debrief with the script's grading material in the prompt", async () => {
    const debrief = { strengths: ["Clear DNS story"], gaps: ["TLS"], perQuestion: [{ questionId: "q1", summary: "ok", keyPointsHit: 1, keyPointsTotal: 1 }] };
    const { complete, seen } = scripted([call("submit_debrief", debrief, "d")]);
    assert.deepEqual(await writeDebrief(script, transcript, complete), debrief);
    const prompt = JSON.stringify(seen[0]!.messages[0]);
    assert.match(prompt, /UDP 53 \(correct\)/);
    assert.match(prompt, /CANDIDATE: DNS first/);
  });

  it("seeds the teaching session with the gaps", () => {
    assert.equal(teachGapsPrompt("DNS", ["TLS", "TTL"]), 'I just did a mock interview on "DNS". Teach me the gaps it found:\n- TLS\n- TTL');
  });
});
