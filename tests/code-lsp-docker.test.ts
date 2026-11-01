/**
 * LANGUAGE SERVERS — real Docker (docs/practice-workspaces-plan.md, step 4;
 * opt-in: LH_DOCKER_TESTS=1 with Docker running). Per language: the server
 * starts in the problem's container, a syntax error in the learner's file
 * yields an error there, the reference clears it, and the hidden tests are
 * never written to /work/lsp.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";

import { CODE_LANGUAGES, LANGUAGES, LSP_ROOT } from "../src/agent/workspaces/code/languages.ts";
import { createDiagnosticsSession, type DiagnosticsSession } from "../src/agent/workspaces/code/diagnostics.ts";
import { createDockerRunner } from "../src/server/workspaces/docker-runner.ts";
import { FIXTURES } from "./helpers/code-fixtures.ts";

function dockerRunning(): boolean {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

const enabled = process.env.LH_DOCKER_TESTS === "1" && dockerRunning();
const CHAT = `test-lsp-${process.pid}`;

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

describe("language servers — real Docker", { skip: enabled ? false : "set LH_DOCKER_TESTS=1 with Docker running" }, () => {
	const runner = createDockerRunner({ sweep: false });
	const sessions: DiagnosticsSession[] = [];
	after(async () => {
		await Promise.all(sessions.map((s) => s.stop()));
		await runner.retainOnly(CHAT, null);
	});

	for (const language of CODE_LANGUAGES) {
		const fixture = FIXTURES[language];
		it(`${language}: errors appear and clear; hidden tests stay out`, { timeout: 30 * 60_000 }, async () => {
			const spec = LANGUAGES[language];
			const image = await runner.ensureImage(spec.image, () => {});
			assert.ok(image.ok, image.ok ? "" : image.output);
			const key = { chatId: CHAT, problemCallId: `lsp-${language}` };
			const session = createDiagnosticsSession({
				runner,
				key,
				language,
				files: fixture.pose.files,
				visibleTests: fixture.pose.tests.visible,
				onChange: () => {},
			});
			sessions.push(session);
			await waitFor(`${language} ready`, () => session.snapshot().status === "ready" || session.snapshot().status === "crashed", 5 * 60_000);
			assert.equal(session.snapshot().status, "ready");

			const broken = fixture.syntax[0]!;
			session.update(fixture.pose.files.map((f) => (f.path === broken.path ? broken : f)));
			const errors = await waitFor(
				`an error in ${broken.path}`,
				() => {
					const list = (session.snapshot().files[broken.path] ?? []).filter((d) => d.severity === "error");
					return list.length > 0 ? list : undefined;
				},
				3 * 60_000,
			);
			assert.ok(errors[0]!.message.length > 0);

			const fixed = fixture.pose.reference.find((f) => f.path === broken.path) ?? fixture.pose.files.find((f) => f.path === broken.path)!;
			session.update(fixture.pose.files.map((f) => (f.path === broken.path ? fixed : f)));
			await waitFor(
				`${broken.path} to clear`,
				() => (session.snapshot().files[broken.path] ?? []).every((d) => d.severity !== "error"),
				3 * 60_000,
			);

			const listing = await runner.spawn({ key, image: spec.image, command: `find ${LSP_ROOT} -type f`, workingDir: LSP_ROOT });
			let out = "";
			listing.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
			await listing.exited;
			for (const hidden of fixture.pose.tests.hidden) assert.ok(!out.includes(hidden.path), `${hidden.path} must not be in ${LSP_ROOT}`);
			for (const visible of fixture.pose.tests.visible) assert.ok(out.includes(visible.path), `${visible.path} is in ${LSP_ROOT}`);
		});
	}
});
