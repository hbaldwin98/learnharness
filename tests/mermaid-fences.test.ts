/**
 * Unit tests — mermaid-fences (learner diagram fences: split, caret, insert).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insertSnippet, isInsideMermaidFence, splitMermaidFences } from "../src/core/mermaid-fences.ts";

describe("splitMermaidFences", () => {
	it("returns plain text untouched when there is no fence", () => {
		assert.deepEqual(splitMermaidFences("just\nthinking"), [{ kind: "text", content: "just\nthinking" }]);
		assert.deepEqual(splitMermaidFences(""), []);
	});

	it("splits text around one fence, dropping the joining newlines", () => {
		const text = "Reads dominate:\n```mermaid\nflowchart LR\n  A --> B\n```\nso cache.";
		assert.deepEqual(splitMermaidFences(text), [
			{ kind: "text", content: "Reads dominate:" },
			{ kind: "mermaid", content: "flowchart LR\n  A --> B" },
			{ kind: "text", content: "so cache." },
		]);
	});

	it("handles several fences and drops whitespace-only runs", () => {
		const text = "```mermaid\nA\n```\n\n```mermaid\nB\n```";
		assert.deepEqual(splitMermaidFences(text), [
			{ kind: "mermaid", content: "A" },
			{ kind: "mermaid", content: "B" },
		]);
	});

	it("treats a trailing unclosed fence as a chart", () => {
		assert.deepEqual(splitMermaidFences("x\n```mermaid\nsequenceDiagram"), [
			{ kind: "text", content: "x" },
			{ kind: "mermaid", content: "sequenceDiagram" },
		]);
	});

	it("leaves non-mermaid fences (and mermaid lines inside them) as text", () => {
		const text = "```js\n```mermaid\n```\nafter";
		assert.deepEqual(splitMermaidFences(text), [{ kind: "text", content: text }]);
	});

	it("accepts indentation and spacing around the info string", () => {
		assert.deepEqual(splitMermaidFences("  ``` mermaid \nA\n  ```"), [{ kind: "mermaid", content: "A" }]);
	});
});

describe("isInsideMermaidFence", () => {
	const text = "hi\n```mermaid\nA\n```\nbye";
	const at = (needle: string, delta = 0) => text.indexOf(needle) + delta;

	it("is false before the opener line ends and after the closer", () => {
		assert.equal(isInsideMermaidFence(text, 0), false);
		assert.equal(isInsideMermaidFence(text, at("```mermaid")), false);
		assert.equal(isInsideMermaidFence(text, at("\nbye")), false);
		assert.equal(isInsideMermaidFence(text, text.length), false);
	});

	it("is true from the opener line's end to the closer line's start", () => {
		assert.equal(isInsideMermaidFence(text, at("```mermaid", "```mermaid".length)), true);
		assert.equal(isInsideMermaidFence(text, at("A")), true);
		assert.equal(isInsideMermaidFence(text, at("A", 1)), true);
		assert.equal(isInsideMermaidFence(text, at("```\nbye")), true);
	});

	it("is true anywhere after an unclosed opener", () => {
		const open = "x\n```mermaid\nflowchart";
		assert.equal(isInsideMermaidFence(open, open.length), true);
		assert.equal(isInsideMermaidFence(open, 1), false);
	});

	it("is false inside a non-mermaid fence", () => {
		assert.equal(isInsideMermaidFence("```js\nconst a\n```", 8), false);
	});
});

describe("insertSnippet", () => {
	it("inserts into an empty field with the caret at the given offset", () => {
		assert.deepEqual(insertSnippet("", 0, 0, "```mermaid\nA\n```", 12), { text: "```mermaid\nA\n```", cursor: 12 });
	});

	it("pads onto its own lines mid-line", () => {
		const r = insertSnippet("abcdef", 3, 3, "S");
		assert.deepEqual(r, { text: "abc\nS\ndef", cursor: 5 });
	});

	it("adds no padding at line boundaries and replaces the selection", () => {
		const r = insertSnippet("one\nXX\ntwo", 4, 6, "S");
		assert.deepEqual(r, { text: "one\nS\ntwo", cursor: 5 });
	});
});
