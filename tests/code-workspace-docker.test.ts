/**
 * THE CODING WORKSPACE AGAINST REAL DOCKER (plan step 2). Opt-in: set
 * LH_DOCKER_TESTS=1 with Docker running — the first run builds every
 * language image (minutes, several GB), so the ordinary `npm test` skips
 * this suite. Per language, one small problem (reverse a list): the
 * reference passes, a wrong reference is refused, a starter with a
 * syntax error is refused, an infinite loop times out. Plus: no network.
 * Containers are removed afterwards (this suite's chat id only).
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";

import { CODE_LANGUAGES, type CodeFile, type CodeLanguage } from "../src/agent/workspaces/code/languages.ts";
import { createCodeModule, type CodePose } from "../src/agent/workspaces/code/module.ts";
import { createDockerRunner } from "../src/server/workspaces/docker-runner.ts";

function dockerRunning(): boolean {
	try {
		execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe", timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

const enabled = process.env.LH_DOCKER_TESTS === "1" && dockerRunning();
const CHAT = `test-docker-${process.pid}`;
const f = (path: string, content: string): CodeFile => ({ path, content });

interface Fixture {
	pose: CodePose;
	wrong: CodeFile[];
	syntax: CodeFile[];
	loop: CodeFile[];
}

const nodeTest = (ext: "js" | "ts", name: string, body: string) =>
	`import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { rev } from "./solution.${ext}";\ntest("${name}", () => { ${body} });\n`;

const FIXTURES: Record<CodeLanguage, Fixture> = {
	javascript: {
		pose: {
			language: "javascript",
			files: [f("solution.js", "export function rev(xs) { return xs; }\n")],
			tests: {
				visible: [f("solution.test.js", nodeTest("js", "reverses", "assert.deepEqual(rev([1, 2, 3]), [3, 2, 1]);"))],
				hidden: [f("hidden.test.js", nodeTest("js", "empty", "assert.deepEqual(rev([]), []);"))],
			},
			reference: [f("solution.js", "export function rev(xs) { return [...xs].reverse(); }\n")],
		},
		wrong: [f("solution.js", "export function rev(xs) { return xs; }\n")],
		syntax: [f("solution.js", "export function rev(xs) { return xs\n")],
		loop: [f("solution.js", "export function rev(xs) { for (;;) {} }\n")],
	},
	typescript: {
		pose: {
			language: "typescript",
			files: [f("solution.ts", "export function rev(xs: number[]): number[] { return xs; }\n")],
			tests: {
				visible: [f("solution.test.ts", nodeTest("ts", "reverses", "assert.deepEqual(rev([1, 2, 3]), [3, 2, 1]);"))],
				hidden: [f("hidden.test.ts", nodeTest("ts", "empty", "assert.deepEqual(rev([]), []);"))],
			},
			reference: [f("solution.ts", "export function rev(xs: number[]): number[] { return [...xs].reverse(); }\n")],
		},
		wrong: [f("solution.ts", "export function rev(xs: number[]): number[] { return xs; }\n")],
		syntax: [f("solution.ts", "export function rev(xs: number[]): number[] { return xs\n")],
		loop: [f("solution.ts", "export function rev(xs: number[]): number[] { for (;;) {} }\n")],
	},
	python: {
		pose: {
			language: "python",
			files: [f("solution.py", "def rev(xs):\n    return list(xs)\n")],
			tests: {
				visible: [f("test_visible.py", "from solution import rev\n\ndef test_reverses():\n    assert rev([1, 2, 3]) == [3, 2, 1]\n")],
				hidden: [f("test_hidden.py", "from solution import rev\n\ndef test_empty():\n    assert rev([]) == []\n")],
			},
			reference: [f("solution.py", "def rev(xs):\n    return list(reversed(xs))\n")],
		},
		wrong: [f("solution.py", "def rev(xs):\n    return list(xs)\n")],
		syntax: [f("solution.py", "def rev(xs)\n    return xs\n")],
		loop: [f("solution.py", "def rev(xs):\n    while True:\n        pass\n")],
	},
	csharp: {
		pose: {
			language: "csharp",
			files: [f("Solution.cs", "public static class Solution { public static int[] Rev(int[] xs) => xs; }\n")],
			tests: {
				visible: [f("SolutionTests.cs", "public class SolutionTests { [Fact] public void Reverses() => Assert.Equal(new[] { 3, 2, 1 }, Solution.Rev(new[] { 1, 2, 3 })); }\n")],
				hidden: [f("HiddenTests.cs", "public class HiddenTests { [Fact] public void Empty() => Assert.Empty(Solution.Rev(new int[0])); }\n")],
			},
			reference: [f("Solution.cs", "public static class Solution { public static int[] Rev(int[] xs) => xs.Reverse().ToArray(); }\n")],
		},
		wrong: [f("Solution.cs", "public static class Solution { public static int[] Rev(int[] xs) => xs; }\n")],
		syntax: [f("Solution.cs", "public static class Solution { public static int[] Rev(int[] xs) => xs\n")],
		loop: [f("Solution.cs", "public static class Solution { public static int[] Rev(int[] xs) { while (true) { } } }\n")],
	},
	java: {
		pose: {
			language: "java",
			files: [f("Solution.java", "public class Solution { public static int[] rev(int[] xs) { return xs; } }\n")],
			tests: {
				visible: [
					f(
						"SolutionTest.java",
						"import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\npublic class SolutionTest { @Test void reverses() { assertArrayEquals(new int[] { 3, 2, 1 }, Solution.rev(new int[] { 1, 2, 3 })); } }\n",
					),
				],
				hidden: [
					f(
						"HiddenTest.java",
						"import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\npublic class HiddenTest { @Test void empty() { assertEquals(0, Solution.rev(new int[0]).length); } }\n",
					),
				],
			},
			reference: [
				f(
					"Solution.java",
					"public class Solution { public static int[] rev(int[] xs) { int[] r = new int[xs.length]; for (int i = 0; i < xs.length; i++) r[i] = xs[xs.length - 1 - i]; return r; } }\n",
				),
			],
		},
		wrong: [f("Solution.java", "public class Solution { public static int[] rev(int[] xs) { return xs; } }\n")],
		syntax: [f("Solution.java", "public class Solution { public static int[] rev(int[] xs) { return xs }\n")],
		loop: [f("Solution.java", "public class Solution { public static int[] rev(int[] xs) { while (true) { } } }\n")],
	},
	go: {
		pose: {
			language: "go",
			files: [f("solution.go", "package solution\n\nfunc Rev(xs []int) []int { return xs }\n")],
			tests: {
				visible: [
					f(
						"solution_test.go",
						'package solution\n\nimport (\n\t"reflect"\n\t"testing"\n)\n\nfunc TestReverses(t *testing.T) {\n\tif got := Rev([]int{1, 2, 3}); !reflect.DeepEqual(got, []int{3, 2, 1}) {\n\t\tt.Fatalf("got %v", got)\n\t}\n}\n',
					),
				],
				hidden: [f("hidden_test.go", 'package solution\n\nimport "testing"\n\nfunc TestEmpty(t *testing.T) {\n\tif got := Rev([]int{}); len(got) != 0 {\n\t\tt.Fatalf("got %v", got)\n\t}\n}\n')],
			},
			reference: [
				f("solution.go", "package solution\n\nfunc Rev(xs []int) []int {\n\tr := make([]int, len(xs))\n\tfor i, x := range xs {\n\t\tr[len(xs)-1-i] = x\n\t}\n\treturn r\n}\n"),
			],
		},
		wrong: [f("solution.go", "package solution\n\nfunc Rev(xs []int) []int { return xs }\n")],
		syntax: [f("solution.go", "package solution\n\nfunc Rev(xs []int) []int { return xs\n")],
		loop: [f("solution.go", "package solution\n\nfunc Rev(xs []int) []int {\n\tfor {\n\t}\n}\n")],
	},
	rust: {
		pose: {
			language: "rust",
			files: [f("src/lib.rs", "pub fn rev(xs: &[i32]) -> Vec<i32> { xs.to_vec() }\n")],
			tests: {
				visible: [f("tests/visible.rs", "use solution::rev;\n\n#[test]\nfn reverses() { assert_eq!(rev(&[1, 2, 3]), vec![3, 2, 1]); }\n")],
				hidden: [f("tests/hidden.rs", "use solution::rev;\n\n#[test]\nfn empty() { assert_eq!(rev(&[]), Vec::<i32>::new()); }\n")],
			},
			reference: [f("src/lib.rs", "pub fn rev(xs: &[i32]) -> Vec<i32> { xs.iter().rev().cloned().collect() }\n")],
		},
		wrong: [f("src/lib.rs", "pub fn rev(xs: &[i32]) -> Vec<i32> { xs.to_vec() }\n")],
		syntax: [f("src/lib.rs", "pub fn rev(xs: &[i32]) -> Vec<i32> { xs.to_vec()\n")],
		loop: [f("src/lib.rs", "pub fn rev(_xs: &[i32]) -> Vec<i32> { loop {} }\n")],
	},
	cpp: {
		pose: {
			language: "cpp",
			files: [
				f("solution.h", "#pragma once\n#include <vector>\nstd::vector<int> rev(const std::vector<int>& xs);\n"),
				f("solution.cpp", '#include "solution.h"\nstd::vector<int> rev(const std::vector<int>& xs) { return xs; }\n'),
			],
			tests: {
				visible: [f("solution_test.cpp", '#include "doctest.h"\n#include "solution.h"\nTEST_CASE("reverses") { CHECK(rev({1, 2, 3}) == std::vector<int>{3, 2, 1}); }\n')],
				hidden: [f("hidden_test.cpp", '#include "doctest.h"\n#include "solution.h"\nTEST_CASE("empty") { CHECK(rev({}).empty()); }\n')],
			},
			reference: [
				f("solution.cpp", '#include "solution.h"\n#include <algorithm>\nstd::vector<int> rev(const std::vector<int>& xs) { std::vector<int> r(xs); std::reverse(r.begin(), r.end()); return r; }\n'),
			],
		},
		wrong: [f("solution.cpp", '#include "solution.h"\nstd::vector<int> rev(const std::vector<int>& xs) { return xs; }\n')],
		syntax: [f("solution.cpp", '#include "solution.h"\nstd::vector<int> rev(const std::vector<int>& xs) { return xs }\n')],
		loop: [f("solution.cpp", '#include "solution.h"\nstd::vector<int> rev(const std::vector<int>& xs) { for (;;) {} }\n')],
	},
};

describe("coding workspace — real Docker", { skip: enabled ? false : "set LH_DOCKER_TESTS=1 with Docker running" }, () => {
	const runner = createDockerRunner({ sweep: false });
	const code = createCodeModule(runner);
	after(() => runner.retainOnly(CHAT, null));

	for (const language of CODE_LANGUAGES) {
		const fixture = FIXTURES[language];
		const verify = (pose: CodePose, id: string) =>
			code.verifyPose(pose, { chatId: CHAT, problemCallId: `${language}-${id}`, onProgress: () => {} });

		describe(language, () => {
			it("a correct reference passes; the container stays warm", { timeout: 30 * 60_000 }, async () => {
				assert.deepEqual(await verify(fixture.pose, "ok"), []);
			});

			it("a wrong reference is refused with the failing test", { timeout: 5 * 60_000 }, async () => {
				const errors = await verify({ ...fixture.pose, reference: fixture.wrong }, "wrong");
				assert.match(errors.join("\n"), /does not pass every test[\s\S]*✗/);
			});

			it("a starter with a syntax error is refused", { timeout: 5 * 60_000 }, async () => {
				const errors = await verify({ ...fixture.pose, files: fixture.syntax }, "syntax");
				assert.match(errors.join("\n"), /starter files do not build/);
			});

			it("an infinite loop in the reference times out", { timeout: 5 * 60_000 }, async () => {
				const errors = await verify({ ...fixture.pose, reference: fixture.loop }, "loop");
				assert.match(errors.join("\n"), /timed out/);
			});
		});
	}

	it("containers have no network", { timeout: 5 * 60_000 }, async () => {
		const outcome = await runner.run({
			key: { chatId: CHAT, problemCallId: "net" },
			image: "node",
			files: [f("net.mjs", "fetch('http://1.1.1.1').then(() => console.log('NET'), () => console.log('NONET'));\n")],
			steps: [{ phase: "test", command: "node net.mjs", timeoutMs: 10_000 }],
			report: null,
		});
		assert.match(outcome.report ?? "", /NONET/);
	});
});
