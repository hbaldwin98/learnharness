/**
 * Render tests — learner diagrams: the "+ Diagram" trigger and live preview
 * in the docks, ```mermaid fences rendering as charts in learner text, and
 * the starter templates' shape. Static markup only (effects never run), so
 * chart rendering itself is a mount check (md-mermaid), never an svg.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PracticeDock } from "../components/practice-dock.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { ThinkingBlock } from "../components/thinking-block.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { DIAGRAM_TEMPLATES, fencedTemplate } from "../components/diagram-templates.ts";
import { splitMermaidFences } from "../src/core/mermaid-fences.ts";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";

const FENCE = "Reads dominate:\n```mermaid\nflowchart LR\n  A --> B\n```\nso cache.";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function draft(thinking: string, text: string) {
	return {
		selection: { selected: new Set<number>(), otherSelected: false, dontKnow: false },
		thinking,
		other: "",
		text,
		confidenceIndex: 4,
	};
}

describe("dock diagram affordances", () => {
	it("the practice dock carries the trigger and no preview without a fence", () => {
		const html = renderToStaticMarkup(
			<PracticeDock problemCallId="p1" input={{ statement: "Design it." }} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.ok(html.includes('data-testid="diagram-button"'));
		assert.ok(!html.includes('data-testid="diagram-preview"'));
		assert.match(html, /↵ submits · ⇧↵ newline/);
	});

	it("the quiz thinking field carries the trigger; a drafted fence mounts the preview", () => {
		const plain = renderToStaticMarkup(
			<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.ok(plain.includes('data-testid="diagram-button"'));
		assert.ok(!plain.includes('data-testid="diagram-preview"'));
		const drafted = renderToStaticMarkup(
			<QuestionDock toolName="quiz" toolCallId="q2" input={quizInput} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft(FENCE, "")} />,
		);
		assert.ok(drafted.includes('data-testid="diagram-preview"'));
	});

	it("the free-text answer field previews its own text, not the thinking", () => {
		const html = renderToStaticMarkup(
			<QuestionDock toolName="ask_user_question" toolCallId="a1" input={{ question: "Sketch it." }} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft("", FENCE)} />,
		);
		assert.ok(html.includes('data-testid="answer-field"'));
		assert.ok(html.includes('data-testid="diagram-button"'));
		assert.ok(html.includes('data-testid="diagram-preview"'));
	});
});

describe("learner text in the transcript", () => {
	it("ThinkingBlock renders a fence as a chart and keeps the prose plain", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text={FENCE} defaultOpen />);
		assert.ok(html.includes('data-testid="md-mermaid"'));
		assert.ok(html.includes("Reads dominate:") && html.includes("so cache."));
		assert.ok(!html.includes("```mermaid"), "the fence source is not shown raw");
	});

	it("ThinkingBlock without a fence is the plain text as before", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text={"line one\nline two"} defaultOpen />);
		assert.ok(html.includes("line one\nline two"));
		assert.ok(!html.includes("md-mermaid"));
	});

	it("AnsweredCard quotes the text runs and renders the chart between them", () => {
		const qd: QuestionData = {
			id: "e1",
			kind: "explain",
			question: "Sketch the cache.",
			mode: "text",
			options: [],
			committedAnswer: "A read-through cache in front of the database.",
			createdAt: new Date().toISOString(),
		};
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(qd, { text: FENCE })} />);
		assert.ok(html.includes("“Reads dominate:”") && html.includes("“so cache.”"));
		assert.ok(html.includes('data-testid="md-mermaid"'));
	});
});

describe("diagram starter templates", () => {
	it("each inserts as one closed mermaid fence with the caret on the type line", () => {
		const keywords = /^(flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|C4Context|C4Container)\b/;
		for (const template of DIAGRAM_TEMPLATES) {
			const { snippet, cursor } = fencedTemplate(template);
			const segments = splitMermaidFences(snippet);
			assert.equal(segments.length, 1, template.id);
			assert.equal(segments[0]!.kind, "mermaid", template.id);
			assert.match(segments[0]!.content, keywords, template.id);
			assert.ok(snippet.endsWith("\n```"), template.id);
			assert.equal(snippet[cursor], "\n", `${template.id}: caret at the end of the type line`);
		}
	});
});
