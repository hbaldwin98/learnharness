import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InterviewScript, InterviewSetup } from "../src/contract.ts";
import { INTERVIEW_TOOLS, interviewContext, interviewerInstructions, interviewerTools, type InterviewerState } from "../src/interviewer.ts";

const setup: InterviewSetup = { topic: "Web requests", style: "coding", minutes: 20 };
const script: InterviewScript = {
  topic: "Web requests",
  style: "coding",
  questions: [
    { id: "q1", title: "Warm-up", prompt: "Tell me about DNS.", format: "free", keyPoints: ["resolver"], probes: ["Which port?"], redFlags: ["TCP only"], minutes: 5 },
    { id: "q2", title: "Transport", prompt: "Which transport?", format: "multiple-choice", choices: [{ text: "UDP", correct: true }, { text: "TCP", correct: false }], keyPoints: ["UDP"], probes: [], redFlags: [], minutes: 2 },
    { id: "q3", title: "Cache", prompt: "Write a cache.", format: "code", starterCode: { language: "ts", code: "// go" }, keyPoints: ["TTL"], probes: [], redFlags: [], minutes: 10 },
  ],
};

function harness(start: Partial<InterviewerState> = {}) {
  const state: InterviewerState = { script, ...start };
  const tools = interviewerTools({
    read: () => state,
    setCurrent: (id) => { state.currentQuestionId = id; },
    end: () => { state.endedAt = "now"; },
  });
  const call = (name: string, input: unknown) => tools.find((t) => t.name === name)!.execute("c1", input as never, undefined, undefined);
  return { state, tools, call };
}

describe("interviewer tools", () => {
  it("offers the seven end-turn tools", () => {
    const { tools } = harness();
    assert.deepEqual(tools.map((t) => t.name), [...INTERVIEW_TOOLS]);
    assert.ok(tools.every((t) => t.endRun));
  });

  it("stay_quiet and interject change nothing", async () => {
    const { state, call } = harness({ currentQuestionId: "q1" });
    assert.deepEqual((await call("stay_quiet", {})).details, { kind: "quiet" });
    assert.deepEqual((await call("interject", { text: "Go on" })).details, { kind: "interject", text: "Go on" });
    assert.equal(state.currentQuestionId, "q1");
  });

  it("advance poses the next question and names the position", async () => {
    const { state, call } = harness();
    const first = await call("advance", {});
    assert.deepEqual(first.details, { kind: "advance", questionId: "q1", title: "Warm-up", text: "Tell me about DNS." });
    assert.match(JSON.stringify(first.content), /Current question: q1 \(1 of 3\); next is q2 \(multiple-choice\)/);
    assert.equal(state.currentQuestionId, "q1");
  });

  it("probe needs a current question", async () => {
    await assert.rejects(harness().call("probe", { text: "Port?" }), /no current question/);
    assert.deepEqual((await harness({ currentQuestionId: "q1" }).call("probe", { text: "Port?" })).details, { kind: "probe", text: "Port?", questionId: "q1" });
  });

  it("ask_choice shows choices without the correct flags", async () => {
    const { state, call } = harness({ currentQuestionId: "q1" });
    const result = await call("ask_choice", { questionId: "q2" });
    assert.deepEqual(result.details, { kind: "choice", questionId: "q2", prompt: "Which transport?", choices: ["UDP", "TCP"] });
    assert.doesNotMatch(JSON.stringify(result), /correct/);
    assert.equal(state.currentQuestionId, "q2");
    await assert.rejects(call("ask_choice", { questionId: "q1" }), /not multiple-choice/);
  });

  it("open_code opens the editor with starter code", async () => {
    const { call } = harness();
    assert.deepEqual((await call("open_code", { questionId: "q3" })).details, { kind: "code", questionId: "q3", prompt: "Write a cache.", starterCode: { language: "ts", code: "// go" } });
    await assert.rejects(call("open_code", { questionId: "nope" }), /no question with id/);
  });

  it("advance past the last question asks for wrap_up", async () => {
    await assert.rejects(harness({ currentQuestionId: "q3" }).call("advance", {}), /call wrap_up/);
  });

  it("wrap_up ends it; afterwards only stay_quiet works", async () => {
    const { state, call } = harness({ currentQuestionId: "q3" });
    await call("wrap_up", { text: "Thanks!" });
    assert.equal(state.endedAt, "now");
    await assert.rejects(call("advance", { questionId: "q1" }), /has ended/);
    assert.deepEqual((await call("stay_quiet", {})).details, { kind: "quiet" });
  });
});

describe("interviewer instructions", () => {
  it("carry the doctrine and the whole script", () => {
    const text = interviewerInstructions(setup, script);
    assert.match(text, /Call exactly ONE tool/);
    assert.match(text, /### q2 · Transport \(multiple-choice, 2 min\)/);
    assert.match(text, /Red flags: TCP only/);
    assert.match(interviewContext(setup, script), /about 20 minutes/);
  });
});
