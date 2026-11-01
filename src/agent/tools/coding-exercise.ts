/**
 * THE TEACHER'S CODING EXERCISE (practice workspaces, plan step 9): a
 * lesson-side coding problem. The teacher poses it mid-lesson; the coding
 * pane opens; the learner's Submit (test results + trace) or Skip closes
 * it and starts the teacher's next turn — the quiz's shape, in code.
 *
 * Present only when the coding module is available (Docker) and the
 * learner's Settings → Coding switch leaves it on (agent.tools key
 * `coding_exercise`, absent = on). The pose is verified exactly like a
 * practice coding problem's (the module's verifyPose).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { activeWorkspaceOf, type LhMessage } from "../../core/native-messages.ts";
import { exerciseResult, invalidInputResult } from "../tool-execute.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";
import { descriptorSchema, type AgentWorkspaceModule } from "../workspaces/registry.ts";

export const CODING_EXERCISE_DESCRIPTION =
	"Pose one coding exercise in the lesson: the learner writes code in a workspace beside the transcript against the tests you give. " +
	"Use it when writing code is the best check of what you just taught — not for recall a quiz covers. The pose is verified (starter builds, the reference passes every test) before it goes through. " +
	"Ends the turn. Their Submit arrives with the test results and a trace (narration, Runs, code changes, editor errors); a skip arrives as a skip. " +
	"Either closes the exercise — respond to the result and carry on teaching. While they work, an Ask (a direct request for help) may arrive: answer it without solving it for them. " +
	"Only one exercise is open at a time.";

/** The exercise schema: a statement and the code module's pose. */
export function codingExerciseSchema(module: AgentWorkspaceModule) {
	return Type.Object({
		statement: Type.String({ description: "REQUIRED — the exercise, as the learner reads it (markdown)." }),
		workspace: descriptorSchema(module),
	});
}

export function codingExerciseTool(
	module: AgentWorkspaceModule,
	chatId: string,
	record: () => readonly LhMessage[] | null,
	defaultCodeLanguage?: string,
): AgentTool<ReturnType<typeof codingExerciseSchema>> {
	const parameters = codingExerciseSchema(module);
	return {
		name: "coding_exercise",
		label: "coding exercise",
		description:
			CODING_EXERCISE_DESCRIPTION +
			(defaultCodeLanguage ? ` The learner's default coding language is ${defaultCodeLanguage}: use it unless they ask for another.` : ""),
		parameters,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args, parameters) as never,
		execute: async (toolCallId, input, signal, onUpdate) => {
			const messages = record();
			if (messages && activeWorkspaceOf(messages)) {
				return invalidInputResult("coding_exercise", ["an exercise is already open — wait for the learner's Submit or skip"]);
			}
			if (typeof input.statement !== "string" || input.statement.trim() === "") {
				return invalidInputResult("coding_exercise", ["statement must be non-empty"]);
			}
			const errors = await module.verifyPose(input.workspace, {
				chatId,
				problemCallId: toolCallId,
				signal,
				...(onUpdate ? { onProgress: (line: string) => onUpdate({ content: [{ type: "text", text: line }], details: undefined }) } : {}),
			});
			if (errors.length > 0) return invalidInputResult("coding_exercise", errors);
			return exerciseResult();
		},
	};
}
