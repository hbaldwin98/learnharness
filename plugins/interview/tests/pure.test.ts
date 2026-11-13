import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { codeTurnText, interviewCodePath } from "../src/code.ts";
import { parseSetup } from "../src/contract.ts";
import { pauseProgress, shouldSendOnPause } from "../src/pause.ts";
import { lowestThinkingLevel, parseSettingsPatch, resolveListening, sanitizeSettings } from "../src/settings.ts";
import { interviewEntries } from "../src/view-model.ts";

const base = { unsent: "hello", tentative: "", msSinceChange: 2000, silenceMs: 1500, waitForSubmit: false, busy: false };

describe("pause rule", () => {
  it("sends finished text after the silence window", () => {
    assert.equal(shouldSendOnPause(base), true);
    assert.equal(shouldSendOnPause({ ...base, msSinceChange: 1000 }), false);
  });
  it("holds while busy, mid-word, empty or waiting for submit", () => {
    assert.equal(shouldSendOnPause({ ...base, busy: true }), false);
    assert.equal(shouldSendOnPause({ ...base, tentative: "wor" }), false);
    assert.equal(shouldSendOnPause({ ...base, unsent: "  " }), false);
    assert.equal(shouldSendOnPause({ ...base, waitForSubmit: true }), false);
  });
  it("reports countdown progress", () => {
    assert.equal(pauseProgress({ ...base, msSinceChange: 750 }), 0.5);
    assert.equal(pauseProgress({ ...base, msSinceChange: 9000 }), 1);
    assert.equal(pauseProgress({ ...base, waitForSubmit: true }), 0);
  });
});

describe("settings", () => {
  it("defaults to 1.5 s and pauses on", () => {
    assert.deepEqual(resolveListening({}), { silenceMs: 1500, waitForSubmit: false });
  });
  it("drops bad stored values", () => {
    assert.deepEqual(sanitizeSettings({ silenceMs: 99, waitForSubmit: "yes", interviewerModel: { provider: "p" } }), {});
    assert.deepEqual(sanitizeSettings({ silenceMs: 2000, interviewerModel: { provider: "p", id: "m" } }), { silenceMs: 2000, interviewerModel: { provider: "p", id: "m" } });
  });
  it("validates patches and clears the model with null", () => {
    assert.deepEqual(parseSettingsPatch({ silenceMs: 6000 }, {}), { ok: false, error: "silenceMs must be between 500 and 5000" });
    const set = parseSettingsPatch({ interviewerModel: { provider: "p", id: "m" }, waitForSubmit: true }, { silenceMs: 1000 });
    assert.deepEqual(set, { ok: true, value: { silenceMs: 1000, waitForSubmit: true, interviewerModel: { provider: "p", id: "m" } } });
    assert.deepEqual(parseSettingsPatch({ interviewerModel: null }, { interviewerModel: { provider: "p", id: "m" } }), { ok: true, value: {} });
  });
  it("picks the lowest thinking level", () => {
    assert.equal(lowestThinkingLevel(["high", "low", "minimal"]), "minimal");
    assert.equal(lowestThinkingLevel(["medium", "off"]), "off");
    assert.equal(lowestThinkingLevel([]), undefined);
  });
});

describe("setup", () => {
  it("validates the start form", () => {
    assert.deepEqual(parseSetup({ topic: " DNS ", style: "coding", minutes: 30 }), { ok: true, setup: { topic: "DNS", style: "coding", minutes: 30 } });
    assert.equal(parseSetup({ topic: "", style: "coding", minutes: 30 }).ok, false);
    assert.equal(parseSetup({ topic: "x", style: "poetry", minutes: 30 }).ok, false);
    assert.equal(parseSetup({ topic: "x", style: "coding", minutes: 20 }).ok, false);
  });
});

describe("code", () => {
  it("names the file by language and attaches changed code", () => {
    assert.equal(interviewCodePath("TypeScript"), "solution.ts");
    assert.equal(interviewCodePath("cobol"), "solution.txt");
    assert.equal(codeTurnText(" said ", { language: "ts", content: "x\n\n" }), "said\n\nMy code so far:\n```ts\nx\n```");
    assert.equal(codeTurnText("", null), "");
  });
});

describe("transcript entries", () => {
  it("collapses quiet runs and hides errors", () => {
    const messages = [
      { role: "user", content: "a", timestamp: 0 },
      { role: "assistant", content: [], timestamp: 0 },
      { role: "toolResult", toolCallId: "1", toolName: "stay_quiet", isError: false, content: [], details: { kind: "quiet" }, timestamp: 0 },
      { role: "user", content: "b", timestamp: 0 },
      { role: "toolResult", toolCallId: "2", toolName: "stay_quiet", isError: false, content: [], details: { kind: "quiet" }, timestamp: 0 },
      { role: "toolResult", toolCallId: "3", toolName: "stay_quiet", isError: false, content: [], details: { kind: "quiet" }, timestamp: 0 },
      { role: "toolResult", toolCallId: "4", toolName: "probe", isError: true, content: [], details: null, timestamp: 0 },
      { role: "toolResult", toolCallId: "5", toolName: "interject", isError: false, content: [], details: { kind: "interject", text: "Hm?" }, timestamp: 0 },
    ] as unknown as AgentMessage[];
    assert.deepEqual(interviewEntries(messages), [
      { kind: "you", id: "0", text: "a" },
      { kind: "quiet", id: "2", count: 1 },
      { kind: "you", id: "3", text: "b" },
      { kind: "quiet", id: "4", count: 2 },
      { kind: "said", id: "7", label: "Interjected", text: "Hm?", accent: true },
    ]);
  });
});
