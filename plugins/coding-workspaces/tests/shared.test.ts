import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorOf, reanchor } from "../src/shared/annotations.ts";
import { lineDiff } from "../src/shared/line-diff.ts";
import { addCue, isStruggle, LISTEN_TIMING, listenDecision, newListenState, timerCues } from "../src/shared/listening.ts";
import { capText, formatTrace } from "../src/shared/trace.ts";
import type { CodeAnnotation } from "../src/shared/protocol.ts";

describe("line diff", () => {
	it("returns unified hunks, empty for equal text", () => {
		assert.equal(lineDiff("a\nb\n", "a\nb\n"), "");
		assert.equal(lineDiff("a\nb\nc\n", "a\nB\nc\n"), "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
	});
});

describe("annotations", () => {
	const code = "def f(xs):\n    for i in range(len(xs) + 1):\n        pass\n";
	const note: CodeAnnotation = { id: "a", line: 2, endLine: 2, note: "loop bound", at: "", anchor: anchorOf(code, 2, 2) };
	it("follow their lines as code moves, and go outdated when deleted", () => {
		assert.equal(reanchor(note, code), note);
		assert.equal(reanchor(note, `# header\n${code}`).line, 3);
		assert.equal(reanchor(note, "def f(xs):\n    pass\n").outdated, true);
	});
});

describe("listening", () => {
	it("hears struggle phrases, curly apostrophes included", () => {
		assert.ok(isStruggle("Hmm, I’m stuck here"));
		assert.ok(!isStruggle("this works"));
	});
	it("fires coalesced cues only when present, enabled, idle and past the gap", () => {
		const state = newListenState(0);
		const gates = { enabled: true, backgroundAllowed: true, turnRunning: false, recordBlocked: false };
		assert.deepEqual(listenDecision(state, 1000, gates), { fire: false, why: "nothing" });
		addCue(state, "run");
		addCue(state, "run");
		const t = LISTEN_TIMING.presenceMs + 1000;
		assert.deepEqual(listenDecision(state, t, gates), { fire: false, why: "absent" });
		state.presentAt = t;
		assert.deepEqual(listenDecision(state, t, { ...gates, enabled: false }), { fire: false, why: "off" });
		assert.deepEqual(listenDecision(state, t, { ...gates, turnRunning: true }), { fire: false, why: "busy" });
		assert.deepEqual(listenDecision(state, t, gates), { fire: true, cues: ["run"] });
		state.lastListenAt = t;
		assert.deepEqual(listenDecision(state, t + 1000, gates), { fire: false, why: "gap" });
	});
	it("raises silence once per quiet stretch", () => {
		const state = newListenState(0);
		timerCues(state, LISTEN_TIMING.silenceMs, 0);
		assert.deepEqual(state.pending, ["silence"]);
		state.pending = [];
		timerCues(state, LISTEN_TIMING.silenceMs * 2, 0);
		assert.deepEqual(state.pending, []);
	});
});

describe("trace", () => {
	it("bundles narration, runs, the code change and editor problems", () => {
		const text = formatTrace("Head.", {
			language: "Python",
			narration: [{ at: "2026-01-01T10:00:00Z", text: "trying a loop" }],
			runs: [{ at: "2026-01-01T10:01:00Z", result: { status: "failed", exitCode: 1, stdout: "", stderr: "AssertionError", stdoutTruncated: false, stderrTruncated: false } }],
			seenCode: `${"x\n".repeat(40)}a\nb\nc\n${"y\n".repeat(40)}`,
			code: `${"x\n".repeat(40)}a\nB\nc\n${"y\n".repeat(40)}`,
			diagnostics: [{ path: "answer.py", line: 1, column: 0, endLine: 1, endColumn: 1, severity: "error", message: "bad" }],
		});
		assert.match(text, /^Head\./);
		assert.match(text, /trying a loop/);
		assert.match(text, /failed \(exit 1\)/);
		assert.match(text, /```diff\n@@/);
		assert.match(text, /line 2:1 error: bad/);
	});
	it("caps agent output from the end", () => {
		assert.match(capText("x".repeat(20), 10), /^… \(10 bytes truncated\)\nx{10}$/);
	});
});
