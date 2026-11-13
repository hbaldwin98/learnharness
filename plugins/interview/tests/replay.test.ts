import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runReplay, turnsFromChunks, type ReplayFixture } from "../src/replay.ts";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/narration-web-request.json"), "utf8")) as ReplayFixture;

describe("turnsFromChunks", () => {
  it("joins speech across short gaps and splits on the silence window", () => {
    assert.deepEqual(turnsFromChunks([{ atMs: 0, text: "one" }, { atMs: 500, text: "two" }, { atMs: 3000, text: "three" }], { silenceMs: 1500, waitForSubmit: false }), ["one two", "three"]);
  });

  it("wait-for-submit sends everything as one turn", () => {
    assert.equal(turnsFromChunks(fixture.chunks, { silenceMs: 1500, waitForSubmit: true }).length, 1);
  });

  it("the narration fixture splits where the speaker paused", () => {
    assert.deepEqual(turnsFromChunks(fixture.chunks, fixture.listening), [
      "I'm ready, let's begin.",
      "Okay so first the browser parses the URL and checks whether it already has a cached copy.",
      "If not it needs the IP address, so it does a DNS lookup. That goes to the resolver, then the root, the TLD, and the authoritative server.",
      "Then it opens a connection to the server",
      "and sends the HTTP GET request, and the server sends back HTML which the browser renders.",
      "My answer: UDP on port 53, falling back to TCP for large replies",
      "The browser caches responses based on Cache-Control headers, and a CDN can cache in between.",
      "I think that's everything.",
    ]);
  });
});

describe("runReplay", () => {
  it("records one interviewer decision per turn and applies its effects", async () => {
    let n = 0;
    const call = (name: string, args: unknown): FauxResponseStep => () =>
      fauxAssistantMessage([fauxToolCall(name, args as ToolCall["arguments"], { id: `${name}-${++n}` })], { stopReason: "toolUse" });
    const faux = createFauxCore({});
    faux.setResponses([call("advance", {}), call("stay_quiet", {}), call("probe", { text: "Which transport?" })]);
    const { decisions, state } = await runReplay({
      setup: fixture.setup, script: fixture.script!, turns: ["ready", "DNS first…", "then resolvers"],
      engine: { model: faux.getModel(), streamFn: faux.streamSimple },
    });
    assert.deepEqual(decisions.map((d) => d.tool), ["advance", "stay_quiet", "probe"]);
    assert.equal((decisions[2]!.details as { questionId: string }).questionId, "q1");
    assert.equal(state.currentQuestionId, "q1");
  });
});
