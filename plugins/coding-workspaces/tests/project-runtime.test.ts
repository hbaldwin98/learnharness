import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExecResult } from "../src/server/docker-runner.ts";
import { containerUser, projectContainerSpec, PROJECT_HOME } from "../src/server/project-container.ts";
import { createProjectRuntime, type ProjectRuntimeDeps } from "../src/server/project-runtime.ts";
import type { DockerStatus } from "../src/shared/protocol.ts";

const ok: ExecResult = { code: 0, stdout: "hi", stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false };
const project = { id: "p1", image: "node" as const, hostPath: "/host/p1", runCommand: "npm test" };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-runtime-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(opts: { docker?: DockerStatus; exec?: ProjectRuntimeDeps["exec"] } = {}) {
	const commands: string[] = [];
	const stopped: string[] = [];
	let changes = 0;
	const runtime = createProjectRuntime({
		runsDirectory: dir,
		dockerStatus: async () => opts.docker ?? "running",
		containerRunning: async () => true,
		exec: opts.exec ?? (async (_p, command) => { commands.push(command); return ok; }),
		stopContainer: async id => { stopped.push(id); },
		changed: () => { changes++; },
	});
	return { runtime, commands, stopped, changes: () => changes };
}

describe("project container spec", () => {
	it("mounts the folder at /work and a HOME volume, with network and caps limits", () => {
		const spec = projectContainerSpec(project, "learnharness-code-node:abc", "1000:1000");
		assert.equal(spec.name, "lh-proj-p1");
		assert.equal(spec.WorkingDir, "/work");
		assert.deepEqual(spec.Env, [`HOME=${PROJECT_HOME}`]);
		assert.deepEqual(spec.HostConfig?.Mounts, [
			{ Type: "bind", Source: "/host/p1", Target: "/work" },
			{ Type: "volume", Source: "lh-proj-p1-home", Target: PROJECT_HOME },
		]);
		assert.equal(spec.HostConfig?.NetworkMode, undefined);
		assert.equal(spec.HostConfig?.ReadonlyRootfs, true);
		assert.deepEqual(spec.HostConfig?.SecurityOpt, ["no-new-privileges"]);
	});
	it("runs as the host uid on Linux, 1000 elsewhere", () => {
		assert.equal(containerUser("linux", { uid: 501, gid: 20 }), "501:20");
		assert.equal(containerUser("win32", { uid: undefined, gid: undefined }), "1000:1000");
	});
});

describe("project runtime", () => {
	it("runs the project's run command and keeps recent runs", async () => {
		const f = fixture();
		const run = await f.runtime.run(project);
		assert.equal(run.exitCode, 0);
		assert.deepEqual(f.commands, ["npm test"]);
		await f.runtime.run(project, "ls");
		const state = await f.runtime.state("p1");
		assert.deepEqual(state.runs.map(r => r.command), ["npm test", "ls"]);
		assert.equal(state.running, null);
		assert.ok(f.changes() >= 4);
	});
	it("keeps only the last 10 runs", async () => {
		const f = fixture();
		for (let i = 0; i < 12; i++) await f.runtime.run(project, `echo ${i}`);
		const runs = (await f.runtime.state("p1")).runs;
		assert.equal(runs.length, 10);
		assert.equal(runs[0]!.command, "echo 2");
	});
	it("refuses with no command, and records Docker being unavailable", async () => {
		const f = fixture({ docker: "stopped" });
		await assert.rejects(f.runtime.run({ ...project, runCommand: "" }), /run command/);
		const run = await f.runtime.run(project);
		assert.equal(run.error, "Docker is not running");
	});
	it("refuses a second concurrent run; stop aborts and restarts the container", async () => {
		const f = fixture({
			exec: (_p, _c, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
		});
		const first = f.runtime.run(project);
		await new Promise(r => setImmediate(r));
		assert.equal((await f.runtime.state("p1")).running, "Running npm test");
		await assert.rejects(f.runtime.run(project), /already in progress/);
		f.runtime.stop("p1");
		const run = await first;
		assert.equal(run.error, "Stopped");
		assert.deepEqual(f.stopped, ["p1"]);
	});
	it("restarts the container after a timeout", async () => {
		const f = fixture({ exec: async () => ({ ...ok, code: null, timedOut: true }) });
		const run = await f.runtime.run(project);
		assert.equal(run.timedOut, true);
		assert.deepEqual(f.stopped, ["p1"]);
	});
});
