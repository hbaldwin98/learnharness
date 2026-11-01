/**
 * PRACTICE WORKSPACES — the seam (docs/practice-workspaces.md; plan step 1).
 * With no module available nothing changes (schema, description, prompt);
 * with one, the problem tool carries an optional `workspace`, refuses an
 * unknown module, verifies the pose through the module, and adds the
 * module's tools. An absent workspace IS the thinking field.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { createPracticeGate, problemInputObject, problemInputSchema, problemTool, practiceTools } from "../src/agent/tools/practice.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import type { AgentWorkspaceModule } from "../src/agent/workspaces/registry.ts";
import { activeProblemOf, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";
import { workspaceOf } from "../src/core/workspaces.ts";
import { workspaceComponentFor } from "../components/workspaces/registry.ts";

const ctx = { chatId: "c1", chatStore: { getChat: () => ({ messages: [] as LhMessage[], kind: "practice" }) } };
const POSE = { statement: "Reverse a list.", mode: "composition", modelSolution: "Two pointers." } as const;

function fakeModule(errors: string[] = []): AgentWorkspaceModule & { seen: unknown[] } {
	const seen: unknown[] = [];
	return {
		id: "fake",
		seen,
		poseSchema: Type.Object({ language: Type.String() }),
		verifyPose: async (workspace, poseCtx) => {
			seen.push({ workspace, poseCtx });
			return errors;
		},
		tools: () => ({ fake_tool: { name: "fake_tool" } as unknown as AgentTool<any> }),
	};
}

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe("no module available: nothing changes", () => {
	it("the schema is problemInputObject and the description has no workspace sentence", () => {
		assert.equal(problemInputSchema([]), problemInputObject);
		const tool = problemTool(createPracticeGate(ctx));
		assert.equal(tool.parameters, problemInputObject);
		assert.doesNotMatch(tool.description, /workspace/);
		assert.equal(JSON.stringify(practiceTools(ctx).problem!.parameters), JSON.stringify(problemInputObject));
	});

	it("the composed practice prompt is byte-identical", () => {
		assert.equal(composeInstructions("practice", undefined, []), composeInstructions("practice"));
		// A module with no doctrine directory composes nothing extra.
		assert.equal(composeInstructions("practice", undefined, ["fake"]), composeInstructions("practice"));
	});
});

describe("a module available: the problem tool's workspace", () => {
	it("exposes an optional workspace with the module literal", () => {
		const schema = problemInputSchema([fakeModule()]) as unknown as { properties: Record<string, any>; required?: string[] };
		assert.ok(schema.properties.workspace);
		assert.ok(!(schema.required ?? []).includes("workspace"));
		assert.equal(schema.properties.workspace.properties.module.const, "fake");
		assert.ok(schema.properties.workspace.properties.language);
		assert.match(problemTool(createPracticeGate(ctx), undefined, [fakeModule()]).description, /workspace/);
	});

	it("a verified pose goes through and the module sees the descriptor", async () => {
		const fake = fakeModule();
		const gate = createPracticeGate(ctx);
		const workspace = { module: "fake", language: "python" };
		const result = await problemTool(gate, undefined, [fake], "c1").execute("call_p", { ...POSE, workspace } as never);
		assert.equal(result.isError, undefined);
		assert.equal(gate.problemActive, true);
		assert.deepEqual(fake.seen, [{ workspace, poseCtx: { chatId: "c1", problemCallId: "call_p", signal: undefined } }]);
	});

	it("verification errors refuse the pose and leave the gate closed", async () => {
		const gate = createPracticeGate(ctx);
		const result = await problemTool(gate, undefined, [fakeModule(["reference fails test 3"])]).execute(
			"call_p",
			{ ...POSE, workspace: { module: "fake", language: "python" } } as never,
		);
		assert.equal(result.isError, true);
		assert.match(textOf(result), /reference fails test 3/);
		assert.equal(gate.problemActive, false);
	});

	it("an unknown or unavailable module is refused", async () => {
		const gate = createPracticeGate(ctx);
		const unknown = await problemTool(gate, undefined, [fakeModule()]).execute(
			"call_p",
			{ ...POSE, workspace: { module: "ghost" } } as never,
		);
		assert.equal(unknown.isError, true);
		assert.match(textOf(unknown), /"ghost" is not available/);
		const none = await problemTool(gate, undefined, []).execute("call_q", { ...POSE, workspace: { module: "fake" } } as never);
		assert.equal(none.isError, true);
		assert.equal(gate.problemActive, false);
	});

	it("a pose without a workspace is an ordinary problem", async () => {
		const fake = fakeModule();
		const gate = createPracticeGate(ctx);
		const result = await problemTool(gate, undefined, [fake]).execute("call_p", POSE as never);
		assert.equal(result.isError, undefined);
		assert.equal(fake.seen.length, 0);
	});

	it("module tools join the practice registry", () => {
		assert.ok(practiceTools({ ...ctx, workspaceModules: [fakeModule()] }).fake_tool);
		assert.equal(practiceTools(ctx).fake_tool, undefined);
	});
});

describe("reading a workspace off a problem", () => {
	it("workspaceOf: absent is the thinking field", () => {
		assert.equal(workspaceOf(POSE), null);
		assert.equal(workspaceOf({ ...POSE, workspace: {} }), null);
		assert.equal(workspaceOf(null), null);
		assert.deepEqual(workspaceOf({ ...POSE, workspace: { module: "code", language: "go" } }), { module: "code", language: "go" });
	});

	it("activeProblemOf is unchanged for a workspace pose", () => {
		const input = { ...POSE, workspace: { module: "fake", language: "python" } };
		const messages = [
			{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "call_p", name: PRACTICE_PROBLEM_TOOL, arguments: input }], timestamp: 1 },
			{ id: "m2", role: "toolResult", toolCallId: "call_p", toolName: PRACTICE_PROBLEM_TOOL, content: [{ type: "text", text: "Problem posed" }], isError: false, timestamp: 2 },
		] as unknown as LhMessage[];
		assert.deepEqual(activeProblemOf(messages), { toolCallId: "call_p", input });
	});

	it("the pane: no workspace or an unknown module → no pane (null)", () => {
		const Fake = () => null;
		assert.equal(workspaceComponentFor(POSE, { fake: Fake }), null);
		assert.equal(workspaceComponentFor({ ...POSE, workspace: { module: "ghost" } }, { fake: Fake }), null);
		assert.equal(workspaceComponentFor({ ...POSE, workspace: { module: "fake" } }, { fake: Fake }), Fake);
		assert.equal(workspaceComponentFor({ ...POSE, workspace: { module: "constructor" } }, { fake: Fake }), null);
	});
});

describe("workspace doctrine segment paths", () => {
	it("workspace-<id>/NN-x.md is a valid segment path; malformed ones are not", () => {
		assert.ok(isValidSegmentPath("workspace-code/10-doctrine.md"));
		assert.ok(!isValidSegmentPath("workspace-/10-doctrine.md"));
		assert.ok(!isValidSegmentPath("workspace-Code/10-doctrine.md"));
		assert.ok(!isValidSegmentPath("workspace-code/doctrine.md"));
		assert.ok(!isValidSegmentPath("workspace-code/x/10-doctrine.md"));
	});
});

describe("live pose progress (tool_execution_update)", () => {
	it("a streaming tool part carries its latest progress line; settled calls never do", async () => {
		const { projectView } = await import("../src/core/view.ts");
		const messages = [
			{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "call_p", name: PRACTICE_PROBLEM_TOOL, arguments: POSE }], timestamp: 1 },
		] as unknown as LhMessage[];
		const live = { executions: new Map(), inFlight: true, streamingIds: new Set(["m1"]), progress: new Map([["call_p", "building the rust environment: [2/4] RUN …"]]) };
		const part = projectView(messages, live)[0]!.parts.find((p) => p.toolCallId === "call_p")!;
		assert.equal(part.state, "input-streaming");
		assert.equal(part.progress, "building the rust environment: [2/4] RUN …");
		const settled = projectView(messages, { ...live, streamingIds: new Set<string>() })[0]!.parts.find((p) => p.toolCallId === "call_p")!;
		assert.equal(settled.progress, undefined);
	});
});
