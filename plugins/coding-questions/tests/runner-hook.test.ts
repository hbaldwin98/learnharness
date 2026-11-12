import assert from "node:assert/strict";
import { test } from "node:test";
import { codingRunnerRegistry, runWithHook, type CodingRunRequest } from "../src/runner-hook.ts";
import { readTestResult, type CodingTestResult } from "../src/test-result.ts";

const passed: CodingTestResult = { status: "passed", exitCode: 0, stdout: "local", stderr: "", stdoutTruncated: false, stderrTruncated: false };
const request: CodingRunRequest = { purpose: "submission", chatId: "c", itemId: "p", language: "python", answer: "x", tests: { program: "python3", args: ["-"], code: "" } };

test("without a registered runner, tests run locally with no notice", async () => {
  const registry = codingRunnerRegistry({});
  assert.deepEqual(await runWithHook(request, async () => passed, registry), passed);
});

test("a registered runner's result replaces local execution", async () => {
  const registry = codingRunnerRegistry({});
  const seen: CodingRunRequest[] = [];
  registry.register({ id: "sandbox", async run(r) { seen.push(r); return { result: { ...passed, stdout: "sandbox" } }; } });
  let local = 0;
  const result = await runWithHook(request, async () => { local++; return passed; }, registry);
  assert.equal(result.stdout, "sandbox");
  assert.equal(local, 0);
  assert.equal(seen[0]?.purpose, "submission");
});

test("a declining runner falls back to local execution with a visible notice", async () => {
  const registry = codingRunnerRegistry({});
  const unregister = registry.register({ id: "sandbox", async run() { return { unavailable: "Docker is not running" }; } });
  const result = await runWithHook(request, async () => passed, registry);
  assert.equal(result.stdout, "local");
  assert.equal(result.notice, "Tests ran locally (no sandbox): Docker is not running");
  assert.ok(readTestResult(result));
  unregister();
  assert.equal(registry.current(), undefined);
});

test("the registry is shared through its well-known symbol", () => {
  const scope = {};
  assert.equal(codingRunnerRegistry(scope), codingRunnerRegistry(scope));
});

test("saved results reject a non-string notice", () => {
  assert.equal(readTestResult({ ...passed, notice: 3 }), null);
});
