/**
 * DOCKER PLUMBING WITHOUT DOCKER (ported from the fork's code-workspace tests):
 * tar stream, image tags, container names, engine discovery, the copy command,
 * the recipe result mapping and the language table.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { tarFiles } from "../src/server/tar.ts";
import { containerName, extractFresh, imageTag, recipeResult } from "../src/server/docker-runner.ts";
import { dockerInstalled, parseDockerHost, resolveEngine, type EngineEnvironment } from "../src/server/docker-engine.ts";
import { CODE_IMAGES, languageSpec } from "../src/server/languages.ts";

const IMAGE_ROOT = path.join(import.meta.dirname, "..", "docker");

describe("tar stream, image tags, container names", () => {
	it("tarFiles: parent dirs, ustar headers with valid checksums, padded bodies, end blocks", () => {
		const tar = tarFiles([{ path: "src/lib.rs", content: "pub fn x() {}" }]);
		assert.equal(tar.length % 512, 0);
		const readHeader = (offset: number) => {
			const h = tar.subarray(offset, offset + 512);
			const field = (start: number, length: number) => h.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
			let sum = 0;
			for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
			return { name: field(0, 100), size: parseInt(field(124, 12), 8), type: field(156, 1), magic: field(257, 6), checksumOk: parseInt(field(148, 8), 8) === sum };
		};
		assert.deepEqual(readHeader(0), { name: "src/", size: 0, type: "5", magic: "ustar", checksumOk: true });
		assert.deepEqual(readHeader(512), { name: "src/lib.rs", size: 13, type: "0", magic: "ustar", checksumOk: true });
		assert.equal(tar.subarray(1024, 1037).toString(), "pub fn x() {}");
		assert.equal(tar.length, 512 * 5); // dir header, file header, body block, two end blocks
	});

	it("imageTag is stable per directory content", () => {
		const tag = imageTag("node", path.join(IMAGE_ROOT, "node"));
		assert.match(tag, /^learnharness-code-node:[0-9a-f]{12}$/);
		assert.equal(imageTag("node", path.join(IMAGE_ROOT, "node")), tag);
		assert.notEqual(imageTag("python", path.join(IMAGE_ROOT, "python")), tag.replace("node", "python") + "x");
	});

	it("containerName is docker-safe", () => {
		assert.equal(containerName({ chatId: "abc_D-1", itemId: "call|x:y" }), "lh-code-abc_D-1-call_x_y");
	});
});



function engineEnv(files: Record<string, string>, opts: Partial<EngineEnvironment> = {}): EngineEnvironment {
	const norm = (p: string) => p.replaceAll("\\", "/");
	const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
	return {
		env: {},
		platform: "linux",
		homeDir: "/home/u",
		exists: (p) => table.has(norm(p)) || [...table.keys()].some((k) => k.startsWith(norm(p) + "/")),
		read: (p) => table.get(norm(p)) ?? null,
		...opts,
	};
}
const metaPath = (name: string) => `/home/u/.docker/contexts/meta/${createHash("sha256").update(name).digest("hex")}/meta.json`;
const meta = (host: string) => JSON.stringify({ Name: "x", Endpoints: { docker: { Host: host, SkipTLSVerify: false } } });

describe("Docker engine discovery", () => {
	it("parses unix, npipe, tcp (with and without TLS) and ssh hosts", () => {
		assert.deepEqual(parseDockerHost("unix:///var/run/docker.sock"), { socketPath: "/var/run/docker.sock" });
		assert.deepEqual(parseDockerHost("npipe:////./pipe/dockerDesktopLinuxEngine"), { socketPath: "//./pipe/dockerDesktopLinuxEngine" });
		assert.deepEqual(parseDockerHost("tcp://10.0.0.5:2375"), { host: "10.0.0.5", port: "2375", protocol: "http" });
		assert.deepEqual(parseDockerHost("tcp://h:2376", { ca: "CA", cert: "C", key: "K" }), { host: "h", port: "2376", protocol: "https", ca: "CA", cert: "C", key: "K" });
		assert.deepEqual(parseDockerHost("ssh://me@box:2222"), { protocol: "ssh", host: "box", port: "2222", username: "me" });
		assert.equal(parseDockerHost("bogus"), null);
	});

	it("DOCKER_HOST wins over the context", () => {
		const e = engineEnv({ "/home/u/.docker/config.json": `{"currentContext":"colima"}`, [metaPath("colima")]: meta("unix:///c.sock") }, { env: { DOCKER_HOST: "tcp://h:2375" } });
		assert.deepEqual(resolveEngine(e), { source: "DOCKER_HOST", options: { host: "h", port: "2375", protocol: "http" } });
	});

	it("the current context from config.json, or DOCKER_CONTEXT", () => {
		const files = {
			"/home/u/.docker/config.json": `{"currentContext":"colima"}`,
			[metaPath("colima")]: meta("unix:///home/u/.colima/default/docker.sock"),
			[metaPath("orb")]: meta("unix:///home/u/.orbstack/run/docker.sock"),
		};
		assert.deepEqual(resolveEngine(engineEnv(files)), { source: "context colima", options: { socketPath: "/home/u/.colima/default/docker.sock" } });
		assert.deepEqual(resolveEngine(engineEnv(files, { env: { DOCKER_CONTEXT: "orb" } })).options, { socketPath: "/home/u/.orbstack/run/docker.sock" });
	});

	it("a context's TLS files are used for tcp endpoints", () => {
		const hash = createHash("sha256").update("remote").digest("hex");
		const tls = `/home/u/.docker/contexts/tls/${hash}/docker`;
		const e = engineEnv({
			"/home/u/.docker/config.json": `{"currentContext":"remote"}`,
			[metaPath("remote")]: meta("tcp://r:2376"),
			[`${tls}/ca.pem`]: "CA",
			[`${tls}/cert.pem`]: "C",
			[`${tls}/key.pem`]: "K",
		});
		assert.deepEqual(resolveEngine(e).options, { host: "r", port: "2376", protocol: "https", ca: "CA", cert: "C", key: "K" });
	});

	it("falls back to the platform default (default context, missing or malformed metadata)", () => {
		assert.deepEqual(resolveEngine(engineEnv({ "/home/u/.docker/config.json": `{"currentContext":"default"}` })), { source: "default", options: { socketPath: "/var/run/docker.sock" } });
		assert.equal(resolveEngine(engineEnv({ "/home/u/.docker/config.json": `{"currentContext":"gone"}` })).source, "default");
		assert.equal(resolveEngine(engineEnv({ "/home/u/.docker/config.json": "{not json" })).source, "default");
		assert.deepEqual(resolveEngine(engineEnv({}, { platform: "win32" })).options, { socketPath: "//./pipe/docker_engine" });
		assert.deepEqual(resolveEngine(engineEnv({ "/home/u/.docker/run/docker.sock": "" }, { platform: "darwin" })).options, { socketPath: "/home/u/.docker/run/docker.sock" });
	});

	it("installed: binary on PATH or in Docker Desktop's dir, or an explicit host/context — nothing else", () => {
		assert.equal(dockerInstalled(engineEnv({ "/usr/bin/docker": "" }, { env: { PATH: "/usr/bin" } })), true);
		assert.equal(dockerInstalled(engineEnv({}, { env: { PATH: "/usr/bin" } })), false);
		assert.equal(dockerInstalled(engineEnv({}, { env: { DOCKER_HOST: "tcp://h:2375" } })), true);
		assert.equal(dockerInstalled(engineEnv({ "C:/Program Files/Docker/Docker/resources/bin/docker.exe": "" }, { platform: "win32", env: { ProgramFiles: "C:\\Program Files" } })), true);
	});
});

describe("copying files into a container", () => {
	// Whole-second tar mtimes let cargo/MSBuild skip a rebuild (and jdtls keep
	// old text) when a file is rewritten within the second of the last build:
	// the extracted files are re-stamped at full precision, and a tar failure
	// still fails the copy.
	it("extracts, re-stamps exactly the extracted files, and keeps tar's exit status", () => {
		const cmd = extractFresh("/work/run");
		assert.match(cmd, /tar -x -v -C \/work\/run > "\$list" &&/);
		assert.match(cmd, /cd \/work\/run && xargs -r -d '\\n' touch -c -- < "\$list"/);
		assert.match(cmd, /s=\$\?; rm -f "\$list"; exit \$s$/);
	});
});

describe("the teacher's recipe in a container", () => {
	const base = { stdout: "out", stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false };
	it("maps exit codes to coding-questions' result statuses", () => {
		assert.equal(recipeResult({ ...base, code: 0 }, "python3", "python").status, "passed");
		assert.deepEqual(recipeResult({ ...base, code: 1 }, "python3", "python"), { status: "failed", exitCode: 1, ...{ stdout: "out", stderr: "", stdoutTruncated: false, stderrTruncated: false } });
		assert.equal(recipeResult({ ...base, code: 124 }, "python3", "python").message, "Test process exceeded the 30 second timeout");
		assert.equal(recipeResult({ ...base, code: null, timedOut: true }, "python3", "python").status, "error");
		assert.match(recipeResult({ ...base, code: 127 }, "ruby", "python").message!, /ruby is not available in the python sandbox/);
	});
});

describe("the language table", () => {
	it("maps common coding-questions language names to images", () => {
		assert.equal(languageSpec("Python")?.image, "python");
		assert.equal(languageSpec(" ts ")?.image, "node");
		assert.equal(languageSpec("C++")?.image, "cpp");
		assert.equal(languageSpec("c#")?.image, "dotnet");
		assert.equal(languageSpec("sql"), null);
	});
	it("names a Java file after its public class", () => {
		assert.equal(languageSpec("java")?.fileName("public final class Solver {}"), "Solver.java");
		assert.equal(languageSpec("java")?.fileName("class X {}"), "Answer.java");
	});
	it("every image has a build directory, and none ships a file the Core packager refuses", () => {
		for (const image of CODE_IMAGES) assert.ok(fs.existsSync(path.join(IMAGE_ROOT, image, "Dockerfile")), image);
		const names = fs.readdirSync(IMAGE_ROOT, { recursive: true }).map(String);
		assert.ok(!names.some(name => /(^|[\/])(package|package-lock)\.json$|\.tsx?$|(^|[\/])(src|data|node_modules)([\/]|$)/.test(name)), names.join(", "));
	});
});
