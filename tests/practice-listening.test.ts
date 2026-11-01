/**
 * PRACTICE CODING WORKSPACE — listening (docs/practice-workspaces-plan.md,
 * step 6): the pure cue engine, the server listener over fake dependencies
 * (presence, activity, the floor, coalescing, a refused start), the listen
 * input and marker, the stay_quiet gate, the projection, and the setting.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	addCue,
	isStruggle,
	LISTEN_TIMING,
	listenDecision,
	newListenState,
	timerCues,
	type ListenGates,
} from "../src/core/listening.ts";
import { createListening, type ListeningDeps } from "../src/server/listening.ts";
import { inputAppends, ChatInputError, type ListenInput } from "../src/core/input-events.ts";
import { lastInputIsListen, nativeInputCause, newListenMessage, type LhMessage } from "../src/core/native-messages.ts";
import { projectView, quietListenIds } from "../src/core/view.ts";
import { stayQuietTool } from "../src/agent/tools/practice.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { composeListening } from "../components/settings/coding-section.tsx";

const OPEN: ListenGates = { enabled: true, backgroundAllowed: true, turnRunning: false, recordBlocked: false };

const PROBLEM_ARGS = {
	statement: "Reverse a list.",
	mode: "composition",
	modelSolution: "Slice.",
	workspace: { module: "code", language: "python", files: [{ path: "solution.py", content: "x\n" }], tests: { visible: [], hidden: [] }, reference: [] },
};
const pose = (callId = "call_p1", at = 1_000): LhMessage[] => [
	{ id: `a_${callId}`, role: "assistant", content: [{ type: "toolCall", id: callId, name: "problem", arguments: PROBLEM_ARGS }], stopReason: "toolUse", timestamp: at } as unknown as LhMessage,
	{ id: `r_${callId}`, role: "toolResult", toolCallId: callId, toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at + 1 } as unknown as LhMessage,
];

describe("the cue engine", () => {
	it("fires silence once per quiet stretch and re-arms on new activity", () => {
		const s = newListenState(0);
		timerCues(s, LISTEN_TIMING.silenceMs - 1, 0);
		assert.deepEqual(s.pending, []);
		timerCues(s, LISTEN_TIMING.silenceMs, 0);
		assert.deepEqual(s.pending, ["silence"]);
		s.pending = [];
		timerCues(s, LISTEN_TIMING.silenceMs * 3, LISTEN_TIMING.silenceMs + 1_000);
		assert.deepEqual(s.pending, [], "the agent's look does not re-arm silence");
		s.lastActivityAt = 500_000;
		timerCues(s, 500_000 + LISTEN_TIMING.silenceMs, 450_000);
		assert.deepEqual(s.pending, ["silence"]);
	});

	it("measures silence from the later of the activity and the agent's last turn", () => {
		const s = newListenState(0);
		timerCues(s, LISTEN_TIMING.silenceMs + 5_000, 10_000);
		assert.deepEqual(s.pending, []);
		timerCues(s, LISTEN_TIMING.silenceMs + 10_000, 10_000);
		assert.deepEqual(s.pending, ["silence"]);
	});

	it("fires the interval only with activity since the agent last looked", () => {
		const s = newListenState(0);
		s.silenceFiredFor = 0; // isolate the interval
		timerCues(s, LISTEN_TIMING.intervalMs + 1, 1);
		assert.deepEqual(s.pending, []);
		s.lastActivityAt = 1_000;
		s.silenceFiredFor = 1_000;
		timerCues(s, LISTEN_TIMING.intervalMs + 1, 1);
		assert.deepEqual(s.pending, ["interval"]);
	});

	it("coalesces cues", () => {
		const s = newListenState(0);
		addCue(s, "run");
		addCue(s, "run");
		addCue(s, "struggle");
		assert.deepEqual(s.pending, ["run", "struggle"]);
	});

	it("gates: off, nothing, absent, paused, busy, the 60 s floor, then fire", () => {
		const s = newListenState(0);
		const now = 100_000;
		assert.deepEqual(listenDecision(s, now, { ...OPEN, enabled: false }), { fire: false, why: "off" });
		assert.deepEqual(listenDecision(s, now, OPEN), { fire: false, why: "nothing" });
		addCue(s, "run");
		assert.deepEqual(listenDecision(s, now, OPEN), { fire: false, why: "absent" });
		s.presentAt = now - 1_000;
		assert.deepEqual(listenDecision(s, now, { ...OPEN, backgroundAllowed: false }), { fire: false, why: "paused" });
		assert.deepEqual(listenDecision(s, now, { ...OPEN, turnRunning: true }), { fire: false, why: "busy" });
		assert.deepEqual(listenDecision(s, now, { ...OPEN, recordBlocked: true }), { fire: false, why: "busy" });
		s.lastListenAt = now - LISTEN_TIMING.minGapMs + 1;
		assert.deepEqual(listenDecision(s, now, OPEN), { fire: false, why: "gap" });
		s.lastListenAt = now - LISTEN_TIMING.minGapMs;
		assert.deepEqual(listenDecision(s, now, OPEN), { fire: true, cues: ["run"] });
	});

	it("matches struggle phrases case-insensitively, curly apostrophes included", () => {
		assert.equal(isStruggle("Hmm, I’M STUCK on the base case"), true);
		assert.equal(isStruggle("what am I missing here"), true);
		assert.equal(isStruggle("this should work now"), false);
	});
});

/** A fake world for the listener: a clock, one chat record, gates. */
function world() {
	let now = 1_000_000;
	const fired: ListenInput[] = [];
	const w = {
		messages: pose("call_p1", now) as LhMessage[] | null,
		enabled: true,
		background: true,
		running: false,
		result: 200,
		advance: (ms: number) => (now += ms),
		fired,
	};
	const deps: ListeningDeps = {
		now: () => now,
		messages: () => w.messages,
		enabled: () => w.enabled,
		backgroundAllowed: () => w.background,
		turnRunning: () => w.running,
		run: async (_chatId, input) => {
			fired.push(input);
			return w.result;
		},
	};
	return { w, listening: createListening(deps) };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("the listener", () => {
	it("ignores activity until the pane reports in, then a Run fires at once", async () => {
		const { w, listening } = world();
		listening.activity("chat", "call_p1", "run");
		await flush();
		assert.equal(w.fired.length, 0);
		assert.equal(listening.presence("chat", "call_p1", true), "on");
		listening.activity("chat", "call_p1", "run");
		await flush();
		assert.deepEqual(w.fired, [{ type: "listen", problemCallId: "call_p1", cues: ["run"] }]);
	});

	it("holds cues under the 60 s floor and coalesces them into the next update", async () => {
		const { w, listening } = world();
		listening.presence("chat", "call_p1", true);
		listening.activity("chat", "call_p1", "run");
		await flush();
		w.advance(10_000);
		listening.presence("chat", "call_p1", true);
		listening.activity("chat", "call_p1", "run");
		listening.activity("chat", "call_p1", "narration", "ok I'm stuck");
		await flush();
		assert.equal(w.fired.length, 1);
		w.advance(LISTEN_TIMING.minGapMs);
		listening.presence("chat", "call_p1", true);
		await listening.tick();
		assert.equal(w.fired.length, 2);
		assert.deepEqual(w.fired[1]!.cues, ["run", "struggle"]);
	});

	it("doesn't fire while the pane is hidden or a turn is running, and fires once they clear", async () => {
		const { w, listening } = world();
		listening.presence("chat", "call_p1", false);
		listening.presence("chat", "call_p1", true);
		listening.presence("chat", "call_p1", false);
		listening.activity("chat", "call_p1", "run");
		await flush();
		assert.equal(w.fired.length, 0);
		listening.presence("chat", "call_p1", true);
		w.running = true;
		await listening.tick();
		assert.equal(w.fired.length, 0);
		w.running = false;
		await listening.tick();
		assert.equal(w.fired.length, 1);
	});

	it("reports paused when background use is off, and off when the setting is", () => {
		const { w, listening } = world();
		w.background = false;
		assert.equal(listening.presence("chat", "call_p1", true), "paused");
		w.enabled = false;
		assert.equal(listening.presence("chat", "call_p1", true), "off");
	});

	it("puts the cues back when the turn didn't start", async () => {
		const { w, listening } = world();
		w.result = 409;
		listening.presence("chat", "call_p1", true);
		listening.activity("chat", "call_p1", "run");
		await flush();
		assert.equal(w.fired.length, 1);
		assert.deepEqual(listening.peek("chat", "call_p1")?.pending, ["run"]);
		assert.equal(listening.peek("chat", "call_p1")?.lastListenAt, 0);
		w.result = 200;
		await listening.tick();
		assert.equal(w.fired.length, 2);
	});

	it("fires silence after a quiet stretch, and drops the listener once the problem ends", async () => {
		const { w, listening } = world();
		listening.presence("chat", "call_p1", true);
		w.advance(LISTEN_TIMING.silenceMs);
		listening.presence("chat", "call_p1", true);
		await listening.tick();
		assert.deepEqual(w.fired.map((f) => f.cues), [["silence"]]);
		w.messages = [];
		await listening.tick();
		assert.equal(listening.peek("chat", "call_p1"), undefined);
	});
});

describe("the listen input and marker", () => {
	const lookups = {
		snapshot: () => [{ path: "solution.py", content: "x\n" }],
		submission: () => null,
		trace: () => ({ narration: [{ at: "2026-11-01T10:00:00", text: "hmm" }], runs: [], changes: [], diagnostics: [] }),
	};

	it("appends an automatic practice-listen marker with the cue and the trace", () => {
		const [marker] = inputAppends({ messages: pose() }, { type: "listen", problemCallId: "call_p1", cues: ["run"] }, lookups);
		const m = marker as LhMessage & { customType: string; content: string };
		assert.equal(m.customType, "practice-listen");
		assert.match(m.content, /the learner did not ask/);
		assert.match(m.content, /they just ran the visible tests/);
		assert.match(m.content, /call stay_quiet/);
		assert.match(m.content, /\[10:00\] hmm/);
		assert.equal(nativeInputCause(m as never, []), "automatic");
		assert.equal(lastInputIsListen([...pose(), m]), true);
	});

	it("refuses once the problem is no longer active", () => {
		assert.throws(() => inputAppends({ messages: [] }, { type: "listen", problemCallId: "call_p1", cues: ["run"] }, lookups), ChatInputError);
	});

	it("knows when the last input is a listening update", () => {
		const listen = newListenMessage({ problemCallId: "call_p1", cues: ["silence"] });
		const reply = { id: "a2", role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 5 } as unknown as LhMessage;
		assert.equal(lastInputIsListen([...pose(), listen, reply]), true);
		assert.equal(lastInputIsListen([...pose(), listen, reply, { id: "u", role: "user", content: "x", timestamp: 6 } as unknown as LhMessage]), false);
	});
});

describe("stay_quiet", () => {
	it("is refused outside a listening turn and ends a listening turn", async () => {
		const refused = await stayQuietTool(false).execute("c1", {}, undefined as never);
		assert.match(JSON.stringify(refused.content), /asked you directly/);
		const quiet = await stayQuietTool(true).execute("c1", {}, undefined as never);
		assert.equal(quiet.terminate, true);
	});

	it("projects a quiet look as one line with 'nothing to add' and hides the call", () => {
		const listen = newListenMessage({ problemCallId: "call_p1", cues: ["run"] });
		const call = { id: "a2", role: "assistant", content: [{ type: "toolCall", id: "q1", name: "stay_quiet", arguments: {} }], stopReason: "toolUse", timestamp: 5 } as unknown as LhMessage;
		const result = { id: "r2", role: "toolResult", toolCallId: "q1", toolName: "stay_quiet", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 6 } as unknown as LhMessage;
		const messages = [...pose(), listen, call, result];
		assert.deepEqual([...quietListenIds(messages)], [listen.id]);
		const parts = projectView(messages).flatMap((m) => m.parts);
		const line = parts.find((p) => p.type === "data-practice-listen") as { data: { quiet: boolean; cues: string[] } } | undefined;
		assert.equal(line?.data.quiet, true);
		assert.deepEqual(line?.data.cues, ["run"]);
		assert.equal(parts.some((p) => p.type === "tool-stay_quiet"), false);
	});

	it("hides the agent's text in a quiet look", () => {
		const listen = newListenMessage({ problemCallId: "call_p1", cues: ["run"] });
		const call = { id: "a2", role: "assistant", content: [{ type: "text", text: "I'm not saying anything." }, { type: "toolCall", id: "q1", name: "stay_quiet", arguments: {} }], stopReason: "toolUse", timestamp: 5 } as unknown as LhMessage;
		const result = { id: "r2", role: "toolResult", toolCallId: "q1", toolName: "stay_quiet", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 6 } as unknown as LhMessage;
		const text = JSON.stringify(projectView([...pose(), listen, call, result]));
		assert.doesNotMatch(text, /not saying anything/);
	});

	it("a look the agent answered is not quiet", () => {
		const listen = newListenMessage({ problemCallId: "call_p1", cues: ["struggle"] });
		const reply = { id: "a2", role: "assistant", content: [{ type: "text", text: "Check the loop bound." }], stopReason: "stop", timestamp: 5 } as unknown as LhMessage;
		assert.equal(quietListenIds([...pose(), listen, reply]).size, 0);
	});
});

describe("the setting", () => {
	it("validates and composes agent.listening", () => {
		const ok = parseAgentSettingsBody({ listening: { enabled: false } });
		assert.equal(ok.ok, true);
		assert.deepEqual((ok as { settings: { listening?: unknown } }).settings.listening, { enabled: false });
		assert.equal(parseAgentSettingsBody({ listening: { enabled: "no" } }).ok, false);
		assert.deepEqual(composeListening({}, true).listening, { enabled: true });
	});
});
