import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { changesText, createSnapshots, hasGit } from "../src/server/snapshots.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-snap-test-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

describe("snapshots", async () => {
	const skip = (await hasGit()) ? false : "git is not installed";

	it("inits a repo with a .gitignore and snapshots onto a hidden ref only", { skip }, async () => {
		fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
		fs.mkdirSync(path.join(dir, "node_modules"));
		fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "ignored");
		const s = createSnapshots(dir);
		const first = await s.snapshot("test");
		assert.ok(fs.existsSync(path.join(dir, ".gitignore")));
		assert.equal(git("rev-parse", "refs/learnharness/snapshots/latest").trim(), first);
		assert.match(git("ls-tree", "-r", "--name-only", first), /a\.txt/);
		assert.doesNotMatch(git("ls-tree", "-r", "--name-only", first), /node_modules/);
		// The learner's index and branches are untouched.
		assert.equal(git("status", "--porcelain").includes("?? a.txt"), true);
		assert.equal(await s.snapshot("again"), first, "an unchanged tree reuses the snapshot");
	});

	it("reports changes since the tutor's last look per chat", { skip }, async () => {
		fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
		const s = createSnapshots(dir);
		const first = await s.changesSinceLook("chat1", "look");
		assert.equal(first.from, null);
		assert.match(first.diff, /\+one/);
		assert.match(changesText(first), /first look/);
		fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
		const second = await s.changesSinceLook("chat1", "look");
		assert.match(second.diff, /-one\n\+two/);
		const none = await s.changesSinceLook("chat1", "look");
		assert.equal(changesText(none), "No file changes since your last look.");
		const otherChat = await s.changesSinceLook("chat2", "look");
		assert.equal(otherChat.from, null, "looks are per chat");
	});

	it("lists files that are not ignored", { skip }, async () => {
		fs.writeFileSync(path.join(dir, "a.txt"), "x");
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "src", "b.ts"), "x");
		fs.mkdirSync(path.join(dir, "node_modules"));
		fs.writeFileSync(path.join(dir, "node_modules", "c.js"), "x");
		const s = createSnapshots(dir);
		await s.ensureRepo();
		assert.deepEqual(await s.files(), [".gitignore", "a.txt", "src/b.ts"]);
	});
});
