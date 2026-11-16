import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createProjectTools } from "../src/server/project-tools.ts";
import type { ProjectInfo, ProjectRun } from "../src/shared/protocol.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tools-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const info = (): ProjectInfo => ({ id: "p", name: "P", image: "node", hostPath: root, managed: true, runCommand: "", createdAt: "", exists: true, sessions: ["c"] });
const call = async (tools: ReturnType<typeof createProjectTools>, name: string, params: unknown = {}) => {
	const tool = tools.find(t => t.name === name)!;
	const result = await tool.execute("id", params as never, undefined as never, undefined as never) as { content: Array<{ text: string }> };
	return result.content[0]!.text;
};

describe("project tools", () => {
	it("refuse without an attached project", async () => {
		const tools = createProjectTools("c", { forChat: () => null, changes: async () => "", run: async () => { throw new Error(); } });
		await assert.rejects(call(tools, "project_files"), /no project workspace/);
	});
	it("list, read with line numbers and ranges, and run", async () => {
		fs.writeFileSync(path.join(root, "a.py"), "one\ntwo\nthree");
		const runs: string[] = [];
		const tools = createProjectTools("c", {
			forChat: () => info(),
			changes: async () => "diff",
			run: async (_p, command): Promise<ProjectRun> => { runs.push(command); return { at: "", command, exitCode: 1, timedOut: false, stdout: "", stderr: "boom", stdoutTruncated: false, stderrTruncated: false }; },
		});
		assert.equal(await call(tools, "project_files"), "a.py");
		assert.match(await call(tools, "project_read", { path: "a.py", startLine: 2, endLine: 3 }), /2│ two\n3│ three$/);
		assert.equal(await call(tools, "project_changes"), "diff");
		assert.match(await call(tools, "project_run", { command: "pytest" }), /`pytest` → exit 1\nstderr:\nboom/);
		assert.deepEqual(runs, ["pytest"]);
		await assert.rejects(call(tools, "project_read", { path: "../x" }), /outside/);
	});
});
