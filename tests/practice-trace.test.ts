/**
 * PRACTICE CODING WORKSPACE — the narration trace and Ask
 * (docs/practice-workspaces-plan.md, step 5): the line diff, the trace's
 * model text, recorded narration and Runs, one bundle per delivery with a
 * cursor that moves only on commit, the ask input and marker, the
 * projection, and the app-computed coding outcome.
 *
 * Runs under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-practice-trace-"));
process.env.LH_DATA_DIR = TMP_DATA;

import { lineDiff } from "../src/core/line-diff.ts";
import { describeTrace, traceIsEmpty, type CodeFile, type TraceBundle, type WorkspaceRunResult } from "../src/core/contracts/workspaces.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

type Server = typeof import("../src/server/workspaces.ts");
type Inputs = typeof import("../src/core/input-events.ts");
type Native = typeof import("../src/core/native-messages.ts");
let server: Server;
let inputs: Inputs;
let native: Native;
let createChat: (title: string, kind?: "practice") => { id: string };
let saveMessages: (id: string, messages: LhMessage[]) => void;
let projectView: (messages: LhMessage[]) => Array<{ parts: Array<{ type: string; data?: unknown; codingOutcome?: unknown }> }>;

const STARTER: CodeFile[] = [{ path: "solution.py", content: "def rev(xs):\n    return xs\n" }];
const VISIBLE: CodeFile[] = [{ path: "test_visible.py", content: "def test_empty(): ...\n" }];
const HIDDEN: CodeFile[] = [{ path: "test_hidden.py", content: "def test_many(): ...\n" }];
const SOLVED: CodeFile[] = [{ path: "solution.py", content: "def rev(xs):\n    return xs[::-1]\n" }];

/** A longer starter, where a one-line edit's diff is smaller than the file. */
const NL = String.fromCharCode(10);
const LONG_STARTER: CodeFile[] = [
	{ path: "solution.py", content: ["def rev(xs):", "    return xs", ...Array.from({ length: 20 }, (_, i) => `# note ${i}`), ""].join(NL) },
];
const LONG_SOLVED: CodeFile[] = [
	{ path: "solution.py", content: LONG_STARTER[0]!.content.replace(`return xs${NL}`, `return xs[::-1]${NL}`) },
];
const LONG_ARGS = { statement: "Reverse a list.", mode: "composition", modelSolution: "Slice.", workspace: { module: "code", language: "python", files: LONG_STARTER, tests: { visible: VISIBLE, hidden: HIDDEN }, reference: LONG_SOLVED } };

const PROBLEM_ARGS = {
	statement: "Reverse a list.",
	mode: "composition",
	modelSolution: "Slice with a negative step.",
	workspace: { module: "code", language: "python", files: STARTER, tests: { visible: VISIBLE, hidden: HIDDEN }, reference: SOLVED },
};

const assistant = (id: string, content: unknown[], timestamp: number): LhMessage =>
	({ id, role: "assistant", content, stopReason: "toolUse", timestamp }) as unknown as LhMessage;
const toolResult = (callId: string, name: string, timestamp: number): LhMessage =>
	({ id: `r_${callId}`, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp }) as unknown as LhMessage;
const reply = (id: string, text: string, timestamp: number): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp }) as unknown as LhMessage;

function poseMessages(callId: string, args: unknown = PROBLEM_ARGS): LhMessage[] {
	return [assistant(`a_${callId}`, [{ type: "toolCall", id: callId, name: "problem", arguments: args }], 1_000), toolResult(callId, "problem", 1_001)];
}

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
	native = await import("../src/core/native-messages.ts");
	const chats = await import("../src/server/chats.ts");
	createChat = chats.createChat as typeof createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages);
	const view = await import("../src/core/view.ts");
	projectView = (messages) => view.projectView(messages) as unknown as ReturnType<typeof projectView>;
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function practiceChat(callId = "call_p1", args: unknown = PROBLEM_ARGS): { id: string; messages: LhMessage[] } {
	const chat = createChat("Coding", "practice");
	const messages = poseMessages(callId, args);
	saveMessages(chat.id, messages);
	return { id: chat.id, messages };
}

/** The chat handler's lookups, with the commits it would run after saving. */
function lookups(chatId: string) {
	const commits: Array<() => void> = [];
	return {
		commits,
		workspace: {
			snapshot: (id: string) => server.workspaceSnapshot(chatId, id),
			submission: (id: string) => server.lastSubmission(chatId, id),
			trace: (id: string, files?: readonly CodeFile[]) => {
				const pending = server.pendingTrace(chatId, id, files);
				if (!pending) return null;
				commits.push(pending.commit);
				return pending.bundle;
			},
		},
	};
}

const emptyTrace = (): TraceBundle => ({ narration: [], runs: [], changes: null, diagnostics: [] });

describe("the line diff", () => {
	it("is empty for equal text and a hunk with context for a change", () => {
		assert.equal(lineDiff("a\nb\n", "a\nb\n"), "");
		const d = lineDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nD\ne\nf\ng\n");
		assert.equal(d, "@@ -2,5 +2,5 @@\n b\n c\n-d\n+D\n e\n f");
	});

	it("shows additions to an empty file and deletions to nothing", () => {
		assert.equal(lineDiff("", "x\ny\n"), "@@ -1,0 +1,2 @@\n+x\n+y");
		assert.equal(lineDiff("x\n", ""), "@@ -1,1 +1,0 @@\n-x");
	});

	it("splits distant changes into separate hunks", () => {
		const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
		const after = before.replace("l1\n", "L1\n").replace("l18", "L18");
		const d = lineDiff(before, after)!;
		assert.equal(d.match(/^@@/gm)?.length, 2);
		assert.match(d, /-l1\n\+L1/);
		assert.match(d, /-l18\n\+L18/);
	});

	it("sends the whole file when the diff wouldn't be smaller", () => {
		const chat = practiceChat();
		server.saveWorkspace(chat.id, "call_p1", SOLVED);
		assert.deepEqual(server.pendingTrace(chat.id, "call_p1")!.bundle.changes, [{ path: "solution.py", text: SOLVED[0]!.content, full: true }]);
	});

	it("gives up (null) on a pair too large to diff", () => {
		const a = Array.from({ length: 2100 }, (_, i) => `a${i}`).join("\n");
		const b = Array.from({ length: 2100 }, (_, i) => `b${i}`).join("\n");
		assert.equal(lineDiff(a, b), null);
	});
});

describe("the trace text", () => {
	it("is empty for an empty bundle, and says when the code is unchanged", () => {
		assert.equal(traceIsEmpty(emptyTrace()), true);
		assert.equal(describeTrace(emptyTrace()), "");
		assert.equal(describeTrace({ ...emptyTrace(), changes: [] }), "Their code is unchanged since you last saw it.");
	});

	it("labels narration with times, runs with results, diffs and problems", () => {
		const run: WorkspaceRunResult = {
			mode: "run", phase: "test", ok: false, timedOut: false, exitCode: 1, output: "",
			visible: [{ name: "test_one", status: "fail", message: "boom" }], at: "2026-11-01T14:05:00",
		};
		const text = describeTrace({
			narration: [{ at: "2026-11-01T14:03:00", text: "use a map" }],
			runs: [run],
			changes: [{ path: "solution.py", text: "@@ -1 +1 @@\n-a\n+b" }],
			diagnostics: [{ path: "solution.py", line: 1, column: 4, endLine: 1, endColumn: 6, severity: "error", message: "bad" }],
		});
		assert.match(text, /\[14:03\] use a map/);
		assert.match(text, /ran the visible tests at 14:05:\nVisible tests: 0\/1 passed\.\n✗ test_one: boom/);
		assert.match(text, /solution\.py:\n```diff\n@@ -1 \+1 @@/);
		assert.match(text, /solution\.py:2:5 error: bad/);
	});
});

describe("recording narration and Runs", () => {
	it("records narration on the active problem and loads it back", () => {
		const chat = practiceChat();
		const lines = server.appendNarration(chat.id, "call_p1", "  first idea  ");
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.text, "first idea");
		assert.deepEqual(server.loadWorkspace(chat.id, "call_p1").narration, lines);
		assert.throws(() => server.appendNarration(chat.id, "call_p1", "   "), /non-empty/);
	});

	it("refuses narration once the problem is no longer active", () => {
		const chat = practiceChat();
		saveMessages(chat.id, [
			...chat.messages,
			assistant("a_c", [{ type: "toolCall", id: "call_c", name: "conclude", arguments: {} }], 3_000),
			toolResult("call_c", "conclude", 3_001),
		]);
		assert.throws(() => server.appendNarration(chat.id, "call_p1", "late"), /no longer active/);
	});

	it("adds each Run (not Submits) to the trace", async () => {
		const chat = practiceChat();
		await server.runWorkspace(chat.id, "call_p1", "run");
		await server.runWorkspace(chat.id, "call_p1", "submit");
		const pending = server.pendingTrace(chat.id, "call_p1")!;
		assert.equal(pending.bundle.runs.length, 1);
		assert.equal(pending.bundle.runs[0]!.mode, "run");
	});
});

describe("one bundle per delivery", () => {
	it("bundles narration, runs and the diff since the starter, and moves the cursor only on commit", async () => {
		const chat = practiceChat("call_p1", LONG_ARGS);
		server.appendNarration(chat.id, "call_p1", "slice it");
		server.saveWorkspace(chat.id, "call_p1", LONG_SOLVED);
		await server.runWorkspace(chat.id, "call_p1", "run");

		const first = server.pendingTrace(chat.id, "call_p1")!;
		assert.equal(first.bundle.narration.length, 1);
		assert.equal(first.bundle.runs.length, 1);
		assert.equal(first.bundle.changes?.length, 1);
		assert.match(first.bundle.changes![0]!.text, /-    return xs\n\+    return xs\[::-1\]/);

		// Not committed (a refused send): the next bundle still has it all.
		const again = server.pendingTrace(chat.id, "call_p1")!;
		assert.deepEqual(again.bundle, first.bundle);

		again.commit();
		const after = server.pendingTrace(chat.id, "call_p1")!.bundle;
		assert.deepEqual(after.narration, []);
		assert.deepEqual(after.runs, []);
		assert.deepEqual(after.changes, []);

		server.appendNarration(chat.id, "call_p1", "now the edge case");
		assert.deepEqual(server.pendingTrace(chat.id, "call_p1")!.bundle.narration.map((n) => n.text), ["now the edge case"]);
	});

	it("is null for a problem without a coding workspace", () => {
		const chat = createChat("Plain", "practice");
		saveMessages(chat.id, poseMessages("call_plain", { statement: "2+2?", mode: "recall", modelSolution: "4" }));
		assert.equal(server.pendingTrace(chat.id, "call_plain"), null);
	});
});

describe("the ask input", () => {
	it("parses with possibly-empty text", () => {
		assert.deepEqual(inputs.parseChatInput({ type: "ask", problemCallId: "c", text: "" }), { type: "ask", problemCallId: "c", text: "" });
		assert.throws(() => inputs.parseChatInput({ type: "ask", problemCallId: "c" }), /text/);
		assert.throws(() => inputs.parseChatInput({ type: "ask", text: "x" }), /problemCallId/);
	});

	it("appends a learner-caused practice-ask marker with the request and the trace", () => {
		const chat = practiceChat();
		server.appendNarration(chat.id, "call_p1", "stuck on the base case");
		const { workspace, commits } = lookups(chat.id);
		const appends = inputs.inputAppends({ messages: chat.messages, kind: "practice" }, { type: "ask", problemCallId: "call_p1", text: "why does it fail?" }, workspace);
		assert.equal(appends.length, 1);
		const marker = appends[0] as LhMessage & { customType: string; content: string; details: { text: string; trace?: TraceBundle } };
		assert.equal(marker.customType, "practice-ask");
		assert.match(marker.content, /direct request for your help:\nwhy does it fail\?/);
		assert.match(marker.content, /stuck on the base case/);
		assert.match(marker.content, /unchanged since you last saw it/);
		assert.equal(marker.details.trace?.narration.length, 1);
		assert.equal(native.nativeInputCause(marker as never, []), "learner");
		assert.equal(commits.length, 1);
	});

	it("says a wordless Ask still asks", () => {
		const chat = practiceChat();
		const { workspace } = lookups(chat.id);
		const [marker] = inputs.inputAppends({ messages: chat.messages }, { type: "ask", problemCallId: "call_p1", text: "  " }, workspace);
		assert.match((marker as { content: string }).content, /pressed Ask without words/);
	});

	it("refuses with no active problem or no coding workspace", () => {
		const chat = practiceChat();
		const { workspace } = lookups(chat.id);
		assert.throws(() => inputs.inputAppends({ messages: [] }, { type: "ask", problemCallId: "call_p1", text: "x" }, workspace), /no active problem/);
		const plain = createChat("Plain", "practice");
		const messages = poseMessages("call_plain", { statement: "2+2?", mode: "recall", modelSolution: "4" });
		saveMessages(plain.id, messages);
		assert.throws(
			() => inputs.inputAppends({ messages }, { type: "ask", problemCallId: "call_plain", text: "x" }, lookups(plain.id).workspace),
			/no coding problem/,
		);
	});

	it("projects to a user-side ask card", () => {
		const marker = native.newAskMessage({ problemCallId: "call_p1", text: "help", trace: emptyTrace() });
		const view = projectView([marker]);
		assert.equal(view[0]!.parts[0]!.type, "data-practice-ask");
		assert.deepEqual((view[0]!.parts[0]!.data as { text: string }).text, "help");
	});
});

describe("thinking and submission carry the trace", () => {
	it("thinking sends the diff, not the full files, and keeps the files for the card", () => {
		const chat = practiceChat("call_p1", LONG_ARGS);
		server.saveWorkspace(chat.id, "call_p1", LONG_SOLVED);
		const { workspace } = lookups(chat.id);
		const [marker] = inputs.inputAppends({ messages: chat.messages }, { type: "thinking", problemCallId: "call_p1", text: "done?" }, workspace);
		const m = marker as { content: string; details: { code?: CodeFile[]; trace?: TraceBundle } };
		assert.match(m.content, /```diff/);
		assert.doesNotMatch(m.content, /Their current code/);
		assert.deepEqual(m.details.code, LONG_SOLVED);
		assert.equal(m.details.trace?.changes?.length, 1);
	});

	it("a submission carries the full code and a trace without a changes section; its commit makes that code the seen code", async () => {
		const chat = practiceChat();
		server.saveWorkspace(chat.id, "call_p1", SOLVED);
		server.appendNarration(chat.id, "call_p1", "submitting");
		await server.runWorkspace(chat.id, "call_p1", "submit");
		const { workspace, commits } = lookups(chat.id);
		const [marker] = inputs.inputAppends({ messages: chat.messages }, { type: "submission", problemCallId: "call_p1" }, workspace);
		const m = marker as { content: string; details: { trace?: TraceBundle } };
		assert.equal(m.details.trace?.changes, null);
		assert.match(m.content, /Submitted code:/);
		assert.match(m.content, /Since you last looked:\n.*submitting/s);
		commits.forEach((c) => c());
		assert.deepEqual(server.pendingTrace(chat.id, "call_p1")!.bundle.changes, []);
	});
});

describe("the coding outcome", () => {
	const submission = (ok: boolean, at: number): LhMessage => {
		const marker = native.newSubmissionMessage({
			problemCallId: "call_p1",
			files: SOLVED,
			result: {
				mode: "submit", phase: "test", ok, timedOut: false, exitCode: ok ? 0 : 1, output: "",
				visible: [{ name: "test_empty", status: ok ? "pass" : "fail" }], hidden: { passed: ok ? 1 : 0, total: 1 }, at: "",
			},
		});
		return { ...marker, timestamp: at } as LhMessage;
	};
	const ask = (at: number): LhMessage => ({ ...native.newAskMessage({ problemCallId: "call_p1", text: "?" }), timestamp: at }) as LhMessage;
	const conclude = (at: number): LhMessage[] => [
		assistant("a_c", [{ type: "text", text: "Well done." }, { type: "toolCall", id: "call_c", name: "conclude", arguments: { outcome: "solved" } }], at),
		toolResult("call_c", "conclude", at + 1),
	];

	it("counts hints (replied turns but the concluding one), asks, the last submit and the time to the first passing submit", () => {
		const messages: LhMessage[] = [
			...poseMessages("call_p1"),
			ask(2_000),
			reply("h1", "Look at the slice.", 2_100),
			submission(false, 60_000),
			reply("h2", "Close — one test fails.", 60_100),
			ask(70_000),
			reply("h3", "", 70_100),
			submission(true, 121_000),
			...conclude(121_100),
		];
		const outcome = native.codingOutcomeForConclude(messages, "call_c")!;
		assert.deepEqual(outcome, {
			lastSubmit: { built: true, visible: { passed: 1, total: 1 }, hidden: { passed: 1, total: 1 } },
			timeToPassMs: 120_000,
			asks: 2,
			hints: 2,
		});
		const view = projectView(messages);
		const part = view.flatMap((v) => v.parts).find((p) => p.type === "tool-conclude") as { codingOutcome?: unknown } | undefined;
		assert.deepEqual(part?.codingOutcome, outcome);
	});

	it("is undefined for an ordinary problem and has no time without a passing submit", () => {
		const plain = [...poseMessages("call_p1", { statement: "2+2?", mode: "recall", modelSolution: "4" }), ...conclude(5_000)];
		assert.equal(native.codingOutcomeForConclude(plain, "call_c"), undefined);
		const unsolved = [...poseMessages("call_p1"), submission(false, 9_000), ...conclude(10_000)];
		const o = native.codingOutcomeForConclude(unsolved, "call_c")!;
		assert.equal(o.timeToPassMs, null);
		assert.equal(o.hints, 0);
		assert.equal(o.lastSubmit?.visible.passed, 0);
	});
});
