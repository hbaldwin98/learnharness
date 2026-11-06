"use client";

/**
 * "On this page" (Graphite Reading board; fork-owned, see
 * docs/graphite-plan.md). Mounted at the foot of the reading's Discuss
 * column; it reads the h2 headings of the article beside it from the DOM,
 * so it needs no data from upstream's reading renderer.
 */

import { useEffect, useRef, useState } from "react";

export function ReadingToc() {
	const ref = useRef<HTMLElement>(null);
	const [heads, setHeads] = useState<HTMLElement[]>([]);

	useEffect(() => {
		const article = ref.current?.closest('[data-testid="discuss-column"]')?.previousElementSibling;
		if (!article) return;
		const read = () => {
			const next = Array.from(article.querySelectorAll<HTMLElement>("h2")).filter((h) => h.textContent?.trim());
			setHeads((prev) =>
				prev.length === next.length && prev.every((h, i) => h === next[i]) ? prev : next,
			);
		};
		read();
		const mo = new MutationObserver(read);
		mo.observe(article, { childList: true, subtree: true });
		return () => mo.disconnect();
	}, []);

	return (
		<nav ref={ref} aria-label="On this page" className="lh-toc" data-testid="reading-toc" hidden={heads.length < 2}>
			<span className="lh-toc-label">On this page</span>
			{heads.map((h, i) => (
				<button
					key={i}
					type="button"
					className="lh-toc-link"
					onClick={() => h.scrollIntoView({ behavior: "smooth", block: "start" })}
				>
					{h.textContent}
				</button>
			))}
		</nav>
	);
}
