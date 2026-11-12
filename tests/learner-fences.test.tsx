import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { splitLearnerFences } from "../src/core/learner-fences.ts";
import { LearnerText } from "../components/learner-text.tsx";

test("learner text splits into plain runs and fences, with unclosed and nested-language handling", () => {
	assert.deepEqual(splitLearnerFences("plain only"), [{ kind: "text", content: "plain only" }]);
	assert.deepEqual(splitLearnerFences("before\n```mermaid\ngraph TD\nA-->B\n```\nafter"), [
		{ kind: "text", content: "before" },
		{ kind: "fence", language: "mermaid", meta: "", content: "graph TD\nA-->B", incomplete: false, raw: "```mermaid\ngraph TD\nA-->B\n```" },
		{ kind: "text", content: "after" },
	]);
	const js = splitLearnerFences("```js title=x\n```mermaid\n```");
	assert.deepEqual(js, [{ kind: "fence", language: "js", meta: "title=x", content: "```mermaid", incomplete: false, raw: "```js title=x\n```mermaid\n```" }]);
	assert.deepEqual(splitLearnerFences("```python\nprint(1)"), [{ kind: "fence", language: "python", meta: "", content: "print(1)", incomplete: true, raw: "```python\nprint(1)" }]);
});

test("without a registered renderer, non-mermaid fences stay plain learner text", () => {
	const html = renderToStaticMarkup(<LearnerText text={"see\n```python\nprint(1)\n```"} textClassName="italic" />);
	assert.match(html, /see/);
	assert.match(html, /```python\nprint\(1\)\n```/);
	assert.doesNotMatch(html, /data-plugin-renderer/);
});
