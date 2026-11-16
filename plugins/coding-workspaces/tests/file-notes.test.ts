import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFileNotes } from "../src/server/file-notes.ts";

let root: string;
let data: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-root-")); data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-data-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); });

describe("file notes", () => {
	it("pins notes, follows moved lines, goes outdated on deletion, dismisses", () => {
		fs.writeFileSync(path.join(root, "a.py"), "a\nb\nc\n");
		const notes = createFileNotes(data);
		const n = notes.add("p", root, { chatId: "c", path: "/work/a.py", line: 2, note: "look here" });
		assert.equal(n.path, "a.py");
		fs.writeFileSync(path.join(root, "a.py"), "new\na\nb\nc\n");
		assert.equal(notes.list("p", root)[0]!.line, 3);
		fs.writeFileSync(path.join(root, "a.py"), "a\nc\n");
		assert.equal(notes.list("p", root)[0]!.outdated, true);
		notes.dismiss("p", n.id);
		assert.deepEqual(notes.list("p", root), []);
	});
	it("validates path, lines and note", () => {
		fs.writeFileSync(path.join(root, "a.py"), "a\nb");
		const notes = createFileNotes(data);
		assert.throws(() => notes.add("p", root, { chatId: "c", path: "nope.py", line: 1, note: "x" }), /does not exist/);
		assert.throws(() => notes.add("p", root, { chatId: "c", path: "a.py", line: 3, note: "x" }), /between 1 and 2/);
		assert.throws(() => notes.add("p", root, { chatId: "c", path: "a.py", line: 1, note: " " }), /non-empty/);
	});
	it("outdates notes on a deleted file", () => {
		fs.writeFileSync(path.join(root, "a.py"), "a");
		const notes = createFileNotes(data);
		notes.add("p", root, { chatId: "c", path: "a.py", line: 1, note: "x" });
		fs.rmSync(path.join(root, "a.py"));
		assert.equal(notes.list("p", root)[0]!.outdated, true);
	});
});
