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
	/** Every recorded narration line for this problem (plan step 5). */
	narration: NarrationEntry[];
}

/** The submission marker's details (transcript card + model text). */
export interface SubmissionDetails {
	problemCallId: string;
	files: CodeFile[];
	result: WorkspaceRunResult;
	/** What happened since the agent last looked (plan step 5). */
	trace?: TraceBundle;
}

/** The listening marker's details (plan step 6). */
export interface ListenDetails {
	problemCallId: string;
	cues: import("../listening.ts").ListenCue[];
	trace?: TraceBundle;
}

/** The ask marker's details (plan step 5). */
export interface AskDetails {
	problemCallId: string;
	/** The learner's request; "" for a wordless Ask. */
	text: string;
	trace?: TraceBundle;
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

// ─── the learner trace (plan step 5) ─────────────────────────────────────────

/** One recorded piece of narration (typed or dictated), timestamped. */
export interface NarrationEntry {
	at: string;
	text: string;
}

/** One file's change since the code the agent last saw. */
export interface FileChange {
	path: string;
	/** Unified hunks, or the whole file when `full`. */
	text: string;
	full?: boolean;
}

/**
 * Everything since the agent last looked, delivered once with an Ask, a
 * Submit or a thinking message (owner ruling: one bundle per delivery).
 */
export interface TraceBundle {
	narration: NarrationEntry[];
	/** The Runs since the last delivery, as the learner saw them. */
	runs: WorkspaceRunResult[];
	/** The code changes, or null when the marker carries the full code. */
	changes: FileChange[] | null;
	/** Current language-server errors and warnings (capped). */
	diagnostics: CodeDiagnostic[];
}

/** A wall-clock time for model text and the strip ("14:03"). */
export function clockTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Is there nothing in the bundle worth a section? */
export function traceIsEmpty(t: TraceBundle): boolean {
	return t.narration.length === 0 && t.runs.length === 0 && (t.changes?.length ?? 0) === 0 && t.diagnostics.length === 0;
}

/** The bundle as model-facing text ("" when there is nothing to say). */
export function describeTrace(t: TraceBundle): string {
	const parts: string[] = [];
	if (t.narration.length > 0) {
		parts.push(
			"Their narration since you last looked (thinking aloud, often dictated):\n" +
				t.narration.map((n) => `[${clockTime(n.at)}] ${n.text}`).join("\n"),
		);
	}
	for (const r of t.runs) parts.push(`They ran the visible tests at ${clockTime(r.at)}:\n${describeRunResult(r)}`);
	if (t.changes !== null) {
		if (t.changes.length === 0) parts.push("Their code is unchanged since you last saw it.");
		else {
			parts.push(
				"Their code changes since you last saw it:\n" +
					t.changes
						.map((c) => (c.full ? fenceFile({ path: c.path, content: c.text }) : `${c.path}:\n\`\`\`diff\n${c.text}\n\`\`\``))
						.join("\n\n"),
			);
		}
	}
	if (t.diagnostics.length > 0) {
		parts.push(
			"The editor currently shows these language-server problems:\n" +
				t.diagnostics.map((d) => `${d.path}:${d.line + 1}:${d.column + 1} ${d.severity}: ${d.message}`).join("\n"),
		);
	}
	return parts.join("\n\n");
}

// ─── language-server diagnostics (plan step 4) ───────────────────────────────

/** One error or warning, 0-based positions (LSP lines and UTF-16 columns). */
export interface CodeDiagnostic {
	path: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning";
	message: string;
	source?: string;
}

export type DiagnosticsStatus = "starting" | "ready" | "crashed" | "unavailable";

/** What the pane fetches (GET …/diagnostics). */
export interface DiagnosticsSnapshot {
	status: DiagnosticsStatus;
	/** "Python", "C#", … for the status line. */
	name: string;
	/** Errors and warnings by file (learner files and visible tests only). */
	files: Record<string, CodeDiagnostic[]>;
}
