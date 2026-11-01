/**
 * THE CODING MODULE'S LANGUAGE TABLE (docs/practice-workspaces-plan.md,
 * step 2). Per language: which image runs it, the file layout the agent
 * must follow, the scaffold paths the app owns (they live in the image at
 * /opt/scaffold and are copied into every run — the agent may not write
 * them), the build and test commands, and the parser that turns the test
 * report into normalized results. Pure data + parsers: the Docker runner
 * (server) executes the commands; this layer decides what they are.
 *
 * Every run executes in the fixed directory /work/run (wiped before each
 * run, so it is fresh — and stable paths keep compiler caches warm).
 */

export const CODE_LANGUAGES = ["javascript", "typescript", "python", "csharp", "java", "go", "rust", "cpp"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** The Dockerfile directories under docker/workspace-code/. */
export const CODE_IMAGES = ["node", "python", "dotnet", "java", "go", "rust", "cpp"] as const;
export type CodeImage = (typeof CODE_IMAGES)[number];

import type { CodeFile, TestCaseResult } from "../../../core/contracts/workspaces.ts";
export type { CodeFile, TestCaseResult, TestStatus } from "../../../core/contracts/workspaces.ts";

export interface LanguageSpec {
	id: CodeLanguage;
	label: string;
	image: CodeImage;
	/** One line for the tool description: where source and test files go. */
	layout: string;
	/** A test file must match this (relative path). */
	testFile: RegExp;
	/** A source/starter/reference file must match this (relative path). */
	sourceFile: RegExp;
	/** Paths the app owns (from /opt/scaffold); the agent may not write them. */
	scaffold: readonly string[];
	/** Compile / load check (60 s limit). Exit 0 = builds. */
	build: string;
	/** Run the tests (10 s limit), writing the report. */
	test: string;
	/** Where the report lands (relative to the run dir); null = stdout. */
	report: string | null;
	/** Report (file contents, or stdout when report is null) → results. */
	parse(report: string): TestCaseResult[];
}

// ─── report parsers ──────────────────────────────────────────────────────────

const decodeXml = (s: string) =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string | undefined => {
	const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return m ? decodeXml(m[1]!) : undefined;
};

/** JUnit XML (node:test, pytest, JUnit console, doctest, the .NET JUnit
 *  logger): every <testcase>, failed by a <failure>/<error> child; skipped
 *  cases are dropped. */
export function parseJUnitXml(xml: string): TestCaseResult[] {
	const results: TestCaseResult[] = [];
	const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
	for (let m = re.exec(xml); m; m = re.exec(xml)) {
		const tag = m[1]!;
		const body = m[3] ?? "";
		if (/<skipped\b/.test(body)) continue;
		const name = attr(tag, "name") ?? "(unnamed)";
		const classname = attr(tag, "classname");
		const fullName = classname && !name.startsWith(classname) ? `${classname} › ${name}` : name;
		const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
		if (!failure) {
			results.push({ name: fullName, status: "pass" });
			continue;
		}
		const message = [attr(failure[2] ?? "", "message"), failure[3] ? decodeXml(failure[3].replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : ""]
			.filter(Boolean)
			.join("\n")
			.slice(0, 2000);
		results.push({ name: fullName, status: failure[1] === "error" ? "error" : "fail", ...(message ? { message } : {}) });
	}
	return results;
}

/** `go test -json`: one JSON event per line; the terminal pass/fail action
 *  of each named test, with its output lines as the message. */
export function parseGoTestJson(stream: string): TestCaseResult[] {
	const output = new Map<string, string[]>();
	const results = new Map<string, TestCaseResult>();
	for (const line of stream.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: { Action?: string; Test?: string; Output?: string };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event.Test) continue;
		if (event.Action === "output" && event.Output) {
			const lines = output.get(event.Test) ?? [];
			lines.push(event.Output);
			output.set(event.Test, lines);
		} else if (event.Action === "pass") {
			results.set(event.Test, { name: event.Test, status: "pass" });
		} else if (event.Action === "fail") {
			const message = (output.get(event.Test) ?? []).filter((l) => !/^(=== RUN|--- FAIL)/.test(l)).join("").trim().slice(0, 2000);
			results.set(event.Test, { name: event.Test, status: "fail", ...(message ? { message } : {}) });
		}
	}
	return [...results.values()];
}

/** libtest (`cargo test`) text: `test name ... ok|FAILED`, with each
 *  failure's captured output in the `---- name stdout ----` section. */
export function parseLibtest(stdout: string): TestCaseResult[] {
	const results: TestCaseResult[] = [];
	const sections = new Map<string, string>();
	const sectionRe = /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |^failures:|^test result:)/gm;
	for (let m = sectionRe.exec(stdout); m; m = sectionRe.exec(stdout)) sections.set(m[1]!, m[2]!.trim());
	const lineRe = /^test (\S+) \.\.\. (ok|FAILED|ignored)$/gm;
	for (let m = lineRe.exec(stdout); m; m = lineRe.exec(stdout)) {
		if (m[2] === "ignored") continue;
		const message = sections.get(m[1]!)?.slice(0, 2000);
		results.push(m[2] === "ok" ? { name: m[1]!, status: "pass" } : { name: m[1]!, status: "fail", ...(message ? { message } : {}) });
	}
	return results;
}

// ─── the table ───────────────────────────────────────────────────────────────

/** Relative, forward-slash, no traversal, no hidden segments. */
const SAFE = String.raw`(?!.*(?:^|/)\.)[A-Za-z0-9_][\w.\-/]*`;
const file = (ext: string) => new RegExp(`^${SAFE}\\.(?:${ext})$`);

/** Load every non-test source module (catches syntax and import errors
 *  without running the tests). Shipped in the node image. */
const NODE_LOAD_CHECK = "node /opt/lh/load-check.mjs";

export const LANGUAGES: Record<CodeLanguage, LanguageSpec> = {
	javascript: {
		id: "javascript",
		label: "JavaScript",
		image: "node",
		layout:
			"ES modules (package.json sets type: module, provided). Source: *.js; tests: *.test.js using node:test and node:assert, importing source with relative paths (\"./solution.js\").",
		testFile: file("test\\.js"),
		sourceFile: file("js"),
		scaffold: ["package.json"],
		build: NODE_LOAD_CHECK,
		test: "node --test --test-reporter=junit --test-reporter-destination=report.xml",
		report: "report.xml",
		parse: parseJUnitXml,
	},
	typescript: {
		id: "typescript",
		label: "TypeScript",
		image: "node",
		layout:
			"ES modules run by Node with type stripping (erasable syntax only — no enums or namespaces). Source: *.ts; tests: *.test.ts using node:test and node:assert, importing with the .ts extension (\"./solution.ts\").",
		testFile: file("test\\.ts"),
		sourceFile: file("ts"),
		scaffold: ["package.json"],
		build: NODE_LOAD_CHECK,
		test: "node --test --test-reporter=junit --test-reporter-destination=report.xml",
		report: "report.xml",
		parse: parseJUnitXml,
	},
	python: {
		id: "python",
		label: "Python",
		image: "python",
		layout: "Python 3.13. Source: *.py modules at the root; tests: test_*.py using pytest, importing the source modules by name.",
		testFile: /^(?:[\w-]+\/)*test_[\w-]*\.py$/,
		sourceFile: file("py"),
		scaffold: [],
		build: "python -m pytest --collect-only -q -p no:cacheprovider",
		test: "python -m pytest -q -p no:cacheprovider --junitxml=report.xml",
		report: "report.xml",
		parse: parseJUnitXml,
	},
	csharp: {
		id: "csharp",
		label: "C#",
		image: "dotnet",
		layout:
			"One .NET 9 project (Solution.csproj, provided — xUnit, implicit usings, nullable enabled). Source: *.cs; tests: *Tests.cs with xUnit [Fact]/[Theory].",
		testFile: /^(?:[\w-]+\/)*[\w-]+Tests\.cs$/,
		sourceFile: file("cs"),
		scaffold: ["Solution.csproj"],
		build: "dotnet build -nologo -v q -clp:NoSummary",
		test: 'dotnet test --no-build -nologo -v q --logger "junit;LogFilePath=report.xml"',
		report: "report.xml",
		parse: parseJUnitXml,
	},
	java: {
		id: "java",
		label: "Java",
		image: "java",
		layout: "Java 21, default package (no package declarations). Source: *.java; tests: *Test.java with JUnit 5 (org.junit.jupiter.api).",
		testFile: /^(?:[\w-]+\/)*[\w-]+Test\.java$/,
		sourceFile: file("java"),
		scaffold: [],
		build: "javac -d out -cp /opt/lh/junit.jar $(find . -name '*.java')",
		test: "java -jar /opt/lh/junit.jar execute --class-path out --scan-class-path --disable-banner --reports-dir=reports",
		report: "reports/TEST-junit-jupiter.xml",
		parse: parseJUnitXml,
	},
	go: {
		id: "go",
		label: "Go",
		image: "go",
		layout: "Go 1.24, one package named solution at the root (go.mod provided). Source: *.go; tests: *_test.go in package solution using the testing package.",
		testFile: /^(?:[\w-]+\/)*[\w-]+_test\.go$/,
		sourceFile: file("go"),
		scaffold: ["go.mod"],
		build: "go test -count=1 -run '^$' ./...",
		test: "go test -count=1 -json ./...",
		report: null,
		parse: parseGoTestJson,
	},
	rust: {
		id: "rust",
		label: "Rust",
		image: "rust",
		layout:
			"A library crate named solution (Cargo.toml provided, no dependencies). Source: src/lib.rs (plus src/ modules); tests: tests/*.rs integration tests using `use solution::…`.",
		testFile: /^tests\/[\w-]+\.rs$/,
		sourceFile: /^src\/(?:[\w-]+\/)*[\w-]+\.rs$/,
		scaffold: ["Cargo.toml"],
		build: "cargo build --tests --offline --quiet",
		test: "cargo test --offline --quiet --no-fail-fast -- --format=pretty --test-threads=1",
		report: null,
		parse: parseLibtest,
	},
	cpp: {
		id: "cpp",
		label: "C++",
		image: "cpp",
		layout:
			"C++20 with g++. Source: *.cpp and *.h (no main — the test runner provides it); tests: *_test.cpp using doctest (#include \"doctest.h\", TEST_CASE / CHECK).",
		testFile: /^(?:[\w-]+\/)*[\w-]+_test\.cpp$/,
		sourceFile: file("cpp|h|hpp"),
		scaffold: ["lh_doctest_main.cpp"],
		build: "g++ -std=c++20 -O1 -I/opt/lh/include -o lh_tests $(find . -name '*.cpp')",
		test: "./lh_tests --reporters=junit --out=report.xml --no-intro",
		report: "report.xml",
		parse: parseJUnitXml,
	},
};

/** Every language's layout, for the tool description. */
export function layoutSummary(): string {
	return CODE_LANGUAGES.map((id) => `${id}: ${LANGUAGES[id].layout}`).join(" | ");
}
