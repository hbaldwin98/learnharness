/**
 * The `annotate` tool (practice workspaces, plan step 7; owner ruling:
 * annotate, never edit): the agent pins a short note to a line range of the
 * learner's code on the active coding problem. The server owns storage and
 * validation (injected), so this stays in the agent layer without
 * importing the server.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../../tool-execute.ts";

export const annotateInputObject = Type.Object({
	path: Type.String({ description: "REQUIRED — the file, exactly as the learner sees it (e.g. solution.py)." }),
	line: Type.Integer({ minimum: 1, description: "REQUIRED — the first line (1-based) in the learner's CURRENT code." }),
	endLine: Type.Optional(Type.Integer({ minimum: 1, description: "The last line (inclusive); omit for one line." })),
	note: Type.String({ description: "REQUIRED — one or two short sentences pointing at what to look at. Never the fix itself." }),
});

export type AnnotateInput = Static<typeof annotateInputObject>;

/** The server's side: validate and store; errors refuse the call. */
export type AnnotateHandler = (chatId: string, input: AnnotateInput) => { ok: true; text: string } | { ok: false; errors: string[] };

export function annotateTool(chatId: string, handle: AnnotateHandler): AgentTool<typeof annotateInputObject> {
	return {
		name: "annotate",
		label: "annotate",
		description:
			"Pin a short note to lines of the learner's code on the active coding problem (\"look at this loop bound\"). " +
			"You can never change their code — only point. The note follows its lines as they edit, and is listed as " +
			"outdated if they delete those lines. Line numbers are of their CURRENT code (the trace's diff shows it).",
		parameters: annotateInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const result = handle(chatId, input);
			if (!result.ok) return invalidInputResult("annotate", result.errors);
			return { content: [{ type: "text", text: result.text }], details: null };
		},
	};
}
