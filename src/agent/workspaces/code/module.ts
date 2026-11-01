/**
 * THE CODING WORKSPACE MODULE (docs/practice-workspaces.md; plan step 2).
 * A coding pose commits starter files, visible and hidden tests, and a
 * runnable reference solution. It goes through only after the app has
 * (1) built the language image if needed, (2) run every test against the
 * reference — all must pass — and (3) built the starter with the visible
 * tests. The problem's container stays warm for later runs; a refused
 * pose removes it.
 */

import { Type } from "typebox";
import { annotateTool, type AnnotateHandler } from "./annotate.ts";
import type { AgentWorkspaceModule, WorkspacePoseContext } from "../registry.ts";
import { CODE_LANGUAGES, LANGUAGES, layoutSummary, type CodeFile, type CodeLanguage } from "./languages.ts";
import { AGENT_OUTPUT_CAP_BYTES, capOutput, runCode, type CodeRunner, type CodeRunResult } from "./runner.ts";

export const CODE_MODULE_ID = "code";

const fileList = (description: string) =>
	Type.Array(
		Type.Object({
			path: Type.String({ description: "Relative path, forward slashes (e.g. solution.py, src/lib.rs)." }),
			content: Type.String({ description: "The full file content." }),
		}),
		{ minItems: 1, description },
	);

export const codePoseSchema = Type.Object({
	language: Type.Union(
		CODE_LANGUAGES.map((l) => Type.Literal(l)),
		{ description: `REQUIRED — the language. File layout per language (project files are provided; never write them): ${layoutSummary()}` },
	),
	files: fileList(
		"REQUIRED — the starter files the learner sees and edits. They must build together with the visible tests (stub bodies, not missing functions); the tests may fail.",
	),
	tests: Type.Object(
		{
			visible: fileList("REQUIRED — test files the learner can see and run."),
			hidden: fileList("REQUIRED — test files run only on submit; revealed at conclusion."),
		},
		{ description: "REQUIRED — the tests, in the language's test framework." },
	),
	reference: fileList(
		"REQUIRED — your reference solution: files replacing starter files by path (or added). Every visible and hidden test must pass against it, or the pose is refused.",
	),
});

/** The pose fields (the schema's static type, with the language narrowed). */
export interface CodePose {
	language: CodeLanguage;
	files: CodeFile[];
	tests: { visible: CodeFile[]; hidden: CodeFile[] };
	reference: CodeFile[];
}

/** Limits that keep a pose (and the tar stream) small and sane. */
const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_PATH = 100;

/** Pure structural validation: correctable error lines ([] = valid). */
export function validateCodePose(pose: CodePose): string[] {
	const spec = Object.hasOwn(LANGUAGES, pose.language) ? LANGUAGES[pose.language] : undefined;
	if (!spec) return [`language must be one of ${CODE_LANGUAGES.join(", ")}`];
	const errors: string[] = [];
	const check = (set: string, files: readonly CodeFile[], kind: "source" | "test") => {
		const seen = new Set<string>();
		for (const f of files) {
			const where = `${set} "${f.path}"`;
			if (seen.has(f.path)) errors.push(`${where}: duplicate path`);
			seen.add(f.path);
			if (f.path.length > MAX_PATH) errors.push(`${where}: path longer than ${MAX_PATH} characters`);
			if (spec.scaffold.includes(f.path)) errors.push(`${where}: this project file is provided by the app — do not write it`);
			else if (kind === "test" && !spec.testFile.test(f.path)) errors.push(`${where}: not a ${spec.label} test file — ${spec.layout}`);
			else if (kind === "source" && (!spec.sourceFile.test(f.path) || spec.testFile.test(f.path)))
				errors.push(`${where}: not a ${spec.label} source file — ${spec.layout}`);
		}
	};
	check("files", pose.files, "source");
	check("reference", pose.reference, "source");
	check("tests.visible", pose.tests.visible, "test");
	check("tests.hidden", pose.tests.hidden, "test");
	const visible = new Set(pose.tests.visible.map((f) => f.path));
	for (const f of pose.tests.hidden) if (visible.has(f.path)) errors.push(`tests.hidden "${f.path}": also a visible test path — use distinct files`);
	const all = [...pose.files, ...pose.reference, ...pose.tests.visible, ...pose.tests.hidden];
	if (all.length > MAX_FILES) errors.push(`too many files (${all.length}; at most ${MAX_FILES})`);
	const bytes = all.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
	if (bytes > MAX_TOTAL_BYTES) errors.push(`files too large (${bytes} bytes; at most ${MAX_TOTAL_BYTES})`);
	return errors;
}

/** Starter files overlaid by reference files (by path). */
export function overlay(base: readonly CodeFile[], over: readonly CodeFile[]): CodeFile[] {
	const byPath = new Map(base.map((f) => [f.path, f]));
	for (const f of over) byPath.set(f.path, f);
	return [...byPath.values()];
}

/** A run's failure, for the agent (capped). */
function describeFailure(heading: string, result: CodeRunResult): string {
	const failing = result.tests.filter((t) => t.status !== "pass");
	const lines = [heading];
	if (result.timedOut) lines.push(`(${result.phase} timed out)`);
	if (result.phase === "test" && result.tests.length === 0 && !result.timedOut) lines.push("no tests ran");
	for (const t of failing) lines.push(`✗ ${t.name}${t.message ? `: ${t.message}` : ""}`);
	if (failing.length === 0 && result.output) lines.push(result.output);
	return capOutput(lines.join("\n"), AGENT_OUTPUT_CAP_BYTES);
}

/** What the server lends the module's tools (plan step 7). */
export interface CodeModuleHooks {
	annotate?: AnnotateHandler;
}

export function createCodeModule(runner: CodeRunner, hooks: CodeModuleHooks = {}): AgentWorkspaceModule {
	return {
		id: CODE_MODULE_ID,
		...(hooks.annotate ? { tools: ({ chatId }: { chatId: string }) => ({ annotate: annotateTool(chatId, hooks.annotate!) }) } : {}),
		poseSchema: codePoseSchema,
		async verifyPose(workspace: unknown, ctx: WorkspacePoseContext): Promise<string[]> {
			const pose = workspace as CodePose;
			const structural = validateCodePose(pose);
			if (structural.length > 0) return structural;

			const status = await runner.status();
			if (status === "missing") return ["Docker isn't installed — coding problems are unavailable; pose an ordinary problem"];
			if (status === "stopped") return ["Docker isn't running — ask the learner to start Docker Desktop, then pose again"];

			const spec = LANGUAGES[pose.language];
			const image = await runner.ensureImage(spec.image, ctx.onProgress, ctx.signal);
			if (!image.ok) return [capOutput(`the ${spec.label} environment failed to build:\n${image.output}`, AGENT_OUTPUT_CAP_BYTES)];

			const key = { chatId: ctx.chatId, problemCallId: ctx.problemCallId };
			const signal = ctx.signal ? { signal: ctx.signal } : {};
			try {
				ctx.onProgress?.("checking the reference solution against every test");
				const reference = await runCode(runner, {
					key,
					language: pose.language,
					files: [...overlay(pose.files, pose.reference), ...pose.tests.visible, ...pose.tests.hidden],
					...signal,
				});
				if (!reference.ok) {
					await runner.remove(key);
					return [describeFailure("the reference solution does not pass every test:", reference)];
				}
				ctx.onProgress?.("checking that the starter builds");
				const starter = await runCode(runner, {
					key,
					language: pose.language,
					files: [...pose.files, ...pose.tests.visible],
					buildOnly: true,
					...signal,
				});
				if (!starter.ok) {
					await runner.remove(key);
					return [describeFailure("the starter files do not build with the visible tests:", starter)];
				}
				return [];
			} catch (error) {
				await runner.remove(key).catch(() => {});
				if (ctx.signal?.aborted) throw error;
				return [`running the checks failed: ${error instanceof Error ? error.message : String(error)}`];
			}
		},
	};
}
