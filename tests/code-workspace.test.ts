/**
 * THE CODING WORKSPACE MODULE — Docker-free units (plan step 2): report
 * parsers, pose validation, verifyPose against a fake runner, the result
 * normalization, the tar stream, and image tags. The real-Docker suite is
 * tests/code-workspace-docker.test.ts (skipped when Docker isn't running).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LANGUAGES, parseGoTestJson, parseJUnitXml, parseLibtest, type CodeFile } from "../src/agent/workspaces/code/languages.ts";
import { createCodeModule, overlay, validateCodePose, type CodePose } from "../src/agent/workspaces/code/module.ts";
import { capOutput, runCode, type CodeRunner, type DockerStatus, type RunOutcome } from "../src/agent/workspaces/code/runner.ts";
import { tarFiles } from "../src/server/workspaces/tar.ts";
import { containerName, imageTag } from "../src/server/workspaces/docker-runner.ts";

const f = (path: string, content = "x"): CodeFile => ({ path, content });

const PY: CodePose = {
	language: "python",
	files: [f("solution.py", "def rev(xs):\n    raise NotImplementedError\n")],
	tests: { visible: [f("test_visible.py")], hidden: [f("test_hidden.py")] },
	reference: [f("solution.py", "def rev(xs):\n    return xs[::-1]\n")],
};

// ─── parsers ────────────────────────────────────────────────────────────────

describe("report parsers", () => {
	it("JUnit XML: passes, failures with messages, errors, skips dropped", () => {
		const xml = `<?xml version="1.0"?><testsuites><testsuite name="s">
			<testcase classname="test_visible" name="test_empty" time="0.01"/>
			<testcase classname="test_visible" name="test_two"><failure message="assert [2, 1] == [1, 2]">Traceback &lt;x&gt;</failure></testcase>
			<testcase classname="t" name="boom"><error message="ImportError"/></testcase>
			<testcase classname="t" name="later"><skipped/></testcase>
		</testsuite></testsuites>`;
		assert.deepEqual(parseJUnitXml(xml), [
			{ name: "test_visible › test_empty", status: "pass" },
			{ name: "test_visible › test_two", status: "fail", message: "assert [2, 1] == [1, 2]\nTraceback <x>" },
			{ name: "t › boom", status: "error", message: "ImportError" },
		]);
	});

	it("go test -json: terminal actions per test, failure output as message", () => {
		const stream = [
			`{"Action":"run","Test":"TestRev"}`,
			`{"Action":"output","Test":"TestRev","Output":"=== RUN   TestRev\\n"}`,
			`{"Action":"pass","Test":"TestRev"}`,
			`{"Action":"run","Test":"TestEmpty"}`,
			`{"Action":"output","Test":"TestEmpty","Output":"    rev_test.go:9: got [1], want []\\n"}`,
			`{"Action":"fail","Test":"TestEmpty"}`,
			`{"Action":"fail","Package":"solution"}`,
			`# not json`,
		].join("\n");
		assert.deepEqual(parseGoTestJson(stream), [
			{ name: "TestRev", status: "pass" },
			{ name: "TestEmpty", status: "fail", message: "rev_test.go:9: got [1], want []" },
		]);
	});

	it("libtest: ok/FAILED lines with captured failure output", () => {
		const out = [
			"running 2 tests",
			"test reverses ... ok",
			"test empty ... FAILED",
			"test slow ... ignored",
			"",
			"failures:",
			"",
			"---- empty stdout ----",
			"thread 'empty' panicked at tests/t.rs:5:5:",
			"assertion failed",
			"",
			"failures:",
			"    empty",
			"",
			"test result: FAILED. 1 passed; 1 failed",
		].join("\n");
		assert.deepEqual(parseLibtest(out), [
			{ name: "reverses", status: "pass" },
			{ name: "empty", status: "fail", message: "thread 'empty' panicked at tests/t.rs:5:5:\nassertion failed" },
		]);
	});
});

// ─── validation ─────────────────────────────────────────────────────────────

describe("code pose validation", () => {
	it("a well-formed pose is valid", () => assert.deepEqual(validateCodePose(PY), []));

	it("rejects scaffold files, wrong kinds, traversal, duplicates and shared test paths", () => {
		const errors = validateCodePose({
			language: "rust",
			files: [f("Cargo.toml"), f("src/lib.rs"), f("src/lib.rs"), f("../escape.rs")],
			tests: { visible: [f("tests/a.rs")], hidden: [f("tests/a.rs"), f("src/b.rs")] },
			reference: [f("tests/c.rs")],
		});
		const text = errors.join("\n");
		assert.match(text, /files "Cargo.toml": this project file is provided by the app/);
		assert.match(text, /files "src\/lib.rs": duplicate path/);
		assert.match(text, /files "\.\.\/escape.rs": not a Rust source file/);
		assert.match(text, /tests.hidden "tests\/a.rs": also a visible test path/);
		assert.match(text, /tests.hidden "src\/b.rs": not a Rust test file/);
		assert.match(text, /reference "tests\/c.rs": not a Rust source file/);
	});

	it("a test file is not a source file (JS)", () => {
		const errors = validateCodePose({ ...PY, language: "javascript", files: [f("a.test.js")], tests: { visible: [f("a.test.js")], hidden: [f("b.test.js")] }, reference: [f("a.js")] });
		assert.match(errors.join("\n"), /files "a.test.js": not a JavaScript source file/);
	});

	it("every language accepts its own layout", () => {
		const layouts: Record<string, [string, string]> = {
			javascript: ["solution.js", "solution.test.js"],
			typescript: ["solution.ts", "solution.test.ts"],
			python: ["solution.py", "test_solution.py"],
			csharp: ["Solution.cs", "SolutionTests.cs"],
			java: ["Solution.java", "SolutionTest.java"],
			go: ["solution.go", "solution_test.go"],
			rust: ["src/lib.rs", "tests/solution.rs"],
			cpp: ["solution.cpp", "solution_test.cpp"],
		};
		for (const [language, [source, test]] of Object.entries(layouts)) {
			const hidden = test.replace(/(solution)/i, "$1_hidden").replace("SolutionTest", "HiddenTest").replace("SolutionTests", "HiddenTests");
			const pose = { language, files: [f(source)], tests: { visible: [f(test)], hidden: [f(hidden)] }, reference: [f(source)] } as CodePose;
			assert.deepEqual(validateCodePose(pose), [], `${language}: ${validateCodePose(pose).join("; ")}`);
		}
	});

	it("overlay replaces by path and adds new files", () => {
		assert.deepEqual(overlay([f("a.py", "1"), f("b.py", "2")], [f("a.py", "3"), f("c.py", "4")]), [f("a.py", "3"), f("b.py", "2"), f("c.py", "4")]);
	});
});

// ─── verifyPose against a fake runner ───────────────────────────────────────

const PASS_XML = `<testsuite><testcase name="a"/><testcase name="b"/></testsuite>`;
const FAIL_XML = `<testsuite><testcase name="a"/><testcase name="b"><failure message="wrong"/></testcase></testsuite>`;

function fakeRunner(opts: { status?: DockerStatus; image?: boolean; reference?: string; starterBuilds?: boolean } = {}) {
	const calls: string[] = [];
	const runner: CodeRunner = {
		status: async () => opts.status ?? "running",
		ensureImage: async (image, onProgress) => {
			calls.push(`image:${image}`);
			onProgress?.("building");
			return opts.image === false ? { ok: false, output: "pull failed" } : { ok: true };
		},
		run: async ({ files, steps }): Promise<RunOutcome> => {
			const buildOnly = steps.length === 1;
			calls.push(buildOnly ? `build:${files.map((x) => x.path).join(",")}` : `test:${files.map((x) => x.path).join(",")}`);
			if (buildOnly) {
				const ok = opts.starterBuilds !== false;
				return { steps: [{ phase: "build", exitCode: ok ? 0 : 1, timedOut: false, output: ok ? "" : "SyntaxError: bad starter" }], report: null };
			}
			return {
				steps: [
					{ phase: "build", exitCode: 0, timedOut: false, output: "" },
					{ phase: "test", exitCode: 0, timedOut: false, output: "" },
				],
				report: opts.reference ?? PASS_XML,
			};
		},
		remove: async (key) => {
			calls.push(`remove:${key.problemCallId}`);
		},
	};
	return { runner, calls };
}

const ctx = { chatId: "c1", problemCallId: "call_p" };

describe("verifyPose", () => {
	it("accepts: image, reference run with all tests, starter build — container kept", async () => {
		const { runner, calls } = fakeRunner();
		const progress: string[] = [];
		const errors = await createCodeModule(runner).verifyPose(PY, { ...ctx, onProgress: (l) => progress.push(l) });
		assert.deepEqual(errors, []);
		assert.deepEqual(calls, [
			"image:python",
			"test:solution.py,test_visible.py,test_hidden.py",
			"build:solution.py,test_visible.py",
		]);
		assert.ok(progress.includes("building"));
	});

	it("the reference run uses the reference content, the starter build the starter's", async () => {
		const seen: string[] = [];
		const { runner } = fakeRunner();
		const run = runner.run;
		runner.run = async (req) => {
			seen.push(req.files.find((x) => x.path === "solution.py")!.content);
			return run(req);
		};
		await createCodeModule(runner).verifyPose(PY, ctx);
		assert.deepEqual(seen, [PY.reference[0]!.content, PY.files[0]!.content]);
	});

	it("refuses when Docker is stopped or missing — no image, no run", async () => {
		for (const [status, pattern] of [["stopped", /start Docker Desktop/], ["missing", /isn't installed/]] as const) {
			const { runner, calls } = fakeRunner({ status });
			const errors = await createCodeModule(runner).verifyPose(PY, ctx);
			assert.match(errors.join(), pattern);
			assert.deepEqual(calls, []);
		}
	});

	it("refuses a failed image build with its output", async () => {
		const { runner } = fakeRunner({ image: false });
		assert.match((await createCodeModule(runner).verifyPose(PY, ctx)).join(), /failed to build:\npull failed/);
	});

	it("refuses a failing reference and removes the container", async () => {
		const { runner, calls } = fakeRunner({ reference: FAIL_XML });
		const errors = await createCodeModule(runner).verifyPose(PY, ctx);
		assert.match(errors.join(), /does not pass every test:\n✗ b: wrong/);
		assert.equal(calls.at(-1), "remove:call_p");
	});

	it("refuses a reference run where no tests ran", async () => {
		const { runner } = fakeRunner({ reference: "<testsuite></testsuite>" });
		assert.match((await createCodeModule(runner).verifyPose(PY, ctx)).join(), /no tests ran/);
	});

	it("refuses a starter that doesn't build and removes the container", async () => {
		const { runner, calls } = fakeRunner({ starterBuilds: false });
		const errors = await createCodeModule(runner).verifyPose(PY, ctx);
		assert.match(errors.join(), /starter files do not build[\s\S]*SyntaxError: bad starter/);
		assert.equal(calls.at(-1), "remove:call_p");
	});

	it("structural errors come back before Docker is touched", async () => {
		const { runner, calls } = fakeRunner();
		const errors = await createCodeModule(runner).verifyPose({ ...PY, files: [f("../x.py")] }, ctx);
		assert.ok(errors.length > 0);
		assert.deepEqual(calls, []);
	});
});

// ─── runCode normalization ──────────────────────────────────────────────────

describe("runCode", () => {
	const base = (outcome: RunOutcome): CodeRunner => ({
		status: async () => "running",
		ensureImage: async () => ({ ok: true }),
		run: async () => outcome,
		remove: async () => {},
	});
	const key = { chatId: "c", problemCallId: "p" };

	it("a timed-out test run is not ok", async () => {
		const result = await runCode(
			base({
				steps: [
					{ phase: "build", exitCode: 0, timedOut: false, output: "" },
					{ phase: "test", exitCode: 124, timedOut: true, output: "" },
				],
				report: null,
			}),
			{ key, language: "python", files: [] },
		);
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.equal(result.phase, "test");
	});

	it("a failed build stops at the build phase", async () => {
		const result = await runCode(base({ steps: [{ phase: "build", exitCode: 1, timedOut: false, output: "error: E0425" }], report: null }), {
			key,
			language: "rust",
			files: [],
		});
		assert.deepEqual({ ok: result.ok, phase: result.phase, output: result.output, tests: result.tests }, { ok: false, phase: "build", output: "error: E0425", tests: [] });
	});

	it("uses each language's build and test commands with the ruled limits", async () => {
		let steps: unknown;
		const runner = base({ steps: [], report: null });
		runner.run = async (req) => {
			steps = req.steps;
			return { steps: [], report: null };
		};
		await runCode(runner, { key, language: "go", files: [] });
		assert.deepEqual(steps, [
			{ phase: "build", command: LANGUAGES.go.build, timeoutMs: 60_000 },
			{ phase: "test", command: LANGUAGES.go.test, timeoutMs: 10_000 },
		]);
	});

	it("capOutput keeps the tail within the cap", () => {
		const capped = capOutput("a".repeat(100) + "END", 10);
		assert.match(capped, /truncated\)\naaaaaaaEND$/);
		assert.equal(capOutput("short", 10), "short");
	});
});

// ─── tar, tags, names ───────────────────────────────────────────────────────

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
		const tag = imageTag("node");
		assert.match(tag, /^learnharness-code-node:[0-9a-f]{12}$/);
		assert.equal(imageTag("node"), tag);
		assert.notEqual(imageTag("python"), tag.replace("node", "python") + "x");
	});

	it("containerName is docker-safe", () => {
		assert.equal(containerName({ chatId: "abc_D-1", problemCallId: "call|x:y" }), "lh-code-abc_D-1-call_x_y");
	});
});

// ─── engine discovery (plan step 2b) ────────────────────────────────────────

import { createHash } from "node:crypto";
import { dockerInstalled, parseDockerHost, resolveEngine, type EngineEnvironment } from "../src/server/workspaces/docker-engine.ts";

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
