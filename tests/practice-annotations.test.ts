/**
 * PRACTICE CODING WORKSPACE — annotations (docs/practice-workspaces-plan.md,
 * step 7): re-anchoring (unchanged, moved, outdated), the agent's annotate
 * call (validation, storage), saves moving notes with their code, and the
 * learner's dismissal.
 *
 * Runs under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-practice-annotations-"));
process.env.LH_DATA_DIR = TMP_DATA;

import { anchorOf, reanchor, type CodeAnnotation } from "../src/core/annotations.ts";
import type { CodeFile } from "../src/core/contracts/workspaces.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

type Server = typeof import("../src/server/workspaces.ts");
let server: Server;
let createChat: (title: string, kind?: "practice") => { id: string };
let saveMessages: (id: string, messages: LhMessage[]) => void;

const STARTER: CodeFile[] = [{ path: "solution.py", content: "def rev(xs):\n    out = []\n    for x in xs:\n        out.append(x)\n    return out\n" }];
const ARGS = {
	statement: "Reverse a list.",
	mode: "composition",
	modelSolution: "Slice.",
	workspace: {
		module: "code",
		language: "python",
		files: STARTER,
		tests: { visible: [{ path: "test_solution.py", content: "def test_a(): ...\n" }], hidden: [] },
		reference: STARTER,
	},
};

before(async () => {
	(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("learnharness.workspaces")] = {
		runner: { status: async () => "running" },
		code: { id: "code" },
		status: "running",
		reaped: true,
	};
	server = await import("../src/server/workspaces.ts");
	const chats = await import("../src/server/chats.ts");
	createChat = chats.createChat as typeof createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages);
});

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

function chat(): string {
	const c = createChat("Coding", "practice");
	saveMessages(c.id, [
		{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "call_p1", name: "problem", arguments: ARGS }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage,
		{ id: "r1", role: "toolResult", toolCallId: "call_p1", toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 } as unknown as LhMessage,
	]);
	return c.id;
}

const note = (line: number, endLine: number, content: string): CodeAnnotation => ({
	id: "n1",
	path: "solution.py",
	line,
	endLine,
	note: "look here",
	at: "",
	anchor: anchorOf(content, line, endLine),
});

describe("re-anchoring", () => {
	const text = STARTER[0]!.content;

	it("keeps a note whose lines are unchanged", () => {
		const a = note(3, 4, text);
		assert.equal(reanchor(a, text.replace("return out", "return out[::-1]")), a);
	});

	it("moves a note with its lines", () => {
		const a = note(3, 4, text);
		const moved = reanchor(a, "# header\n\n" + text);
		assert.deepEqual([moved.line, moved.endLine, moved.outdated], [5, 6, undefined]);
	});

	it("marks a note outdated when its lines are gone", () => {
		const a = note(3, 4, text);
		assert.equal(reanchor(a, "def rev(xs):\n    return xs[::-1]\n").outdated, true);
	});

	it("picks the nearest copy when the lines appear twice", () => {
		const doubled = "for x in xs:\n    pass\n" + "\n".repeat(10) + "for x in xs:\n    pass\n";
		const a = { ...note(13, 14, doubled) };
		const moved = reanchor(a, "\n" + doubled);
		assert.equal(moved.line, 14);
	});
});

describe("the annotate call", () => {
	it("stores a note on the active coding problem's current code", () => {
		const id = chat();
		const result = server.annotateActiveProblem(id, { path: "solution.py", line: 3, endLine: 4, note: "  this loop keeps the order  " });
		assert.deepEqual(result, { ok: true, text: "Annotated solution.py:3–4. The learner sees the note beside those lines." });
		const [a] = server.workspaceAnnotations(id, "call_p1");
		assert.equal(a!.note, "this loop keeps the order");
		assert.deepEqual(a!.anchor, ["    for x in xs:", "        out.append(x)"]);
	});

	it("refuses unknown files, lines out of range and empty notes", () => {
		const id = chat();
		const bad = server.annotateActiveProblem(id, { path: "nope.py", line: 1, note: "x" });
		assert.equal(bad.ok, false);
		const range = server.annotateActiveProblem(id, { path: "solution.py", line: 99, note: "x" });
		assert.match(JSON.stringify(range), /has 6 lines/);
		const empty = server.annotateActiveProblem(id, { path: "solution.py", line: 1, note: "  " });
		assert.match(JSON.stringify(empty), /must not be empty/);
	});

	it("can annotate a visible test", () => {
		const id = chat();
		assert.equal(server.annotateActiveProblem(id, { path: "test_solution.py", line: 1, note: "read this" }).ok, true);
	});

	it("refuses with no active problem", () => {
		const c = createChat("Empty", "practice");
		assert.equal(server.annotateActiveProblem(c.id, { path: "solution.py", line: 1, note: "x" }).ok, false);
	});
});

describe("saves and dismissal", () => {
	it("a save moves notes with their code and outdates deleted ones", () => {
		const id = chat();
		server.annotateActiveProblem(id, { path: "solution.py", line: 3, endLine: 4, note: "loop" });
		server.annotateActiveProblem(id, { path: "solution.py", line: 5, note: "return" });
		server.saveWorkspace(id, "call_p1", [{ path: "solution.py", content: "# reversed\n" + STARTER[0]!.content.replace("    return out\n", "    return out[::-1]\n") }]);
		const [loop, ret] = server.workspaceAnnotations(id, "call_p1");
		assert.deepEqual([loop!.line, loop!.endLine, loop!.outdated], [4, 5, undefined]);
		assert.equal(ret!.outdated, true);
	});

	it("the learner can dismiss a note", () => {
		const id = chat();
		server.annotateActiveProblem(id, { path: "solution.py", line: 1, note: "x" });
		const [a] = server.workspaceAnnotations(id, "call_p1");
		assert.deepEqual(server.dismissAnnotation(id, "call_p1", a!.id), []);
	});
});
