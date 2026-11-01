/**
 * PRACTICE CODING WORKSPACE — the learner's side (docs/practice-workspaces-plan.md,
 * step 3): the saved files (starter paths only, active problems only), Run
 * and Submit against a fake runner (hidden tests as counts, results stored),
 * the thinking snapshot and the submission marker the chat input appends,
 * the transcript projection, and the optimistic-card absorption.
 *
 * Runs under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-code-workspace-ui-"));
process.env.LH_DATA_DIR = TMP_DATA;

import type { LhMessage } from "../src/core/native-messages.ts";
import type { CodeFile, WorkspaceRunResult } from "../src/core/contracts/workspaces.ts";

type Server = typeof import("../src/server/workspaces.ts");
type Inputs = typeof import("../src/core/input-events.ts");
let server: Server;
let inputs: Inputs;
let createChat: (title: string, kind?: "practice") => { id: string };
let saveMessages: (id: string, messages: LhMessage[]) => void;
let projectView: (messages: LhMessage[]) => Array<{ parts: Array<{ type: string; data?: unknown }> }>;
let absorbed: (m: LhMessage, record: readonly LhMessage[]) => boolean;
let newThinkingMessage: typeof import("../src/core/native-messages.ts").newThinkingMessage;
let causeOf: (m: LhMessage) => string;

const STARTER: CodeFile[] = [{ path: "solution.py", content: "def rev(xs):\n    return xs\n" }];
const VISIBLE: CodeFile[] = [{ path: "test_visible.py", content: "def test_empty(): ...\ndef test_one(): ...\n" }];
const HIDDEN: CodeFile[] = [{ path: "test_hidden.py", content: "def test_many(): ...\n" }];
const REFERENCE: CodeFile[] = [{ path: "solution.py", content: "def rev(xs):\n    return xs[::-1]\n" }];

const PROBLEM_ARGS = {
	statement: "Reverse a list.",
	mode: "composition",
	modelSolution: "Slice with a negative step.",
	workspace: { module: "code", language: "python", files: STARTER, tests: { visible: VISIBLE, hidden: HIDDEN }, reference: REFERENCE },
};

function poseMessages(callId: string): LhMessage[] {
	return [
		{
			id: `a_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "problem", arguments: PROBLEM_ARGS }],
			stopReason: "toolUse",
			timestamp: 1,
		} as unknown as LhMessage,
		{
			id: `r_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "problem",
			content: [{ type: "text", text: "Posed." }],
			isError: false,
			timestamp: 2,
		} as unknown as LhMessage,
	];
}

/** A fake runner: every `def test_x` in the test files is a test case; it
 *  passes only when solution.py holds the reversing slice. */
const runs: Array<{ files: string[] }> = [];
const fakeRunner = {
	status: async () => "running" as const,
	ensureImage: async () => ({ ok: true, output: "" }),
	remove: async () => {},
	reapAll: async () => {},
	retainOnly: async () => {},
	writeFiles: async () => {},
	spawn: async () => {
		throw new Error("no language server in this test");
	},
	run: async (req: { files: readonly CodeFile[] }) => {
		runs.push({ files: req.files.map((f) => f.path) });
		const solved = req.files.some((f) => f.path === "solution.py" && f.content.includes("[::-1]"));
		const cases = req.files
			.filter((f) => f.path.startsWith("test_"))
			.flatMap((f) => [...f.content.matchAll(/def (test_\w+)/g)].map((m) => m[1]!));
		const xml = `<testsuite>${cases
			.map((c) => (solved ? `<testcase name="${c}"/>` : `<testcase name="${c}"><failure message="wrong"/></testcase>`))
			.join("")}</testsuite>`;
		return {
			steps: [
				{ phase: "build" as const, exitCode: 0, timedOut: false, output: "" },
				{ phase: "test" as const, exitCode: solved ? 0 : 1, timedOut: false, output: "" },
			],
			report: xml,
		};
	},
};

before(async () => {
	(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("learnharness.workspaces")] = {
		runner: fakeRunner,
		code: { id: "code" },
		status: "running",
		reaped: true,
	};
	server = await import("../src/server/workspaces.ts");
	inputs = await import("../src/core/input-events.ts");
	const chats = await import("../src/server/chats.ts");
	createChat = chats.createChat as typeof createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages);
	const view = await import("../src/core/view.ts");
	projectView = (messages) => view.projectView(messages) as unknown as ReturnType<typeof projectView>;
	({ absorbed } = await import("../components/session-core.ts"));
	const native = await import("../src/core/native-messages.ts");
	newThinkingMessage = native.newThinkingMessage;
	causeOf = (m) => String(native.nativeInputCause(m as never, []));
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function practiceChat(callId = "call_p1"): { id: string; messages: LhMessage[] } {
	const chat = createChat("Coding", "practice");
	const messages = poseMessages(callId);
	saveMessages(chat.id, messages);
	return { id: chat.id, messages };
}

describe("the saved workspace", () => {
	it("loads the starter with the visible tests (never the hidden ones or the reference)", () => {
		const chat = practiceChat();
		const state = server.loadWorkspace(chat.id, "call_p1");
		assert.equal(state.language, "python");
		assert.deepEqual(state.files, STARTER);
		assert.deepEqual(state.visibleTests, VISIBLE);
		assert.equal(state.active, true);
		assert.equal(state.lastRun, null);
		assert.doesNotMatch(JSON.stringify(state), /test_hidden|\[::-1\]/);
	});

	it("saves starter-path contents only; other paths, non-coding problems and unknown chats are refused", () => {
		const chat = practiceChat();
		server.saveWorkspace(chat.id, "call_p1", [{ path: "solution.py", content: "# mine\n" }]);
		assert.equal(server.loadWorkspace(chat.id, "call_p1").files[0]!.content, "# mine\n");
		assert.throws(() => server.saveWorkspace(chat.id, "call_p1", [{ path: "test_visible.py", content: "" }]), (e: Error & { status?: number }) => e.status === 400);
		assert.throws(() => server.saveWorkspace(chat.id, "call_p1", "nope"), (e: Error & { status?: number }) => e.status === 400);
		assert.throws(() => server.loadWorkspace(chat.id, "call_missing"), (e: Error & { status?: number }) => e.status === 404);
		assert.throws(() => server.loadWorkspace("nochat", "call_p1"), (e: Error & { status?: number }) => e.status === 404);
	});

	it("a concluded problem is read-only", () => {
		const chat = practiceChat();
		const concluded: LhMessage[] = [
			...chat.messages,
			{ id: "a_c", role: "assistant", content: [{ type: "toolCall", id: "call_c", name: "conclude", arguments: { outcome: "solved", verdict: "ok" } }], stopReason: "toolUse", timestamp: 3 } as unknown as LhMessage,
			{ id: "r_c", role: "toolResult", toolCallId: "call_c", toolName: "conclude", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 4 } as unknown as LhMessage,
		];
		saveMessages(chat.id, concluded);
		assert.equal(server.loadWorkspace(chat.id, "call_p1").active, false);
		assert.throws(() => server.saveWorkspace(chat.id, "call_p1", STARTER), (e: Error & { status?: number }) => e.status === 409);
	});
});

describe("diagnostics (plan step 4)", () => {
	it("loading an active problem starts its language server; the status is served; inactive = unavailable", async () => {
		const chat = practiceChat();
		const before = server.workspaceDiagnostics(chat.id, "call_p1");
		assert.equal(before.status, "unavailable");
		assert.equal(before.name, "Python");
		server.loadWorkspace(chat.id, "call_p1");
		// This fake runner can't spawn, so the session ends "crashed" after its one restart.
		const end = Date.now() + 3000;
		while (server.workspaceDiagnostics(chat.id, "call_p1").status !== "crashed" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
		assert.equal(server.workspaceDiagnostics(chat.id, "call_p1").status, "crashed");
		assert.throws(() => server.workspaceDiagnostics(chat.id, "call_missing"), (e: Error & { status?: number }) => e.status === 404);
		server.reconcileWorkspaces(chat.id, []);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(server.workspaceDiagnostics(chat.id, "call_p1").status, "unavailable");
	});
});

describe("Run and Submit", () => {
	it("Run executes the saved files with the visible tests only, and stores the result", async () => {
		const chat = practiceChat();
		runs.length = 0;
		const r = await server.runWorkspace(chat.id, "call_p1", "run");
		assert.equal(runs.length, 1);
		assert.deepEqual(runs[0]!.files.sort(), ["solution.py", "test_visible.py"]);
		assert.equal(r.mode, "run");
		assert.equal(r.ok, false);
		assert.deepEqual(r.visible.map((t) => t.name), ["test_empty", "test_one"]);
		assert.equal(r.hidden, undefined);
		assert.deepEqual(server.loadWorkspace(chat.id, "call_p1").lastRun, r);
		assert.equal(server.lastSubmission(chat.id, "call_p1"), null);
	});

	it("Submit adds the hidden tests as counts and stores files + result for the marker", async () => {
		const chat = practiceChat();
		server.saveWorkspace(chat.id, "call_p1", REFERENCE);
		runs.length = 0;
		const r = await server.runWorkspace(chat.id, "call_p1", "submit");
		assert.equal(runs.length, 2);
		assert.ok(runs[1]!.files.includes("test_hidden.py"));
		assert.equal(r.ok, true);
		assert.deepEqual(r.hidden, { passed: 1, total: 1 });
		assert.ok(!r.visible.some((t) => t.name === "test_many"), "hidden names never reach the learner");
		const stored = server.lastSubmission(chat.id, "call_p1");
		assert.deepEqual(stored?.files, REFERENCE);
		assert.deepEqual(stored?.result, r);
	});

	it("a failing Submit counts the hidden failures", async () => {
		const chat = practiceChat();
		const r = await server.runWorkspace(chat.id, "call_p1", "submit");
		assert.equal(r.ok, false);
		assert.deepEqual(r.hidden, { passed: 0, total: 1 });
	});
});

describe("the chat inputs", () => {
	const lookups = (snapshot: CodeFile[] | null, submission: { files: CodeFile[]; result: WorkspaceRunResult } | null) => ({
		snapshot: () => snapshot,
		submission: () => submission,
	});
	const result: WorkspaceRunResult = {
		mode: "submit",
		phase: "test",
		ok: false,
		timedOut: false,
		exitCode: 1,
		output: "",
		visible: [
			{ name: "test_empty", status: "pass" },
			{ name: "test_one", status: "fail", message: "expected [1]" },
		],
		hidden: { passed: 0, total: 1 },
		at: "2026-11-01T00:00:00.000Z",
	};

	it("parses a submission and refuses one without a problem id", () => {
		assert.deepEqual(inputs.parseChatInput({ type: "submission", problemCallId: "p" }), { type: "submission", problemCallId: "p" });
		assert.throws(() => inputs.parseChatInput({ type: "submission" }), inputs.ChatInputError);
	});

	it("thinking on a coding problem carries the code snapshot (details + model text)", () => {
		const record = { messages: poseMessages("call_p1"), kind: "practice" };
		const [m] = inputs.inputAppends(record, { type: "thinking", problemCallId: "call_p1", text: "Two pointers?" }, lookups(STARTER, null));
		const marker = m as unknown as { customType: string; content: string; details: { code?: CodeFile[]; text: string } };
		assert.equal(marker.customType, "practice-thinking");
		assert.deepEqual(marker.details.code, STARTER);
		assert.match(marker.content, /Two pointers\?/);
		assert.match(marker.content, /solution\.py:\n```py\ndef rev/);
	});

	it("thinking without a workspace is unchanged", () => {
		const record = { messages: poseMessages("call_p1"), kind: "practice" };
		const [m] = inputs.inputAppends(record, { type: "thinking", problemCallId: "call_p1", text: "Hm." });
		const marker = m as unknown as { content: string; details: Record<string, unknown> };
		assert.equal("code" in marker.details, false);
		assert.doesNotMatch(marker.content, /current code/);
	});

	it("a submission appends the stored code and results for the agent", () => {
		const record = { messages: poseMessages("call_p1"), kind: "practice" };
		const [m] = inputs.inputAppends(record, { type: "submission", problemCallId: "call_p1" }, lookups(null, { files: REFERENCE, result }));
		const marker = m as unknown as { customType: string; content: string; details: unknown };
		assert.equal(marker.customType, "practice-submission");
		assert.deepEqual(marker.details, { problemCallId: "call_p1", files: REFERENCE, result });
		assert.match(marker.content, /Visible tests: 1\/2 passed/);
		assert.match(marker.content, /Hidden tests: 0\/1 passed/);
		assert.match(marker.content, /✗ test_one: expected \[1\]/);
		assert.match(marker.content, /\[::-1\]/);
		assert.equal(causeOf(m!), "learner");
	});

	it("a submission needs the active problem and a stored Submit", () => {
		const record = { messages: poseMessages("call_p1"), kind: "practice" };
		assert.throws(() => inputs.inputAppends(record, { type: "submission", problemCallId: "other" }, lookups(null, { files: REFERENCE, result })), inputs.ChatInputError);
		assert.throws(() => inputs.inputAppends(record, { type: "submission", problemCallId: "call_p1" }, lookups(null, null)), inputs.ChatInputError);
		assert.throws(() => inputs.inputAppends(record, { type: "submission", problemCallId: "call_p1" }), inputs.ChatInputError);
	});

	it("the transcript shows a submission card", () => {
		const record = { messages: poseMessages("call_p1"), kind: "practice" };
		const appended = inputs.inputAppends(record, { type: "submission", problemCallId: "call_p1" }, lookups(null, { files: REFERENCE, result }));
		const view = projectView([...record.messages, ...appended]);
		const part = view.flatMap((v) => v.parts).find((p) => p.type === "data-practice-submission");
		assert.ok(part, "a data-practice-submission part");
		assert.equal((part!.data as { problemCallId: string }).problemCallId, "call_p1");
	});

	it("the optimistic thinking card is absorbed by the server copy that carries code", () => {
		const optimistic = { ...newThinkingMessage("call_p1", "Two pointers?"), id: "c_local1" } as LhMessage;
		const server = { ...newThinkingMessage("call_p1", "Two pointers?", STARTER), id: "m_server" } as LhMessage;
		assert.equal(absorbed(optimistic, [server]), true);
		const other = { ...newThinkingMessage("call_p1", "Different.", STARTER), id: "m_other" } as LhMessage;
		assert.equal(absorbed(optimistic, [other]), false);
	});
});
