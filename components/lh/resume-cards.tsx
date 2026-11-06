"use client";

/**
 * "Pick up where you left off" (Graphite Home board; fork-owned, see
 * docs/graphite-plan.md): the two most recent sessions that are waiting
 * on the learner — a pending probe, or a practice problem.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { timeAgo } from "@/components/sidebar";
import type { ChatListItem } from "@/src/core";

function waiting(c: ChatListItem): string | null {
	if (c.pendingQuestion) return "A probe is waiting";
	if ((c.kind ?? "teach") === "practice" && c.pendingProblem) return "A problem is waiting";
	return null;
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

	const cards = (chats ?? [])
		.filter((c) => waiting(c))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, 2);
	if (cards.length === 0) return null;

	return (
		<section aria-label="Pick up where you left off" className="lh-resume" data-testid="resume-cards">
			<span className="lh-resume-label">Pick up where you left off</span>
			<div className="lh-resume-grid">
				{cards.map((c) => (
					<Link key={c.id} href={`/chat/${c.id}`} className="lh-resume-card">
						<span className="lh-resume-title">{c.title}</span>
						<span className="lh-resume-meta">
							<span className="lh-status-dot" aria-hidden="true" />
							{waiting(c)} · {timeAgo(c.updatedAt)}
						</span>
					</Link>
				))}
			</div>
		</section>
	);
}
