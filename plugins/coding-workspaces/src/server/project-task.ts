/**
 * PROJECT TASKS: a practice problem type graded against the learner's whole project
 * workspace. The practice agent poses a task ("add a /health route") with a test
 * command and optional hidden test files; the learner builds it in their own editor
 * and submits "the project as it is now". Processing snapshots the folder, runs the
 * tests in the project's container, and returns observations (never a verdict) —
 * only the native `conclude` assesses and closes the task.
 */

import { Type, type Static } from "typebox";
import type { PluginBackendContext } from "learnharness-plugin-api";
import type { ProjectInfo } from "../shared/protocol.ts";
import type { ExecResult } from "./docker-runner.ts";

export const PROJECT_TASK_TYPE = "project-task";
export const PROJECT_TASK_TOOL = "project_task";
const MAX_TEST_FILES = 20;
const MAX_TEST_BYTES = 256 * 1024;

export const projectTaskSchema = Type.Object({
	tests: Type.Object({
		command: Type.String({ minLength: 1, description: "Shell command run in /work (the project root) that exits 0 only when the task is done, e.g. `npm test -- --run` or `python3 -m pytest -q $LH_TESTS`." }),
		files: Type.Optional(Type.Array(Type.Object({
			path: Type.String({ minLength: 1, description: "Relative path under $LH_TESTS (a temporary folder outside the project)." }),
			content: Type.String(),
		}), { description: "Hidden test files, written to $LH_TESTS for the run only; the learner's folder is never touched." })),
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 600 })),
	}),
});
export type ProjectTaskPayload = Static<typeof projectTaskSchema>;

/** The submission names the project being submitted (the session's attached project). */
export const projectTaskSubmissionSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) });

export type ProjectTaskResult = {
	projectId: string;
	projectName: string;
	/** The snapshot commit the tests ran against (null without git). */
	snapshot: string | null;
	/** `git diff --stat` since the tutor's last look in this chat. */
	changes: string;
	command: string;
	status: "passed" | "failed" | "error";
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
};

export function validateTaskPayload(payload: ProjectTaskPayload): string[] {
	const errors: string[] = [];
	const files = payload.tests.files ?? [];
	if (!payload.tests.command.trim()) errors.push("tests.command must not be blank");
	if (files.length > MAX_TEST_FILES) errors.push(`at most ${MAX_TEST_FILES} test files`);
	if (files.reduce((n, f) => n + f.content.length, 0) > MAX_TEST_BYTES) errors.push("test files are too large");
	for (const f of files) {
		const p = f.path.replace(/\\/g, "/");
		if (p.startsWith("/") || p.split("/").includes("..") || /^[a-zA-Z]:/.test(p)) errors.push(`test file path must be relative: ${f.path}`);
	}
	return errors;
}

export const PROJECT_TASK_INSTRUCTIONS = [
	"# Project tasks",
	`When the learner has a project workspace attached, you can pose ${PROJECT_TASK_TOOL}: a task they build in their project (a feature, a fix, a refactor) instead of a single-file exercise. ` +
		"The tests run in the project's container from /work against the whole project; put hidden tests in tests.files (available at $LH_TESTS during the run only) or use the project's own test command. " +
		"Read the project first (project_files, project_read) so the task fits what exists. Size each task to one sitting and one clear behaviour.",
	"Submission results are observations: read the run output and the changes, then conclude when you have enough evidence.",
].join("\n");

export interface ProjectTaskDeps {
	forChat(chatId: string): ProjectInfo | null;
	snapshot(project: ProjectInfo, reason: string): Promise<string | null>;
	changesStat(chatId: string, project: ProjectInfo): Promise<string>;
	runTask(project: ProjectInfo, input: { command: string; files: Array<{ path: string; content: string }>; signal: AbortSignal; timeoutMs?: number }): Promise<ExecResult>;
}

export function registerProjectTask(ctx: PluginBackendContext, deps: ProjectTaskDeps): () => void {
	return ctx.registerProblemType({
		id: PROJECT_TASK_TYPE,
		label: "Project task",
		contractVersion: 1,
		tool: {
			toolName: PROJECT_TASK_TOOL,
			description: "Pose a task the learner builds in their attached project workspace, graded by running tests against the whole project in its container. Only when a project workspace is attached to this session.",
		},
		problemSchema: projectTaskSchema,
		submissionSchema: projectTaskSubmissionSchema,
		validateProblem(context) {
			const errors = validateTaskPayload(context.input.payload);
			if (!deps.forChat(context.chatId)) errors.push("this session has no project workspace attached; the learner can attach one in the Coding pane");
			return errors;
		},
		validateSubmission(context) {
			const project = deps.forChat(context.chatId);
			if (!project) return ["Attach a project workspace in the Coding pane first"];
			if (project.id !== context.submission.projectId) return ["The attached project changed; submit again"];
			return undefined;
		},
		async processSubmission(context): Promise<ProjectTaskResult> {
			const project = deps.forChat(context.chatId);
			if (!project || project.id !== context.submission.projectId) throw new Error("The submitted project is no longer attached");
			const tests = context.input.payload.tests;
			const snapshot = await deps.snapshot(project, `task submission ${context.problemId}`);
			const changes = await deps.changesStat(context.chatId, project);
			const r = await deps.runTask(project, {
				command: tests.command,
				files: tests.files ?? [],
				signal: context.signal,
				...(tests.timeoutSeconds ? { timeoutMs: tests.timeoutSeconds * 1000 } : {}),
			});
			const status = r.timedOut || r.code === null ? "error" : r.code === 0 ? "passed" : "failed";
			return {
				projectId: project.id, projectName: project.name, snapshot, changes, command: tests.command,
				status, exitCode: r.code, timedOut: r.timedOut,
				stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stderrTruncated: r.stderrTruncated,
			};
		},
	});
}
