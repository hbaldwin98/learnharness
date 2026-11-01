/**
 * WHICH PRACTICE WORKSPACE MODULES ARE AVAILABLE (docs/practice-workspaces.md;
 * plan steps 1–2). The server owns the decision: the coding module is
 * registered while Docker is INSTALLED (its schema field and doctrine
 * reach the agent); whether Docker is RUNNING is checked at pose time,
 * where a stopped Docker refuses the pose with "start Docker Desktop".
 *
 * Also the container lifecycle hooks that need the record: at startup
 * (the first time Docker is seen running) every workspace container is
 * reaped; after a practice turn settles or a problem is dismissed, the
 * chat's containers other than its active coding problem are removed.
 */

import { activeProblemOf, type LhMessage } from "../core/native-messages.ts";
import { workspaceOf } from "../core/workspaces.ts";
import type { AgentWorkspaceModule } from "../agent/workspaces/registry.ts";
import { CODE_MODULE_ID, createCodeModule } from "../agent/workspaces/code/module.ts";
import type { DockerStatus } from "../agent/workspaces/code/runner.ts";
import { createDockerRunner } from "./workspaces/docker-runner.ts";
import { emit } from "../core/events.ts";
import { createDiagnosticsSession, unavailableSnapshot, type DiagnosticsSession, type DiagnosticsSnapshot } from "../agent/workspaces/code/diagnostics.ts";

type DockerRunner = ReturnType<typeof createDockerRunner>;

/** Process-wide state on globalThis: Next can load this module in more
 *  than one entry, and there must be one runner (builds, locks, idle
 *  sweep) per process. */
interface ModuleState {
	runner: DockerRunner;
	code: AgentWorkspaceModule;
	status: DockerStatus | null;
	reaped: boolean;
	/** Live language servers by problem (plan step 4). Optional so a state
	 *  object made by an older module instance (or a test) still works. */
	diagnostics?: Map<string, DiagnosticsSession>;
}
const STATE_KEY = Symbol.for("learnharness.workspaces");
function state(): ModuleState {
	const g = globalThis as unknown as Record<symbol, ModuleState | undefined>;
	let s = g[STATE_KEY];
	if (!s) {
		const runner = createDockerRunner({ onIdleRemoved: (key) => void stopDiagnostics(key.chatId, key.problemCallId) });
		s = { runner, code: createCodeModule(runner), status: null, reaped: false };
		g[STATE_KEY] = s;
	}
	return s;
}

const sessionKey = (chatId: string, problemCallId: string) => `${chatId}\0${problemCallId}`;
function sessions(): Map<string, DiagnosticsSession> {
	const s = state();
	return (s.diagnostics ??= new Map());
}

/** Stop one problem's language server (idle removal, conclude, deletion). */
async function stopDiagnostics(chatId: string, problemCallId: string): Promise<void> {
	const key = sessionKey(chatId, problemCallId);
	const session = sessions().get(key);
	if (!session) return;
	sessions().delete(key);
	await session.stop().catch(() => {});
	emit("workspace-diagnostics", { chatId, problemCallId });
}

/** Stop every language server of a chat except the kept problem's. */
function stopChatDiagnostics(chatId: string, keep: string | null): void {
	for (const key of [...sessions().keys()]) {
		const [c, p] = key.split("\0") as [string, string];
		if (c === chatId && p !== keep) void stopDiagnostics(c, p);
	}
}

/** Refresh Docker's status (cached 30 s by the runner); reap leftover
 *  containers the first time Docker is seen running. Never throws. */
export async function refreshWorkspaceAvailability(): Promise<void> {
	const s = state();
	try {
		s.status = await s.runner.status();
		if (s.status === "running" && !s.reaped) {
			s.reaped = true;
			await s.runner.reapAll();
		}
	} catch {
		s.status = s.status ?? "missing";
	}
}

/** The modules available to a practice turn (from the last refresh). */
export function availableWorkspaceModules(): readonly AgentWorkspaceModule[] {
	const s = state();
	return s.status !== null && s.status !== "missing" ? [s.code] : [];
}

/** Remove the chat's workspace containers except its active coding
 *  problem's (conclude and dismissal both end here). Fire-and-forget. */
export function reconcileWorkspaces(chatId: string, messages: readonly LhMessage[]): void {
	const s = state();
	if (s.status !== "running") return;
	const active = activeProblemOf(messages);
	const keep = active && workspaceOf(active.input)?.module === CODE_MODULE_ID ? active.toolCallId : null;
	stopChatDiagnostics(chatId, keep);
	void s.runner.retainOnly(chatId, keep).catch(() => {});
}

// ─── the learner's workspace (plan step 3) ───────────────────────────────────

import type {
	CodeDiagnostic,
	CodeFile,
	FileChange,
	NarrationEntry,
	TraceBundle,
	WorkspaceRunResult,
	WorkspaceState,
} from "../core/contracts/workspaces.ts";
import { lineDiff } from "../core/line-diff.ts";
import { PRACTICE_PROBLEM_TOOL } from "../core/native-messages.ts";
import { runCode } from "../agent/workspaces/code/runner.ts";
import type { CodePose } from "../agent/workspaces/code/module.ts";
import { deleteChatWorkspaces, getWorkspace, mutateWorkspace } from "../store/workspaces.ts";
import { stores } from "./stores.ts";

export class WorkspaceError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Saved files may total at most this (the pose limit). */
const MAX_WORKSPACE_BYTES = 256 * 1024;

/** The coding pose of a problem call in the chat, and whether it is active. */
function codeProblem(chatId: string, problemCallId: string): { pose: CodePose; active: boolean } {
	const record = stores.chatStore.getChat(chatId);
	if (!record) throw new WorkspaceError("Unknown chat", 404);
	for (const m of record.messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const block of (m as { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content) {
			if (block.type !== "toolCall" || block.name !== PRACTICE_PROBLEM_TOOL || block.id !== problemCallId) continue;
			const workspace = (block.arguments as { workspace?: unknown } | undefined)?.workspace;
			if (workspaceOf(block.arguments)?.module !== CODE_MODULE_ID) throw new WorkspaceError("Not a coding problem", 404);
			return { pose: workspace as CodePose, active: activeProblemOf(record.messages)?.toolCallId === problemCallId };
		}
	}
	throw new WorkspaceError("Unknown problem", 404);
}

/** The workspace as the UI loads it (saved files, else the starter). */
export function loadWorkspace(chatId: string, problemCallId: string): WorkspaceState {
	const { pose, active } = codeProblem(chatId, problemCallId);
	const record = getWorkspace(chatId, problemCallId);
	if (active) ensureDiagnostics(chatId, problemCallId, pose, record?.files ?? pose.files);
	return {
		language: pose.language,
		files: record?.files ?? pose.files,
		visibleTests: pose.tests.visible,
		active,
		lastRun: record?.lastRun?.result ?? null,
		lastSubmit: record?.lastSubmit?.result ?? null,
		narration: record?.narration ?? [],
	};
}

// ─── the learner trace (plan step 5) ─────────────────────────────────────────

/** One narration line may be at most this long (a long dictation run). */
const MAX_NARRATION_CHARS = 8000;
/** A bundle carries at most this many Runs (the latest) … */
const MAX_TRACE_RUNS = 5;
/** … and at most this many language-server problems (errors first). */
const MAX_TRACE_DIAGNOSTICS = 20;

/** Record a piece of narration (active problems only). Returns every line. */
export function appendNarration(chatId: string, problemCallId: string, text: unknown): NarrationEntry[] {
	const { pose, active } = codeProblem(chatId, problemCallId);
	if (!active) throw new WorkspaceError("The problem is no longer active", 409);
	if (typeof text !== "string" || text.trim().length === 0) throw new WorkspaceError("text must be non-empty", 400);
	const entry: NarrationEntry = { at: new Date().toISOString(), text: text.trim().slice(0, MAX_NARRATION_CHARS) };
	const next = mutateWorkspace(chatId, problemCallId, () => pose.files, (r) => ({ ...r, narration: [...(r.narration ?? []), entry] }));
	return next.narration ?? [];
}

/**
 * Everything since the agent last looked, and the commit that marks it
 * delivered. The caller commits only once the marker carrying it is
 * saved, so a refused send loses nothing. `files` (Submit) is the code the
 * marker carries in full: no changes section, and it becomes the code the
 * agent has seen. Null when the problem isn't a coding problem.
 */
export function pendingTrace(
	chatId: string,
	problemCallId: string,
	files?: readonly CodeFile[],
): { bundle: TraceBundle; commit: () => void } | null {
	let pose: CodePose;
	try {
		pose = codeProblem(chatId, problemCallId).pose;
	} catch {
		return null;
	}
	const record = getWorkspace(chatId, problemCallId);
	const narration = record?.narration ?? [];
	const runs = record?.runs ?? [];
	const delivered = record?.delivered ?? { narration: 0, runs: 0, files: pose.files };
	const current = files ? [...files] : (record?.files ?? pose.files);
	const bundle: TraceBundle = {
		narration: narration.slice(delivered.narration),
		runs: runs.slice(delivered.runs).slice(-MAX_TRACE_RUNS),
		changes: files ? null : codeChanges(delivered.files, current),
		diagnostics: traceDiagnostics(chatId, problemCallId),
	};
	const commit = () => {
		mutateWorkspace(chatId, problemCallId, () => pose.files, (r) => ({
			...r,
			delivered: { narration: narration.length, runs: runs.length, files: current },
		}));
	};
	return { bundle, commit };
}

/** Each file's change since `seen` (the whole file when a diff wouldn't be smaller). */
function codeChanges(seen: readonly CodeFile[], current: readonly CodeFile[]): FileChange[] {
	const before = new Map(seen.map((f) => [f.path, f.content]));
	const changes: FileChange[] = [];
	for (const f of current) {
		const diff = lineDiff(before.get(f.path) ?? "", f.content);
		if (diff === "") continue;
		if (diff === null || diff.length >= f.content.length) changes.push({ path: f.path, text: f.content, full: true });
		else changes.push({ path: f.path, text: diff });
	}
	return changes;
}

/** The live language server's problems, errors first, capped. */
function traceDiagnostics(chatId: string, problemCallId: string): CodeDiagnostic[] {
	const session = sessions().get(sessionKey(chatId, problemCallId));
	if (!session) return [];
	const snapshot = session.snapshot();
	if (snapshot.status !== "ready") return [];
	const all = Object.values(snapshot.files).flat();
	const rank = (d: CodeDiagnostic) => (d.severity === "error" ? 0 : 1);
	return all
		.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line)
		.slice(0, MAX_TRACE_DIAGNOSTICS);
}

/** Save the learner's files: contents of the starter files only (owner
 *  ruling — no add/rename/delete), size-capped, active problems only. */
export function saveWorkspace(chatId: string, problemCallId: string, files: unknown): void {
	const { pose, active } = codeProblem(chatId, problemCallId);
	if (!active) throw new WorkspaceError("The problem is no longer active", 409);
	if (!Array.isArray(files)) throw new WorkspaceError("files must be an array", 400);
	const starterPaths = new Set(pose.files.map((f) => f.path));
	const byPath = new Map<string, string>();
	for (const f of files as Array<Partial<CodeFile>>) {
		if (typeof f?.path !== "string" || typeof f.content !== "string") throw new WorkspaceError("each file needs a path and content", 400);
		if (!starterPaths.has(f.path)) throw new WorkspaceError(`not a file of this problem: ${f.path}`, 400);
		byPath.set(f.path, f.content);
	}
	const next = pose.files.map((f) => ({ path: f.path, content: byPath.get(f.path) ?? f.content }));
	const bytes = next.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
	if (bytes > MAX_WORKSPACE_BYTES) throw new WorkspaceError(`files too large (${bytes} bytes; at most ${MAX_WORKSPACE_BYTES})`, 413);
	mutateWorkspace(chatId, problemCallId, () => pose.files, (r) => ({ ...r, files: next }));
	// The saves feed the language server (plan step 4: one write path).
	sessions().get(sessionKey(chatId, problemCallId))?.update(next);
}

// ─── language-server diagnostics (plan step 4) ───────────────────────────────

/** Start the problem's language server if it isn't running (the pane's
 *  load). Fire-and-forget: Docker down = "unavailable". */
function ensureDiagnostics(chatId: string, problemCallId: string, pose: CodePose, files: readonly CodeFile[]): void {
	const key = sessionKey(chatId, problemCallId);
	if (sessions().has(key) || starting.has(key)) return;
	starting.add(key);
	void (async () => {
		try {
			// Also reaps leftovers on the first sight of a running Docker.
			await refreshWorkspaceAvailability();
			const s = state();
			if (s.status !== "running" || sessions().has(key)) return;
			const session = createDiagnosticsSession({
				runner: s.runner,
				key: { chatId, problemCallId },
				language: pose.language,
				files,
				visibleTests: pose.tests.visible,
				onChange: () => emit("workspace-diagnostics", { chatId, problemCallId }),
			});
			sessions().set(key, session);
			emit("workspace-diagnostics", { chatId, problemCallId });
		} finally {
			starting.delete(key);
		}
	})();
}
const starting = new Set<string>();

/** The latest diagnostics and server status for the pane. */
export function workspaceDiagnostics(chatId: string, problemCallId: string): DiagnosticsSnapshot {
	const { pose, active } = codeProblem(chatId, problemCallId);
	const session = sessions().get(sessionKey(chatId, problemCallId));
	if (!session || !active) return unavailableSnapshot(pose.language);
	return session.snapshot();
}

/** The learner's current files (saved, else the starter) — the thinking
 *  snapshot reads these. Null when the problem isn't a coding problem. */
export function workspaceSnapshot(chatId: string, problemCallId: string): CodeFile[] | null {
	try {
		const { pose } = codeProblem(chatId, problemCallId);
		return getWorkspace(chatId, problemCallId)?.files ?? pose.files;
	} catch {
		return null;
	}
}

/** The last Submit's files and result, for the submission marker. */
export function lastSubmission(chatId: string, problemCallId: string): { files: CodeFile[]; result: WorkspaceRunResult } | null {
	return getWorkspace(chatId, problemCallId)?.lastSubmit ?? null;
}

/** Run (visible tests) or Submit (visible + hidden, hidden as counts) the
 *  saved files. Tests come from the pose, never from the client. */
export async function runWorkspace(
	chatId: string,
	problemCallId: string,
	mode: "run" | "submit",
	signal?: AbortSignal,
): Promise<WorkspaceRunResult> {
	const { pose, active } = codeProblem(chatId, problemCallId);
	if (!active) throw new WorkspaceError("The problem is no longer active", 409);
	const s = state();
	if ((await s.runner.status()) !== "running") throw new WorkspaceError("Docker isn't running — start Docker Desktop", 503);
	const files = getWorkspace(chatId, problemCallId)?.files ?? pose.files;
	const key = { chatId, problemCallId };
	const sig = signal ? { signal } : {};
	const visibleRun = await runCode(s.runner, { key, language: pose.language, files: [...files, ...pose.tests.visible], ...sig });
	let result: WorkspaceRunResult = {
		mode,
		phase: visibleRun.phase,
		ok: visibleRun.ok,
		timedOut: visibleRun.timedOut,
		exitCode: visibleRun.exitCode,
		output: visibleRun.output,
		visible: visibleRun.tests,
		at: new Date().toISOString(),
	};
	if (mode === "submit") {
		const full = await runCode(s.runner, {
			key,
			language: pose.language,
			files: [...files, ...pose.tests.visible, ...pose.tests.hidden],
			...sig,
		});
		// Hidden = the full run's tests the visible run didn't have (language-agnostic).
		const visibleNames = new Set(visibleRun.tests.map((t) => t.name));
		const hidden = full.tests.filter((t) => !visibleNames.has(t.name));
		const built = full.phase === "test" || full.ok;
		result = {
			...result,
			ok: visibleRun.ok && full.ok,
			timedOut: visibleRun.timedOut || full.timedOut,
			...(built ? { hidden: { passed: hidden.filter((t) => t.status === "pass").length, total: hidden.length } } : {}),
		};
	}
	// A Run joins the trace (plan step 5); a Submit's result rides its own marker.
	mutateWorkspace(chatId, problemCallId, () => pose.files, (r) =>
		mode === "run" ? { ...r, lastRun: { files, result }, runs: [...(r.runs ?? []), result] } : { ...r, lastSubmit: { files, result } },
	);
	return result;
}

/** Session deletion: the chat's saved workspaces and containers. */
export function forgetChatWorkspaces(chatId: string): void {
	stopChatDiagnostics(chatId, null);
	deleteChatWorkspaces(chatId);
	const s = state();
	if (s.status === "running") void s.runner.retainOnly(chatId, null).catch(() => {});
}
