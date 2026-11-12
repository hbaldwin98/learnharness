import test from "node:test";
import assert from "node:assert/strict";
import {
	answerCitations,
	buildSessionSnapshot,
	citationProblems,
	derivePlanStatuses,
	discussionMarkerText,
	markdownBlocks,
	markUnverifiedLinks,
	normalizeUrl,
	parseDiscussionAsk,
	parseReadingRequest,
	placeThreads,
	planNodeStatuses,
	readingsForChat,
	submittedReadingProblem,
	type ReadingRecord,
} from "../src/contract.ts";

const tree = { nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], edges: [{ from: "a", to: "b" }], version: 2 };
const call = (nodeId: string) => ({ role: "assistant", content: [{ type: "toolCall", id: nodeId, name: "quiz", arguments: { nodeId, question: `About ${nodeId}?` } }] });
const messages = [{ role: "user", content: "teach me" }, { role: "assistant", content: [{ type: "text", text: "Let's start." }] }, call("a"), call("b")];

test("request grammar: kind-specific anchors", () => {
	assert.equal(parseReadingRequest({ kind: "recap" }).ok, false);
	assert.equal(parseReadingRequest({ kind: "deep-dive", chatId: "c" }).ok, false);
	assert.equal(parseReadingRequest({ kind: "primer", topic: "graphs" }).ok, true);
	assert.equal(parseReadingRequest({ kind: "node", nodeIds: [] }).ok, false);
	const node = parseReadingRequest({ kind: "node", nodeIds: Array.from({ length: 80 }, (_, i) => `n${i}`) });
	assert.ok(node.ok && node.value.nodeIds!.length === 64);
	assert.deepEqual(parseReadingRequest({ rerunOf: "rd_1", mode: "model" }), { ok: true, value: { kind: "recap", rerunOf: "rd_1", mode: "model" } });
});

test("plan statuses come from tagged calls; snapshots fence upcoming nodes", () => {
	const s = derivePlanStatuses(tree, messages);
	assert.equal(s.current, "b");
	assert.deepEqual([...s.visited], ["a"]);
	const dd = buildSessionSnapshot("deep-dive", { title: "T", messages, tree }, { planNodeId: "a" });
	assert.ok(dd.ok);
	assert.deepEqual(dd.ok && dd.value.upcoming, ["C"]);
	assert.match(dd.ok ? dd.value.transcript! : "", /### Teacher\n\nLet's start\./);
	const ov = buildSessionSnapshot("overview", { title: "T", messages, tree }, {});
	assert.deepEqual(ov.ok && ov.value.planNodes?.map((n) => n.id), ["a", "b", "c"]);
	assert.deepEqual(planNodeStatuses({ title: "T", messages, tree }, ["a", "b", "c", "gone"]), { a: "visited", b: "current", c: "upcoming" });
	assert.equal(buildSessionSnapshot("recap", { title: "T", messages: [] }, {}).ok, false);
	assert.equal(buildSessionSnapshot("deep-dive", { title: "T", messages, tree }, { planNodeId: "zzz" }).ok, false);
});

test("the citation law: only fetched URLs; model mode carries none", () => {
	const fetched = new Set([normalizeUrl("https://Example.com/a/")]);
	assert.deepEqual(citationProblems([{ url: "https://example.com/a#x" }], fetched, "researched"), []);
	assert.equal(citationProblems([{ url: "https://example.com/b" }], fetched, "researched").length, 1);
	assert.equal(citationProblems([{ url: "https://example.com/a" }], fetched, "model").length, 1);
	const body = "x".repeat(250);
	const base = { title: "T", body, terms: [], sections: [], sources: [], furtherReading: [] };
	assert.equal(submittedReadingProblem("deep-dive", "model", base, new Set()), null);
	assert.match(submittedReadingProblem("deep-dive", "model", { ...base, body: `${body} https://x.org` }, new Set())!, /no URLs/);
	assert.match(submittedReadingProblem("recap", "researched", base, new Set())!, /furtherReading/);
	assert.match(submittedReadingProblem("primer", "model", base, new Set())!, /at least 3/);
	const sections = [{ heading: "H", body, planNodeIds: ["zz"] }, { heading: "I", body }];
	assert.match(submittedReadingProblem("overview", "model", { ...base, body: "", sections }, new Set(), new Set(["a"]))!, /Unknown plan node/);
});

test("Discuss: ask grammar, citations, unverified links, placement, marker text", () => {
	assert.equal(parseDiscussionAsk({ question: "q", mode: "model", threadId: "t", passage: "p" }).ok, false);
	const { sources, unverifiedUrls } = answerCitations("See [Doc](https://a.org/x) and https://b.org.", new Set([normalizeUrl("https://a.org/x")]), "researched");
	assert.deepEqual(sources, [{ title: "Doc", url: "https://a.org/x" }]);
	assert.deepEqual(unverifiedUrls, ["https://b.org"]);
	assert.equal(markUnverifiedLinks("[B](https://b.org) and https://b.org.", ["https://b.org"]), "B *(unverified link)* and `https://b.org` *(unverified link)*.");
	const placed = placeThreads([{ blockKey: "body:0" }, { blockKey: "body:9" }, {}], new Set(["body:0"]));
	assert.equal(placed.inline.get("body:0")!.length, 1);
	assert.equal(placed.fallback.length, 2);
	const text = discussionMarkerText({ readingTitle: "R", readingKind: "recap", passage: "p", question: "q?", answer: "a" });
	assert.match(text, /Reading discussion/);
	assert.match(text, /> q\?/);
});

test("markdown blocks keep fences, math and lists whole", () => {
	const md = "Intro para\nline two\n\n```js\na\n\nb\n```\n\n$$\nx\n\ny\n$$\n\n- one\n\n- two\n\n## Head\nText";
	assert.deepEqual(markdownBlocks(md), ["Intro para\nline two", "```js\na\n\nb\n```", "$$\nx\n\ny\n$$", "- one\n\n- two", "## Head", "Text"]);
});

test("a session's readings hide versions replaced by a live or ready re-run", () => {
	const r = (id: string, extra: Partial<ReadingRecord> = {}) => ({ id, anchor: { chatId: "c" }, createdAt: id, status: "ready" as const, ...extra });
	assert.deepEqual(readingsForChat([r("1"), r("2", { supersedes: "1" })], "c").map((x) => x.id), ["2"]);
	assert.deepEqual(readingsForChat([r("1"), r("2", { supersedes: "1", status: "error" })], "c").map((x) => x.id), ["2", "1"]);
});
