/** Fork chrome: breadcrumb, status pill, resume cards, new-session hero. */
import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BreadcrumbPrefix, StatusPill } from "../components/lh/breadcrumb.tsx";
import { NewSessionHero } from "../components/lh/new-session-hero.tsx";
import { ResumeCardList, resumeCandidates, waitingReason } from "../components/lh/resume-cards.tsx";
import type { ChatListItem } from "../src/core/index.ts";

const chat = (over: Partial<ChatListItem>): ChatListItem => ({
	id: "c", title: "T", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", kind: "teach",
	messageCount: 1, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, ...over,
} as ChatListItem);

describe("breadcrumb", () => {
	it("names the session kind", () => {
		assert.match(renderToStaticMarkup(<BreadcrumbPrefix kind="practice" />), /Practice/);
		assert.match(renderToStaticMarkup(<BreadcrumbPrefix kind="teach" />), /Teaching/);
	});
	it("status pill: probing wins, idle renders nothing", () => {
		assert.match(renderToStaticMarkup(<StatusPill probing working />), /data-state="probing"[^]*Probing/);
		assert.match(renderToStaticMarkup(<StatusPill probing={false} working />), /Working/);
		assert.equal(renderToStaticMarkup(<StatusPill probing={false} working={false} />), "");
	});
});

describe("resume cards", () => {
	it("keeps the two most recent waiting sessions", () => {
		const list = [
			chat({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z", pendingQuestion: true }),
			chat({ id: "b", updatedAt: "2026-01-03T00:00:00.000Z", kind: "practice", pendingProblem: true }),
			chat({ id: "c", updatedAt: "2026-01-04T00:00:00.000Z" }),
			chat({ id: "d", updatedAt: "2026-01-02T00:00:00.000Z", pendingQuestion: true }),
		];
		assert.deepEqual(resumeCandidates(list).map((c) => c.id), ["b", "d"]);
		assert.equal(waitingReason(list[1]!), "A problem is waiting");
		assert.equal(waitingReason(chat({ pendingProblem: true })), null);
	});
	it("renders links, or nothing when none wait", () => {
		assert.equal(renderToStaticMarkup(<ResumeCardList cards={[]} />), "");
		assert.match(renderToStaticMarkup(<ResumeCardList cards={[chat({ id: "x", pendingQuestion: true })]} />), /href="\/chat\/x"[^]*A probe is waiting/);
	});
});

describe("new-session hero", () => {
	it("asks per mode", () => {
		assert.match(renderToStaticMarkup(<NewSessionHero mode="practice" />), /to practice\?/);
		assert.match(renderToStaticMarkup(<NewSessionHero />), /to understand\?/);
	});
});
