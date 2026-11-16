import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { numbered, readText, resolveInside, walkFiles } from "../src/server/project-files.ts";

let root: string;
let outside: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-files-"));
	outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-outside-"));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

describe("project files", () => {
	it("resolves relative and /work paths inside the folder", () => {
		const real = fs.realpathSync(root);
		assert.equal(resolveInside(root, "src/a.ts"), path.join(real, "src", "a.ts"));
		assert.equal(resolveInside(root, "/work/src/a.ts"), path.join(real, "src", "a.ts"));
		assert.equal(resolveInside(root, "."), real);
	});
	it("rejects escapes and absolute paths", () => {
		assert.throws(() => resolveInside(root, "../x"), /outside/);
		assert.throws(() => resolveInside(root, "a/../../x"), /outside/);
		assert.throws(() => resolveInside(root, "C:/Windows"), /relative/);
	});
	it("rejects symlinks that point outside", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, () => {
		fs.symlinkSync(outside, path.join(root, "link"));
		assert.throws(() => resolveInside(root, "link/secret"), /outside/);
	});
	it("walks files, skipping dependency dirs", () => {
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(path.join(root, "src", "a.ts"), "x");
		fs.writeFileSync(path.join(root, "README.md"), "x");
		fs.mkdirSync(path.join(root, "node_modules", "p"), { recursive: true });
		fs.writeFileSync(path.join(root, "node_modules", "p", "i.js"), "x");
		assert.deepEqual(walkFiles(root).files, ["README.md", "src/a.ts"]);
		assert.deepEqual(walkFiles(root, "src").files, ["src/a.ts"]);
	});
	it("reads text, refuses binary, numbers lines", () => {
		fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo");
		fs.writeFileSync(path.join(root, "b.bin"), Buffer.from([1, 0, 2]));
		assert.equal(readText(root, "a.txt").content, "one\ntwo");
		assert.throws(() => readText(root, "b.bin"), /binary/);
		assert.equal(numbered("a\nb", 9), " 9│ a\n10│ b");
	});
});
