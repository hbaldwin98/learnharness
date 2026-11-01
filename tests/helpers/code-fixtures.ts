/** Per-language coding fixtures (reverse a list): a correct pose, a wrong
 *  reference, a syntax error, an infinite loop. Shared by the opt-in
 *  real-Docker suites (steps 2 and 4). */
import type { CodeLanguage } from "../../src/agent/workspaces/code/languages.ts";
import type { CodeFile } from "../../src/core/contracts/workspaces.ts";
import type { CodePose } from "../../src/agent/workspaces/code/module.ts";

export const f = (path: string, content: string): CodeFile => ({ path, content });

export interface Fixture {
	pose: CodePose;
	wrong: CodeFile[];
	syntax: CodeFile[];
	loop: CodeFile[];
}

const nodeTest = (ext: "js" | "ts", name: string, body: string) =>
	`import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { rev } from "./solution.${ext}";\ntest("${name}", () => { ${body} });\n`;

export const FIXTURES: Record<CodeLanguage, Fixture> = {
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
