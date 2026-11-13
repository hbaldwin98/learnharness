import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { createPluginHost, type PluginHostDependencies } from "../src/server/plugin-host.ts";
import forkDefaults from "../fork-default-enabled-plugins.json";
import coreIds from "../core-plugins.json";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-defaults-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const directory = path.join(root, "data", "plugins");
	fs.mkdirSync(directory, { recursive: true });
	const core = { directory: path.join(root, "app", "core-plugins"), dataDirectory: path.join(root, "data", "core-plugin-data"), ids: ["fork", "upstream"], defaultEnabled: ["fork", "community"] };
	const deps: PluginHostDependencies = { directory, core, appVersion: "0.4.1", createServices() {
		return { agents: { dispose() {} }, workers: { dispose() {} } } as unknown as ReturnType<PluginHostDependencies["createServices"]>;
	} };
	const pkg = (id: string, origin: "core" | "community") => {
		const code = origin === "core" ? path.join(core.directory, id) : path.join(directory, id, "dist");
		fs.mkdirSync(code, { recursive: true });
		fs.writeFileSync(path.join(code, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", backend: "backend.cjs", main: "main.js", origin: "core" }));
		fs.writeFileSync(path.join(code, "backend.cjs"), "exports.activate = () => {};");
		fs.writeFileSync(path.join(code, "main.js"), "export function activate() {}");
	};
	pkg("fork", "core"); pkg("upstream", "core"); pkg("community", "community");
	return { deps };
}
const enabled = (host: ReturnType<typeof createPluginHost>) => Object.fromEntries(host.list().map(p => [p.id, p.enabled]));

test("fork default-enabled core plugins start enabled on a fresh install; others keep their default", async t => {
	const { deps } = fixture(t);
	const host = createPluginHost(deps); t.after(() => host.dispose()); await host.initialize();
	assert.deepEqual(enabled(host), { community: false, fork: true, upstream: false });
	assert.equal(host.list().find(p => p.id === "fork")!.status, "active");
});

test("an explicit disable of a default-enabled plugin persists across restarts", async t => {
	const { deps } = fixture(t);
	const host = createPluginHost(deps); await host.initialize();
	await host.setEnabled("fork", false); await host.dispose();
	const restarted = createPluginHost(deps); t.after(() => restarted.dispose()); await restarted.initialize();
	assert.equal(enabled(restarted).fork, false);
});

test("the fork default list names exactly the fork core plugins", () => {
	assert.deepEqual(forkDefaults, ["graphite", "learner-mermaid", "readings", "coding-workspaces", "interview"]);
	for (const id of forkDefaults) assert.ok((coreIds as string[]).includes(id), id);
});
