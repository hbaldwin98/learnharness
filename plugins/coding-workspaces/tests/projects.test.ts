import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createProjects } from "../src/server/projects.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-projects-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("projects", () => {
	it("creates a managed folder and persists the registry", () => {
		const projects = createProjects({ dataDirectory: dir });
		const p = projects.create({ name: " Todo API ", image: "node", runCommand: "npm test" });
		assert.equal(p.name, "Todo API");
		assert.equal(p.managed, true);
		assert.ok(fs.statSync(p.hostPath).isDirectory());
		assert.equal(path.dirname(p.hostPath), path.join(dir, "projects"));
		const reopened = createProjects({ dataDirectory: dir });
		assert.deepEqual(reopened.list().map(x => x.id), [p.id]);
		assert.equal(reopened.get(p.id).runCommand, "npm test");
	});

	it("uses a custom absolute folder and refuses reuse or relative paths", () => {
		const projects = createProjects({ dataDirectory: dir });
		const folder = path.join(dir, "mine", "app");
		const p = projects.create({ name: "Mine", image: "python", folder });
		assert.equal(p.managed, false);
		assert.ok(fs.existsSync(folder));
		assert.throws(() => projects.create({ name: "Again", image: "python", folder }), /already uses/);
		assert.throws(() => projects.create({ name: "Rel", image: "python", folder: "relative/path" }), /absolute/);
	});

	it("validates name and image", () => {
		const projects = createProjects({ dataDirectory: dir });
		assert.throws(() => projects.create({ name: "  ", image: "node" }), /name/);
		assert.throws(() => projects.create({ name: "x", image: "cobol" }), /image/);
	});

	it("attaches several chats to one project and one project per chat", () => {
		const projects = createProjects({ dataDirectory: dir });
		const a = projects.create({ name: "A", image: "node" });
		const b = projects.create({ name: "B", image: "go" });
		projects.attach("chat1", a.id);
		projects.attach("chat2", a.id);
		assert.deepEqual(projects.get(a.id).sessions.sort(), ["chat1", "chat2"]);
		projects.attach("chat1", b.id);
		assert.equal(projects.forChat("chat1")?.id, b.id);
		assert.deepEqual(projects.get(a.id).sessions, ["chat2"]);
		projects.detach("chat2");
		assert.equal(projects.forChat("chat2"), null);
	});

	it("removes: detaches, deletes managed files only on request, never custom folders", () => {
		const projects = createProjects({ dataDirectory: dir });
		const managed = projects.create({ name: "M", image: "node" });
		const kept = projects.create({ name: "K", image: "node" });
		const customFolder = path.join(dir, "custom");
		const custom = projects.create({ name: "C", image: "node", folder: customFolder });
		projects.attach("chat", managed.id);
		projects.remove(managed.id, true);
		assert.equal(fs.existsSync(managed.hostPath), false);
		assert.equal(projects.forChat("chat"), null);
		projects.remove(kept.id, false);
		assert.equal(fs.existsSync(kept.hostPath), true);
		projects.remove(custom.id, true);
		assert.equal(fs.existsSync(customFolder), true);
		assert.deepEqual(projects.list(), []);
	});
});
