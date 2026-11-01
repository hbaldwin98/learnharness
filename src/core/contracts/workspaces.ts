/**
 * PRACTICE CODING WORKSPACE CONTRACTS (docs/practice-workspaces.md; plan
 * step 3) — the shapes the browser, the server routes and the agent layer
 * share. Browser-safe: types and pure helpers only.
 *
 * Trust: the client never sends test results or tests. It saves its files
 * (PUT), and Run/Submit/thinking read the files from the server's store
 * and the tests from the pose in the record.
 */

export interface CodeFile {
	path: string;
	content: string;
}

export type TestStatus = "pass" | "fail" | "error";

export interface TestCaseResult {
	name: string;
	status: TestStatus;
	message?: string;
}

/** One Run or Submit, as the learner sees it. */
export interface WorkspaceRunResult {
	mode: "run" | "submit";
	/** The last phase that ran. */
	phase: "build" | "test";
	/** Built, at least one test ran, every test (incl. hidden on submit) passed. */
	ok: boolean;
	timedOut: boolean;
	exitCode: number | null;
	/** Build/test output, capped. */
	output: string;
	/** The visible tests, by name. */
	visible: TestCaseResult[];
	/** Submit only: the hidden tests as counts (contents stay hidden until conclusion). */
	hidden?: { passed: number; total: number };
	at: string;
}

/** What the workspace UI loads (GET). */
export interface WorkspaceState {
	language: string;
	/** The learner's files (the saved ones, else the starter). */
	files: CodeFile[];
	/** The visible tests, shown read-only. */
	visibleTests: CodeFile[];
	/** False once the problem is concluded or dismissed (read-only view). */
	active: boolean;
	lastRun: WorkspaceRunResult | null;
	lastSubmit: WorkspaceRunResult | null;
}

/** The submission marker's details (transcript card + model text). */
export interface SubmissionDetails {
	problemCallId: string;
	files: CodeFile[];
	result: WorkspaceRunResult;
}

/** Fence a file for model-facing text (language from the extension). */
export function fenceFile(file: CodeFile): string {
	const ext = /\.([A-Za-z0-9]+)$/.exec(file.path)?.[1] ?? "";
	const fence = file.content.includes("```") ? "````" : "```";
	return `${file.path}:\n${fence}${ext}\n${file.content}${file.content.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** A run result as model-facing text. */
export function describeRunResult(result: WorkspaceRunResult): string {
	const lines: string[] = [];
	if (result.phase === "build" && !result.ok) lines.push(`Build failed${result.timedOut ? " (timed out)" : ""}.`);
	else {
		const passed = result.visible.filter((t) => t.status === "pass").length;
		lines.push(`Visible tests: ${passed}/${result.visible.length} passed${result.timedOut ? " (timed out)" : ""}.`);
		if (result.hidden) lines.push(`Hidden tests: ${result.hidden.passed}/${result.hidden.total} passed.`);
		for (const t of result.visible.filter((x) => x.status !== "pass")) lines.push(`✗ ${t.name}${t.message ? `: ${t.message}` : ""}`);
	}
	if (!result.ok && result.output && (result.phase === "build" || result.visible.length === 0)) lines.push("Output:\n" + result.output);
	return lines.join("\n");
}
