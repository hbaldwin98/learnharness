import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyReplacements, createProposals } from "../src/server/proposals.ts";

let root: string;
let data: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prop-root-")); data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prop-data-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); });

describe("proposals", () => {
	it("applies unique replacements and refuses missing or ambiguous text", () => {
		assert.equal(applyReplacements("a b c", [{ find: "b", replace: "B" }]), "a B c");
		assert.throws(() => applyReplacements("a", [{ find: "x", replace: "" }]), /not found/);
		assert.throws(() => applyReplacements("a a", [{ find: "a", replace: "" }]), /more than once/);
	});

	it("proposes without writing; accept writes; reject leaves the file", () => {
		fs.writeFileSync(path.join(root, "a.py"), "x = 1\n");
		const p = createProposals(data);
		const edit = p.propose({ projectId: "p", root, chatId: "c", path: "a.py", explanation: "why", replacements: [{ find: "1", replace: "2" }] });
		assert.equal(fs.readFileSync(path.join(root, "a.py"), "utf8"), "x = 1\n");
		assert.match(edit.diff, /-x = 1\n\+x = 2/);
		assert.equal(p.pending("p").length, 1);
		assert.equal(p.decide("p", root, edit.id, true).status, "accepted");
		assert.equal(fs.readFileSync(path.join(root, "a.py"), "utf8"), "x = 2\n");
		assert.equal(p.pending("p").length, 0);
		assert.throws(() => p.decide("p", root, edit.id, true), /already accepted/);

		const created = p.propose({ projectId: "p", root, chatId: "c", path: "/work/src/new.py", explanation: "new", content: "print()\n" });
		assert.equal(created.path, "src/new.py");
		assert.equal(created.baseHash, null);
		assert.equal(p.decide("p", root, created.id, false).status, "rejected");
		assert.equal(fs.existsSync(path.join(root, "src", "new.py")), false);
	});

	it("goes stale when the learner changed the file; creates parent folders for new files", () => {
		fs.writeFileSync(path.join(root, "a.py"), "x = 1\n");
		const p = createProposals(data);
		const edit = p.propose({ projectId: "p", root, chatId: "c", path: "a.py", explanation: "", content: "x = 3\n" });
		fs.writeFileSync(path.join(root, "a.py"), "x = 9\n");
		assert.equal(p.decide("p", root, edit.id, true).status, "stale");
		assert.equal(fs.readFileSync(path.join(root, "a.py"), "utf8"), "x = 9\n");
		const created = p.propose({ projectId: "p", root, chatId: "c", path: "deep/dir/b.py", explanation: "", content: "b\n" });
		assert.equal(p.decide("p", root, created.id, true).status, "accepted");
		assert.equal(fs.readFileSync(path.join(root, "deep", "dir", "b.py"), "utf8"), "b\n");
	});

	it("refuses no-op, missing-base replacements and escaping paths", () => {
		fs.writeFileSync(path.join(root, "a.py"), "same");
		const p = createProposals(data);
		assert.throws(() => p.propose({ projectId: "p", root, chatId: "c", path: "a.py", explanation: "", content: "same" }), /nothing/);
		assert.throws(() => p.propose({ projectId: "p", root, chatId: "c", path: "nope.py", explanation: "", replacements: [{ find: "a", replace: "b" }] }), /does not exist/);
		assert.throws(() => p.propose({ projectId: "p", root, chatId: "c", path: "../evil.py", explanation: "", content: "x" }), /outside/);
	});
});
