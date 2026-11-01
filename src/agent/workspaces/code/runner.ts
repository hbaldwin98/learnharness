/**
 * THE CODE RUNNER PORT (plan step 2). The agent layer may not import the
 * server, so the coding module talks to Docker through this interface;
 * src/server/workspaces/docker-runner.ts implements it with the docker
 * CLI and tests use a fake. `runCode` turns a language + files into the
 * normalized result every later step consumes (UI, trace, verification).
 */

import { LANGUAGES, type CodeFile, type CodeImage, type CodeLanguage, type TestCaseResult } from "./languages.ts";

export type DockerStatus = "missing" | "stopped" | "running";

/** Which problem a container belongs to. */
export interface ProblemKey {
	chatId: string;
	problemCallId: string;
}

export interface RunStep {
	phase: "build" | "test";
	command: string;
	timeoutMs: number;
}

export interface StepOutcome {
	phase: "build" | "test";
	exitCode: number | null;
	timedOut: boolean;
	/** stdout + stderr, capped (64 KB). */
	output: string;
}

export interface RunOutcome {
	/** The steps that ran — a failing build step stops the run. */
	steps: StepOutcome[];
	/** The report file's contents, or the last test step's stdout when the
	 *  language reports on stdout; null when absent. */
	report: string | null;
}

export type ImageResult = { ok: true } | { ok: false; output: string };

export interface CodeRunner {
	status(): Promise<DockerStatus>;
	/** Build the image if missing (progress lines via onProgress). */
	ensureImage(image: CodeImage, onProgress?: (line: string) => void, signal?: AbortSignal): Promise<ImageResult>;
	/** Run steps over files in the problem's warm container (started if needed). */
	run(request: {
		key: ProblemKey;
		image: CodeImage;
		files: readonly CodeFile[];
		steps: readonly RunStep[];
		report: string | null;
		signal?: AbortSignal;
	}): Promise<RunOutcome>;
	/** Remove the problem's container. */
	remove(key: ProblemKey): Promise<void>;
	/** Write files into a directory of the problem's container (created,
	 *  with the image's scaffold, when `fresh`). Plan step 4: the language
	 *  server's /work/lsp. Counts as activity for the idle sweep. */
	writeFiles(request: { key: ProblemKey; image: CodeImage; dir: string; files: readonly CodeFile[]; fresh?: boolean }): Promise<void>;
	/** Start a long-lived process in the problem's container with its
	 *  stdio piped (plan step 4: the language server). It ends when its
	 *  stdin closes, when it exits, or with the container. */
	spawn(request: { key: ProblemKey; image: CodeImage; command: string; workingDir: string }): Promise<SpawnedProcess>;
}

export interface SpawnedProcess {
	stdin: import("node:stream").Writable;
	stdout: import("node:stream").Readable;
	/** Resolves when the process's streams end. */
	exited: Promise<void>;
	/** Close its stdio (the process normally exits on EOF). */
	kill(): void;
}

/** Limits (owner-ruled): 60 s per build, 10 s per test run. */
export const BUILD_TIMEOUT_MS = 60_000;
export const TEST_TIMEOUT_MS = 10_000;
/** Output shown to the learner / sent to the agent (owner-ruled). */
export const OUTPUT_CAP_BYTES = 64 * 1024;
export const AGENT_OUTPUT_CAP_BYTES = 8 * 1024;

/** The normalized result of one run. */
export interface CodeRunResult {
	/** The last phase that ran. */
	phase: "build" | "test";
	/** Built, at least one test ran, and every test passed. */
	ok: boolean;
	timedOut: boolean;
	exitCode: number | null;
	output: string;
	tests: TestCaseResult[];
}

/** Build (and, unless buildOnly, test) the given files. */
export async function runCode(
	runner: CodeRunner,
	request: { key: ProblemKey; language: CodeLanguage; files: readonly CodeFile[]; buildOnly?: boolean; signal?: AbortSignal },
): Promise<CodeRunResult> {
	const spec = LANGUAGES[request.language];
	const steps: RunStep[] = [{ phase: "build", command: spec.build, timeoutMs: BUILD_TIMEOUT_MS }];
	if (!request.buildOnly) steps.push({ phase: "test", command: spec.test, timeoutMs: TEST_TIMEOUT_MS });
	const outcome = await runner.run({
		key: request.key,
		image: spec.image,
		files: request.files,
		steps,
		report: request.buildOnly ? null : spec.report,
		...(request.signal ? { signal: request.signal } : {}),
	});
	const last = outcome.steps.at(-1) ?? { phase: "build" as const, exitCode: null, timedOut: false, output: "" };
	const built = outcome.steps[0] !== undefined && outcome.steps[0].exitCode === 0 && !outcome.steps[0].timedOut;
	const tests = last.phase === "test" && outcome.report ? spec.parse(outcome.report) : [];
	const ok = request.buildOnly
		? built
		: built && !last.timedOut && tests.length > 0 && tests.every((t) => t.status === "pass");
	return {
		phase: last.phase,
		ok,
		timedOut: last.timedOut,
		exitCode: last.exitCode,
		output: outcome.steps.map((s) => s.output).join("\n").trim(),
		tests,
	};
}

/** Keep the END of long output (the error is usually last), within a byte cap. */
export function capOutput(text: string, capBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= capBytes) return text;
	const tail = Buffer.from(text, "utf8").subarray(bytes - capBytes).toString("utf8");
	return `… (${bytes - capBytes} bytes truncated)\n${tail.replace(/^�+/, "")}`;
}
