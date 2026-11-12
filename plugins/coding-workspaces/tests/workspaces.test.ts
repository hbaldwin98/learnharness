import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkspaces, type SteerInput, type WorkspaceDeps, type WorkspaceRecord } from "../src/server/workspaces.ts";
import { LISTEN_TIMING } from "../src/shared/listening.ts";
import type { CodingTestResult, DockerStatus, WorkspaceState } from "../src/shared/protocol.ts";

const passed: CodingTestResult = { status: "passed", exitCode: 0, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false };
const tests = { program: "python3", args: ["-"], code: "print('t')" };

function fixture(opts: { docker?: DockerStatus; listening?: boolean } = {}) {
	let clock = 1_000_000;
	const steers: Array<{ chatId: string; input: SteerInput }> = [];
	const markers: Array<{ chatId: string; modelText?: string }> = [];
	const states: WorkspaceState[] = [];
	const saved = new Map<string, WorkspaceRecord>();
	const recipes: string[] = [];
	const deps: WorkspaceDeps = {
		runner: {
			status: async () => opts.docker ?? "running",
			ensureImage: async () => ({ ok: true }),
			runRecipe: async ({ answer }) => { recipes.push(answer); return passed; },
			remove: async () => {},
		},
		startDiagnostics: () => ({ snapshot: () => ({ status: "ready", name: "Python", diagnostics: [] }), update() {}, stop: async () => {} }),
		store: { load: key => saved.get(`${key.chatId}/${key.itemId}`) ?? null, save: record => { saved.set(`${record.chatId}/${record.itemId}`, structuredClone(record)); } },
		emitState: state => states.push(state),
		steer: async (chatId, input) => { steers.push({ chatId, input }); return { delivery: "woke" }; },
		appendMarker: async (chatId, input) => { markers.push({ chatId, ...(input.modelText ? { modelText: input.modelText } : {}) }); return {}; },
		settings: () => ({ listening: opts.listening ?? true }),
		now: () => clock,
		log: () => {},
	};
	const ws = createWorkspaces(deps);
	const key = { chatId: "chat", itemId: "p1" };
	const open = () => ws.open({ ...key, kind: "problem", language: "python", tests, code: "def f():\n    pass\n" });
	return { ws, key, open, steers, markers, states, saved, recipes, advance: (ms: number) => { clock += ms; } };
}

describe("workspace service", () => {
	it("opens an item, runs its tests in the sandbox and records the run (no grading)", async () => {
		const f = fixture();
		const state = await f.open();
		assert.equal(state.image, "python");
		const run = await f.ws.run(f.key, "def f():\n    return 1\n");
		assert.equal(run.result.status, "passed");
		assert.deepEqual(f.recipes, ["def f():\n    return 1\n"]);
		assert.equal(f.ws.state(f.key).runs.length, 1);
		assert.equal(f.steers.length, 0);
	});

	it("refuses Run without Docker, recording why", async () => {
		const f = fixture({ docker: "stopped" });
		await f.open();
		const run = await f.ws.run(f.key, "x");
		assert.equal(run.result.status, "error");
		assert.match(run.result.message!, /Docker is not running/);
		assert.deepEqual(f.recipes, []);
	});

	it("Ask steers as the learner with the trace, then later traces only carry what is new", async () => {
		const f = fixture();
		await f.open();
		f.ws.narrate(f.key, "trying a loop");
		await f.ws.run(f.key, "def f():\n    return 1\n");
		await f.ws.ask(f.key, "why does it fail?", "def f():\n    return 1\n");
		const ask = f.steers[0]!.input;
		assert.equal(ask.trigger, "learner");
		assert.equal(ask.displayText, "Ask: why does it fail?");
		assert.match(ask.modelText, /why does it fail\?/);
		assert.match(ask.modelText, /trying a loop/);
		assert.match(ask.modelText, /Run at .*passed/);
		assert.equal(f.ws.quietAllowed("chat"), false);
		await f.ws.ask(f.key, "", "def f():\n    return 1\n");
		assert.doesNotMatch(f.steers[1]!.input.modelText, /trying a loop|Run at/);
	});

	it("listens: a Run cue fires one background update when present and idle; stay_quiet is then allowed", async () => {
		const f = fixture();
		await f.open();
		await f.ws.run(f.key, "x = 1\n");
		await f.ws.tick();
		assert.equal(f.steers.length, 0, "absent: no presence heartbeat yet");
		f.ws.presence(f.key);
		f.ws.turnStarted("chat");
		await f.ws.tick();
		assert.equal(f.steers.length, 0, "busy while a turn runs");
		f.ws.turnSettled("chat");
		await f.ws.tick();
		assert.equal(f.steers.length, 1);
		assert.equal(f.steers[0]!.input.trigger, "background");
		assert.match(f.steers[0]!.input.displayText, /after your Run/);
		assert.equal(f.ws.quietAllowed("chat"), true);
		await f.ws.run(f.key, "x = 2\n");
		f.advance(1000);
		f.ws.presence(f.key);
		await f.ws.tick();
		assert.equal(f.steers.length, 1, "the minimum gap holds the next update");
		f.advance(LISTEN_TIMING.minGapMs);
		f.ws.presence(f.key);
		await f.ws.tick();
		assert.equal(f.steers.length, 2);
	});

	it("never listens when the setting is off", async () => {
		const f = fixture({ listening: false });
		await f.open();
		await f.ws.run(f.key, "x");
		f.ws.presence(f.key);
		await f.ws.tick();
		assert.equal(f.steers.length, 0);
	});

	it("annotates the open item's current code; notes follow edits and go outdated", async () => {
		const f = fixture();
		assert.equal(f.ws.annotate("chat", { line: 1, note: "x" }).ok, false);
		await f.open();
		const bad = f.ws.annotate("chat", { line: 9, note: "x" });
		assert.equal(bad.ok, false);
		const good = f.ws.annotate("chat", { line: 2, note: "this does nothing" });
		assert.ok(good.ok);
		f.ws.code(f.key, "# top\ndef f():\n    pass\n");
		assert.equal(f.ws.state(f.key).annotations[0]!.line, 3);
		f.ws.code(f.key, "def f():\n    return 1\n");
		assert.equal(f.ws.state(f.key).annotations[0]!.outdated, true);
	});

	it("adds the trace beside a graded submission as a marker, without the code", async () => {
		const f = fixture();
		await f.open();
		f.ws.narrate(f.key, "I'm stuck on the edge case");
		await f.ws.submitted(f.key, "final code\n");
		assert.equal(f.markers.length, 1);
		assert.match(f.markers[0]!.modelText!, /edge case/);
		assert.doesNotMatch(f.markers[0]!.modelText!, /final code/);
		await f.ws.submitted(f.key, "final code\n");
		assert.equal(f.markers.length, 1, "nothing new: no marker");
	});

	it("persists the record and restores it on reopen", async () => {
		const f = fixture();
		await f.open();
		f.ws.narrate(f.key, "hello");
		await f.ws.close(f.key);
		const state = await f.open();
		assert.equal(state.narration[0]?.text, "hello");
	});
});
