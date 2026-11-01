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

type DockerRunner = ReturnType<typeof createDockerRunner>;

/** Process-wide state on globalThis: Next can load this module in more
 *  than one entry, and there must be one runner (builds, locks, idle
 *  sweep) per process. */
interface ModuleState {
	runner: DockerRunner;
	code: AgentWorkspaceModule;
	status: DockerStatus | null;
	reaped: boolean;
}
const STATE_KEY = Symbol.for("learnharness.workspaces");
function state(): ModuleState {
	const g = globalThis as unknown as Record<symbol, ModuleState | undefined>;
	let s = g[STATE_KEY];
	if (!s) {
		const runner = createDockerRunner();
		s = { runner, code: createCodeModule(runner), status: null, reaped: false };
		g[STATE_KEY] = s;
	}
	return s;
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
	void s.runner.retainOnly(chatId, keep).catch(() => {});
}

// ─── the learner's workspace (plan step 3) ───────────────────────────────────

import type { CodeFile, WorkspaceRunResult, WorkspaceState } from "../core/contracts/workspaces.ts";
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
	return {
		language: pose.language,
		files: record?.files ?? pose.files,
		visibleTests: pose.tests.visible,
		active,
		lastRun: record?.lastRun?.result ?? null,
		lastSubmit: record?.lastSubmit?.result ?? null,
	};
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
	mutateWorkspace(chatId, problemCallId, () => pose.files, (r) => (mode === "run" ? { ...r, lastRun: { files, result } } : { ...r, lastSubmit: { files, result } }));
	return result;
}

/** Session deletion: the chat's saved workspaces and containers. */
export function forgetChatWorkspaces(chatId: string): void {
	deleteChatWorkspaces(chatId);
	const s = state();
	if (s.status === "running") void s.runner.retainOnly(chatId, null).catch(() => {});
}
