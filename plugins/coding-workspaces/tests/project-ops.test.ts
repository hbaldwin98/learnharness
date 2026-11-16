/**
 * The project operations end to end over a fake plugin context (no Docker):
 * create/attach/state, proposals through the tool and Accept, suggestions, notes,
 * and the registered tools / problem type / instructions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { registerProjectOps } from "../src/server/project-ops.ts";
import type { DockerRunner } from "../src/server/docker-runner.ts";
import { OPS, type ProjectsState } from "../src/shared/protocol.ts";

let data: string;
beforeEach(() => { data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ops-")); });
afterEach(() => { fs.rmSync(data, { recursive: true, force: true }); });

function fakeContext() {
	const handlers = new Map<string, (input: unknown) => unknown>();
	const markers: Array<{ chatId: string; modelText?: string }> = [];
	const steers: Array<{ chatId: string; modelText: string }> = [];
	const toolFactories: Array<(context: { chatId: string }) => Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>> = [];
	const problemTypes: string[] = [];
	const instructions: string[] = [];
	const abort = new AbortController();
	const ctx = {
		dataDirectory: data,
		signal: abort.signal,
		events: { emit: () => {} },
		handle: (name: string, fn: (input: unknown) => unknown) => { handlers.set(name, fn); return () => handlers.delete(name); },
		turns: { steer: async (chatId: string, input: { modelText: string }) => { steers.push({ chatId, modelText: input.modelText }); return { delivery: "woke" }; } },
		markers: { append: async (chatId: string, input: { modelText?: string }) => { markers.push({ chatId, ...(input.modelText ? { modelText: input.modelText } : {}) }); return {}; } },
		registerTools: (def: { create: (typeof toolFactories)[number] }) => { toolFactories.push(def.create); return () => {}; },
		registerInstructions: (def: { text: string }) => { instructions.push(def.text); return () => {}; },
		registerProblemType: (def: { id: string }) => { problemTypes.push(def.id); return () => {}; },
	} as unknown as PluginBackendContext;
	// Docker "stopped": nothing here may need a container.
	const runner = { status: async () => "stopped", engine: () => { throw new Error("no docker"); }, tagOf: () => "x", ensureImage: async () => ({ ok: true }) } as unknown as DockerRunner;
	const cleanups = registerProjectOps(ctx, runner);
	const call = async <T>(op: string, input: Record<string, unknown>) => await handlers.get(op)!(input) as T;
	const tool = (chatId: string, name: string) => toolFactories.flatMap(f => f({ chatId })).find(t => t.name === name)!;
	return { call, tool, markers, steers, problemTypes, instructions, dispose: async () => { for (const c of cleanups.reverse()) await c(); } };
}

describe("project ops", () => {
	it("creates, attaches and shares a project between chats", async () => {
		const f = fakeContext();
		const created = await f.call<ProjectsState>(OPS.projectCreate, { chatId: "c1", name: "App", image: "python", runCommand: "pytest" });
		assert.equal(created.attached?.name, "App");
		assert.equal(created.runtime?.docker, "stopped");
		const other = await f.call<ProjectsState>(OPS.projectAttach, { chatId: "c2", id: created.attached!.id });
		assert.deepEqual(other.attached?.sessions.sort(), ["c1", "c2"]);
		assert.deepEqual(f.problemTypes, ["project-task"]);
		assert.ok(f.instructions.some(t => t.includes("project_suggest")));
		await f.dispose();
	});

	it("tutor proposal → pane Accept writes the file and tells the proposing chat", async () => {
		const f = fakeContext();
		const s = await f.call<ProjectsState>(OPS.projectCreate, { chatId: "c", name: "App", image: "python" });
		const root = s.attached!.hostPath;
		await f.tool("c", "project_propose_edit").execute("t", { path: "app.py", explanation: "start", content: "print('hi')\n" });
		const pending = await f.call<ProjectsState>(OPS.projectsGet, { chatId: "c" });
		assert.equal(pending.proposals.length, 1);
		assert.equal(fs.existsSync(path.join(root, "app.py")), false);
		const after = await f.call<ProjectsState>(OPS.proposalDecide, { chatId: "c", id: pending.proposals[0]!.id, accept: true });
		assert.equal(after.proposals.length, 0);
		assert.equal(fs.readFileSync(path.join(root, "app.py"), "utf8"), "print('hi')\n");
		assert.match(f.markers.at(-1)!.modelText!, /app\.py was accepted/);
		await f.dispose();
	});

	it("notes from the tool show in state and can be dismissed; read-file and files work", async () => {
		const f = fakeContext();
		const s = await f.call<ProjectsState>(OPS.projectCreate, { chatId: "c", name: "App", image: "python" });
		fs.writeFileSync(path.join(s.attached!.hostPath, "a.py"), "x = 1\ny = 2\n");
		await f.tool("c", "project_annotate").execute("t", { path: "a.py", line: 2, note: "why 2?" });
		const withNote = await f.call<ProjectsState>(OPS.projectsGet, { chatId: "c" });
		assert.equal(withNote.notes[0]?.note, "why 2?");
		assert.deepEqual((await f.call<{ files: string[] }>(OPS.projectFiles, { chatId: "c" })).files, ["a.py"]);
		assert.equal((await f.call<{ content: string }>(OPS.projectReadFile, { chatId: "c", path: "a.py" })).content, "x = 1\ny = 2\n");
		const dismissed = await f.call<ProjectsState>(OPS.noteDismiss, { chatId: "c", id: withNote.notes[0]!.id });
		assert.deepEqual(dismissed.notes, []);
		await f.dispose();
	});

	it("tutor suggestion → pane Create makes and attaches the project", async () => {
		const f = fakeContext();
		await f.tool("c", "project_suggest").execute("t", { name: "Todo API", image: "node", runCommand: "npm test", reason: "build it up" });
		const suggested = await f.call<ProjectsState>(OPS.projectsGet, { chatId: "c" });
		assert.equal(suggested.suggestion?.name, "Todo API");
		const created = await f.call<ProjectsState>(OPS.suggestionDecide, { chatId: "c", accept: true });
		assert.equal(created.attached?.name, "Todo API");
		assert.equal(created.attached?.runCommand, "npm test");
		assert.equal(created.suggestion, null);
		assert.match(f.markers.at(-1)!.modelText!, /created and attached/);
		await assert.rejects(f.tool("c", "project_suggest").execute("t", { name: "Again", image: "node", runCommand: "", reason: "" }), /already has a project/);
		await f.dispose();
	});

	it("Run without Docker records the reason; Ask steers with the trace", async () => {
		const f = fakeContext();
		await f.call<ProjectsState>(OPS.projectCreate, { chatId: "c", name: "App", image: "python", runCommand: "pytest" });
		const run = await f.call<{ error?: string }>(OPS.projectRun, { chatId: "c" });
		assert.equal(run.error, "Docker is not running");
		await f.call(OPS.projectAsk, { chatId: "c", text: "where do I start?" });
		assert.match(f.steers[0]!.modelText, /where do I start\?[\s\S]*Project workspace "App"[\s\S]*Docker is not running/);
		await f.dispose();
	});
});
