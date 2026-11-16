import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { problemsText, projectLsp, sourceFiles } from "../src/server/project-diagnostics.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-diag-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("project diagnostics helpers", () => {
	it("picks the image's source files with language ids, skipping dependencies", () => {
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(path.join(root, "src", "a.ts"), "");
		fs.writeFileSync(path.join(root, "b.mjs"), "");
		fs.writeFileSync(path.join(root, "README.md"), "");
		fs.mkdirSync(path.join(root, "node_modules"));
		fs.writeFileSync(path.join(root, "node_modules", "c.js"), "");
		assert.deepEqual(sourceFiles(root, "node"), [{ path: "b.mjs", languageId: "javascript" }, { path: "src/a.ts", languageId: "typescript" }]);
		assert.deepEqual(sourceFiles(root, "python"), []);
	});
	it("keeps server state out of /work and injects no config", () => {
		const java = projectLsp("java")!;
		assert.doesNotMatch(java.command, /\/work\/\.jdtls/);
		assert.match(java.command, /\/home\/lh\/\.jdtls/);
		assert.deepEqual(projectLsp("node")!.config, []);
	});
	it("formats problems with 1-based positions", () => {
		const text = problemsText({ status: "ready", name: "Python", checked: 2, files: [{ path: "a.py", diagnostics: [{ path: "a.py", line: 0, column: 4, endLine: 0, endColumn: 5, severity: "error", message: "bad", source: "basedpyright" }] }] });
		assert.equal(text, "Python language server: 1 problem\na.py:1:5 error: bad (basedpyright)");
		assert.match(problemsText({ status: "ready", name: "Go", checked: 1, files: [] }), /no errors or warnings in 1 source file\./);
	});
});
