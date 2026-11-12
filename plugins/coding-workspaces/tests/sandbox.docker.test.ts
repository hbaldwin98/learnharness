/**
 * THE SANDBOX AGAINST REAL DOCKER. Opt-in (like the old fork suite): set
 * LH_DOCKER_TESTS=1 with Docker running. The first run builds the python and
 * node images (minutes). Containers are removed afterwards.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createDockerRunner } from "../src/server/docker-runner.ts";

const enabled = process.env.LH_DOCKER_TESTS === "1";
const CHAT = `test-docker-${process.pid}`;

describe("coding sandbox — real Docker", { skip: enabled ? false : "set LH_DOCKER_TESTS=1 with Docker running" }, () => {
	const runner = createDockerRunner({ imageRoot: path.join(import.meta.dirname, "..", "docker"), sweep: false });
	after(() => runner.reapAll());

	it("Docker is running", async () => assert.equal(await runner.status(), "running"));

	it("runs a Python recipe against answer.txt: pass, fail, timeout", { timeout: 900_000 }, async () => {
		assert.deepEqual(await runner.ensureImage("python"), { ok: true });
		const key = { chatId: CHAT, itemId: "py" };
		const tests = (body: string) => ({ program: "python3", args: ["-"], code: `ns = {}\nexec(open('answer.txt').read(), ns)\n${body}\n` });
		const pass = await runner.runRecipe({ key, image: "python", answer: "def sq(x):\n    return x * x\n", tests: tests("assert ns['sq'](3) == 9\nprint('ok')") });
		assert.equal(pass.status, "passed");
		assert.equal(pass.stdout.trim(), "ok");
		const fail = await runner.runRecipe({ key, image: "python", answer: "def sq(x):\n    return x\n", tests: tests("assert ns['sq'](3) == 9") });
		assert.equal(fail.status, "failed");
		const loop = await runner.runRecipe({ key, image: "python", answer: "", tests: tests("while True: pass") });
		assert.equal(loop.status, "error");
		assert.match(loop.message!, /30 second/);
	});

	it("has no network", { timeout: 900_000 }, async () => {
		const key = { chatId: CHAT, itemId: "net" };
		const result = await runner.runRecipe({ key, image: "python", answer: "", tests: { program: "python3", args: ["-"], code: "import socket\nsocket.create_connection(('1.1.1.1', 53), timeout=3)\n" } });
		assert.equal(result.status, "failed");
	});

	it("reports a missing program", { timeout: 900_000 }, async () => {
		const result = await runner.runRecipe({ key: { chatId: CHAT, itemId: "missing" }, image: "python", answer: "", tests: { program: "ruby", args: ["-"], code: "" } });
		assert.equal(result.status, "error");
		assert.match(result.message!, /not available/);
	});
});
