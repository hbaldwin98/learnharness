"use client";

import type { ReactNode } from "react";
import { splitMermaidFences } from "@/src/core";
import { MermaidChart } from "@/components/md-blocks";
import { PathText } from "@/components/file-path-chip";

/** Learner-authored text in the transcript: plain pre-wrap exactly as
 *  before (quoted file paths as chips), except ```mermaid fences render as
 *  charts. `textClassName` styles the plain runs only (a thinking block's
 *  italic/dim register would wash a diagram out); `wrap` decorates each run
 *  (the answered card's quotes). */
export function LearnerText({
	text,
	textClassName,
	wrap = (run) => run,
}: {
	text: string;
	textClassName?: string;
	wrap?: (run: ReactNode) => ReactNode;
}) {
	return (
		<>
			{splitMermaidFences(text).map((segment, i) =>
				segment.kind === "mermaid" ? (
					<MermaidChart key={i} chart={segment.content} />
				) : (
					<span key={i} className={`block whitespace-pre-wrap ${textClassName ?? ""}`}>
						{wrap(<PathText text={segment.content} />)}
					</span>
				),
			)}
		</>
	);
}
