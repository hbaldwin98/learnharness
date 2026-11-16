/**
 * PROJECT CONTAINERS AGAINST REAL DOCKER. Opt-in: LH_DOCKER_TESTS=1 with Docker running.
 * Builds the python image on first use. The container and HOME volume are removed afterwards.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createDockerRunner } from "../src/server/docker-runner.ts";
import { createProjectContainers } from "../src/server/project-container.ts";
import { createTerminals } from "../src/server/terminals.ts";

const enabled = process.env.LH_DOCKER_TESTS === "1";

describe("project containers — real Docker", { skip: enabled ? false : "set LH_DOCKER_TESTS=1 with Docker running" }, () => {
	const runner = createDockerRunner({ imageRoot: path.join(import.meta.dirname, "..", "docker"), sweep: false });
	const containers = createProjectContainers(runner, { sweep: false });
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-proj-docker-"));
	const project = { id: `test-${process.pid}`, image: "python" as const, hostPath: folder };
	after(async () => {
		await containers.destroy(project.id);
		containers.dispose();
		runner.dispose();
		fs.rmSync(folder, { recursive: true, force: true });
	});

	it("mounts the host folder read-write and keeps HOME across container restarts", { timeout: 900_000 }, async () => {
		fs.writeFileSync(path.join(folder, "hello.py"), "print('from host')\n");
		const run = await containers.run(project, "python3 hello.py && echo made > out.txt && echo cached > $HOME/c.txt");
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout.trim(), "from host");
		assert.equal(fs.readFileSync(path.join(folder, "out.txt"), "utf8").trim(), "made");
		await containers.remove(project.id);
		const again = await containers.run(project, "cat $HOME/c.txt && pwd");
		assert.equal(again.code, 0, again.stderr);
		assert.deepEqual(again.stdout.trim().split("\n"), ["cached", "/work"]);
	});

	it("opens an interactive shell in /work", { timeout: 120_000 }, async () => {
		let output = "";
		let exited = false;
		const terminals = createTerminals({ container: () => containers.ensure(project), emit: e => { if (e.data) output += e.data; if (e.exited) exited = true; } });
		await terminals.open(project.id, { cols: 100, rows: 30 });
		terminals.write(project.id, "echo term-$((40+2)) && pwd\n");
		const deadline = Date.now() + 20_000;
		while (!/term-42[\s\S]*\/work/.test(output) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
		assert.match(output, /term-42[\s\S]*\/work/);
		const again = await terminals.open(project.id, { cols: 100, rows: 30 });
		assert.match(again.backlog, /term-42/, "reopening replays the backlog");
		terminals.close(project.id);
		assert.equal(exited, true);
	});

	it("has network",{ timeout: 120_000 }, async () => {
		const run = await containers.run(project, "python3 -c \"import socket; socket.getaddrinfo('pypi.org', 443); print('dns ok')\"");
		assert.equal(run.stdout.trim(), "dns ok", run.stderr);
	});
});
