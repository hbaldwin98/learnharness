/**
 * PRACTICE CODING WORKSPACE — the teacher's coding exercise
 * (docs/practice-workspaces-plan.md, step 9): the open-exercise fold, the
 * skip input, the tool's gate and verification, the registry toggle, and
 * the projection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	activeExerciseOf,
	activeWorkspaceOf,
	newSubmissionMessage,
	newExerciseSkippedMessage,
	nativeInputCause,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { inputAppends, parseChatInput, ChatInputError } from "../src/core/input-events.ts";
import { codingExerciseTool } from "../src/agent/tools/coding-exercise.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { projectView } from "../src/core/view.ts";
import { composeCodingExercises } from "../components/settings/coding-section.tsx";
import { Type } from "typebox";

const POSE = {
	module: "code",
	language: "python",
	files: [{ path: "solution.py", content: "def rev(xs):\n    return xs\n" }],
	tests: { visible: [{ path: "test_v.py", content: "" }], hidden: [] },
	reference: [{ path: "solution.py", content: "def rev(xs):\n    return xs[::-1]\n" }],
};
const ARGS = { statement: "Reverse a list.", workspace: POSE };

const call = (id: string, name = "coding_exercise", args: unknown = ARGS): LhMessage =>
	({ id: `a_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 1 }) as unknown as LhMessage;
const result = (id: string, isError = false): LhMessage =>
	({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: "coding_exercise", content: [{ type: "text", text: "ok" }], isError, timestamp: 2 }) as unknown as LhMessage;
const submission = (id: string): LhMessage =>
	newSubmissionMessage({
		problemCallId: id,
		files: POSE.files,
		result: { phase: "test", ok: false, visible: [], hidden: null } as never,
	});

const codeModule = {
	id: "code",
	poseSchema: Type.Object({ language: Type.String() }),
	verifyPose: async (w: unknown) => ((w as { language?: string }).language === "cobol" ? ["language must be one of …"] : []),
	tools: () => ({ annotate: { name: "annotate" } }),
} as never;

describe("the open coding exercise", () => {
	it("opens on a clean call and closes on a Submit or a skip", () => {
		const posed = [call("x1"), result("x1")];
		assert.equal(activeExerciseOf(posed)?.toolCallId, "x1");
		assert.equal(activeWorkspaceOf(posed)?.toolCallId, "x1");
		assert.equal(activeExerciseOf([...posed, submission("x1")]), null);
		assert.equal(activeExerciseOf([...posed, newExerciseSkippedMessage("x1")]), null);
	});

	it("ignores a refused pose, and only the newest exercise counts", () => {
		assert.equal(activeExerciseOf([call("x1"), result("x1", true)]), null);
		const two = [call("x1"), result("x1"), newExerciseSkippedMessage("x1"), call("x2"), result("x2")];
		assert.equal(activeExerciseOf(two)?.toolCallId, "x2");
	});

	it("a skip is a learner input", () => {
		assert.equal(nativeInputCause(newExerciseSkippedMessage("x1") as never, []), "learner");
	});
});

describe("the skip input", () => {
	it("parses, and appends the marker only for the open exercise", () => {
		assert.deepEqual(parseChatInput({ type: "exercise-skip", problemCallId: "x1" }), { type: "exercise-skip", problemCallId: "x1" });
		assert.throws(() => parseChatInput({ type: "exercise-skip" }), ChatInputError);
		const record = { messages: [call("x1"), result("x1")] };
		const [marker] = inputAppends(record, { type: "exercise-skip", problemCallId: "x1" });
		assert.equal((marker as { customType: string }).customType, "exercise-skipped");
		assert.throws(() => inputAppends(record, { type: "exercise-skip", problemCallId: "nope" }), ChatInputError);
	});
});

describe("the coding_exercise tool", () => {
	it("verifies the pose, refuses a second open exercise, and ends the turn", async () => {
		let messages: LhMessage[] = [];
		const tool = codingExerciseTool(codeModule, "c", () => messages, "Rust");
		assert.match(tool.description, /default coding language is Rust/);
		const ok = await tool.execute("x1", ARGS as never, undefined);
		assert.equal((ok as { terminate?: boolean }).terminate, true);
		const bad = await tool.execute("x2", { ...ARGS, workspace: { ...POSE, language: "cobol" } } as never, undefined);
		assert.equal((bad as { isError?: boolean }).isError ?? JSON.stringify(bad).includes("cobol"), true);
		messages = [call("x1"), result("x1")];
		const again = await tool.execute("x3", ARGS as never, undefined);
		assert.match(JSON.stringify(again), /already open/);
	});

	it("is in the teacher's registry only with the module, and the toggle drops it", () => {
		const ctx = { chatId: "c", chatStore: { getChat: () => null }, jobStore: {}, spawn: () => {} } as never;
		assert.equal("coding_exercise" in createTeacherTools(ctx), false);
		const armed = { ...(ctx as object), codingExercise: { module: codeModule } } as never;
		const tools = createTeacherTools(armed);
		assert.equal("coding_exercise" in tools, true);
		assert.equal("annotate" in tools, true);
		const off = createTeacherTools(armed, { coding_exercise: false });
		assert.equal("coding_exercise" in off, false);
		assert.equal("annotate" in off, false);
		assert.equal(composeCodingExercises({}, false).tools?.coding_exercise, false);
	});
});

describe("the projection", () => {
	it("marks the card closed once Submit or skip arrives, and renders the skip line", () => {
		const posed = [call("x1"), { ...result("x1"), content: [{ type: "text", text: "ok" }] } as LhMessage];
		const part = (msgs: LhMessage[]) =>
			projectView(msgs)
				.flatMap((m) => m.parts as Array<{ type: string; exerciseClosed?: boolean }>)
				.find((p) => p.type === "tool-coding_exercise");
		assert.equal(part(posed)?.exerciseClosed, false);
		const skipped = [...posed, newExerciseSkippedMessage("x1")];
		assert.equal(part(skipped)?.exerciseClosed, true);
		assert.ok(projectView(skipped).some((m) => m.parts.some((p) => p.type === "data-exercise-skipped")));
	});
});
