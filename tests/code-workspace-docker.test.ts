/**
 * THE CODING WORKSPACE AGAINST REAL DOCKER (plan step 2). Opt-in: set
 * LH_DOCKER_TESTS=1 with Docker running — the first run builds every
 * language image (minutes, several GB), so the ordinary `npm test` skips
 * this suite. Per language, one small problem (reverse a list): the
 * reference passes, a wrong reference is refused, a starter with a
 * syntax error is refused, an infinite loop times out. Plus: no network.
 * Containers are removed afterwards (this suite's chat id only).
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";

import { CODE_LANGUAGES, type CodeFile, type CodeLanguage } from "../src/agent/workspaces/code/languages.ts";
import { createCodeModule, overlay, type CodePose } from "../src/agent/workspaces/code/module.ts";
import { createDockerRunner } from "../src/server/workspaces/docker-runner.ts";

function dockerRunning(): boolean {
	try {
		execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe", timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

const enabled = process.env.LH_DOCKER_TESTS === "1" && dockerRunning();
const CHAT = `test-docker-${process.pid}`;
import { f, FIXTURES } from "./helpers/code-fixtures.ts";

describe("coding workspace — real Docker", { skip: enabled ? false : "set LH_DOCKER_TESTS=1 with Docker running" }, () => {
	const runner = createDockerRunner({ sweep: false });
	const code = createCodeModule(runner);
	after(() => runner.retainOnly(CHAT, null));

	for (const language of CODE_LANGUAGES) {
		const fixture = FIXTURES[language];
		const verify = (pose: CodePose, id: string) =>
			code.verifyPose(pose, { chatId: CHAT, problemCallId: `${language}-${id}`, onProgress: () => {} });

		describe(language, () => {
			it("a correct reference passes; the container stays warm", { timeout: 30 * 60_000 }, async () => {
				assert.deepEqual(await verify(fixture.pose, "ok"), []);
			});

			it("a wrong reference is refused with the failing test", { timeout: 5 * 60_000 }, async () => {
				const errors = await verify({ ...fixture.pose, reference: fixture.wrong }, "wrong");
				assert.match(errors.join("\n"), /does not pass every test[\s\S]*✗/);
			});

			it("a starter with a syntax error is refused", { timeout: 5 * 60_000 }, async () => {
				const errors = await verify({ ...fixture.pose, files: overlay(fixture.pose.files, fixture.syntax) }, "syntax");
				assert.match(errors.join("\n"), /starter files do not build/);
			});

			it("an infinite loop in the reference times out", { timeout: 5 * 60_000 }, async () => {
				const errors = await verify({ ...fixture.pose, reference: fixture.loop }, "loop");
				assert.match(errors.join("\n"), /timed out/);
			});
		});
	}

	it("containers have no network", { timeout: 5 * 60_000 }, async () => {
		const outcome = await runner.run({
			key: { chatId: CHAT, problemCallId: "net" },
			image: "node",
			files: [f("net.mjs", "fetch('http://1.1.1.1').then(() => console.log('NET'), () => console.log('NONET'));\n")],
			steps: [{ phase: "test", command: "node net.mjs", timeoutMs: 10_000 }],
			report: null,
		});
		assert.match(outcome.report ?? "", /NONET/);
	});
});
