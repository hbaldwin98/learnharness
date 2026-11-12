"use client";

/**
 * Fork chrome: "Pick up where you left off" — the two most recent
 * sessions waiting on the learner (a pending probe, or a practice
 * problem). Styled with the host theme tokens; the lh-* classes are
 * hooks for theme plugins.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { timeAgo } from "@/components/sidebar";
import type { ChatListItem } from "@/src/core";

export function waitingReason(c: Pick<ChatListItem, "pendingQuestion" | "pendingProblem" | "kind">): string | null {
	if (c.pendingQuestion) return "A probe is waiting";
	if (c.kind === "practice" && c.pendingProblem) return "A problem is waiting";
	return null;
}

/** The cards to show: waiting sessions, most recent first, at most two. */
export function resumeCandidates(chats: readonly ChatListItem[]): ChatListItem[] {
	return chats
		.filter((c) => waitingReason(c))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, 2);
}

export function ResumeCardList({ cards }: { cards: readonly ChatListItem[] }) {
	if (cards.length === 0) return null;
	return (
		<section aria-label="Pick up where you left off" className="lh-resume mt-7 flex flex-col gap-2.5" data-testid="resume-cards">
			<span className="lh-resume-label text-xs text-muted-foreground">Pick up where you left off</span>
			<div className="lh-resume-grid grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
				{cards.map((c) => (
					<Link key={c.id} href={`/chat/${c.id}`} className="lh-resume-card flex flex-col gap-1.5 rounded-[10px] border bg-card px-4 py-3.5 transition-colors hover:bg-accent">
						<span className="lh-resume-title truncate text-sm font-medium text-foreground">{c.title}</span>
						<span className="lh-resume-meta flex items-center gap-1.5 text-xs text-muted-foreground">
							<span className="lh-status-dot size-1.5 rounded-full bg-primary" aria-hidden="true" />
							{waitingReason(c)} · {timeAgo(c.updatedAt)}
						</span>
					</Link>
				))}
			</div>
		</section>
	);
}

export function ResumeCards() {
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	useEffect(() => {
		let alive = true;
		fetch("/api/chats", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ chats: ChatListItem[] }>) : null))
			.then((d) => {
				if (alive && d) setChats(d.chats);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	return <ResumeCardList cards={resumeCandidates(chats ?? [])} />;
}
