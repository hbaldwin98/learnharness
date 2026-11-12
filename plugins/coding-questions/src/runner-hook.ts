import type { CodingTestResult, CodingTests } from "./test-result.ts";

/**
 * Optional execution hook for other trusted plugins in the same server process
 * (for example a sandboxed runner). Plugins share no host service registry, so
 * the hook is a versioned, process-global registry keyed by a well-known
 * symbol. Without a registered runner, tests run locally exactly as before.
 */
export const CODING_RUNNER_REGISTRY = Symbol.for("learnharness.coding-questions.runners.v1");

export type CodingRunPurpose = "grade" | "submission" | "run";

export interface CodingRunRequest {
  readonly purpose: CodingRunPurpose;
  readonly chatId: string;
  /** Question or problem ID (a single safe path segment). */
  readonly itemId: string;
  readonly language: string;
  readonly answer: string;
  readonly tests: CodingTests;
  readonly signal?: AbortSignal;
}

/** `unavailable`: the runner declines (for example its sandbox is down); the
 * caller falls back to local execution and records a visible notice. */
export type CodingRunnerOutcome = { result: CodingTestResult } | { unavailable: string };

export interface CodingRunner {
  readonly id: string;
  run(request: CodingRunRequest): Promise<CodingRunnerOutcome>;
}

export interface CodingRunnerRegistry {
  readonly version: 1;
  register(runner: CodingRunner): () => void;
  current(): CodingRunner | undefined;
}

export function codingRunnerRegistry(scope: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>): CodingRunnerRegistry {
  const existing = scope[CODING_RUNNER_REGISTRY] as CodingRunnerRegistry | undefined;
  if (existing?.version === 1) return existing;
  const runners: CodingRunner[] = [];
  const registry: CodingRunnerRegistry = {
    version: 1,
    register(runner) {
      if (!runner || typeof runner.id !== "string" || typeof runner.run !== "function") throw new Error("Coding runner must have an id and run()");
      runners.push(runner);
      return () => { const index = runners.indexOf(runner); if (index >= 0) runners.splice(index, 1); };
    },
    current: () => runners.at(-1),
  };
  scope[CODING_RUNNER_REGISTRY] = registry;
  return registry;
}

export const LOCAL_FALLBACK_NOTICE = "Tests ran locally (no sandbox)";

/** Use the registered runner when there is one; otherwise, or when it declines, run locally. */
export async function runWithHook(
  request: CodingRunRequest,
  local: () => Promise<CodingTestResult>,
  registry: CodingRunnerRegistry = codingRunnerRegistry(),
): Promise<CodingTestResult> {
  const runner = registry.current();
  if (!runner) return local();
  const outcome = await runner.run(request);
  if ("result" in outcome) return outcome.result;
  const result = await local();
  return { ...result, notice: `${LOCAL_FALLBACK_NOTICE}: ${outcome.unavailable}` };
}
