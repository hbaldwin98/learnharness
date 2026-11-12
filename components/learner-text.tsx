"use client";

/** Learner-authored text in the transcript (fork E8): plain pre-wrap exactly as
 * before (quoted file paths as chips), except ``` fences render through the host
 * code-block registry — the built-in mermaid renderer, then plugin
 * registerCodeBlock renderers. Unrendered fences stay plain text. `textClassName`
 * styles the plain runs only; `wrap` decorates each run (the answered card's quotes). */
import type { ReactNode } from "react";
import { splitLearnerFences } from "@/src/core";
import { MermaidInline } from "@/components/md-blocks";
import { PluginCodeBlock, BUILTIN_MERMAID_LANGUAGE } from "@/components/plugin-renderers";
import { PathText } from "@/components/file-path-chip";

export function LearnerText({ text, textClassName, wrap = run => run }: {
	text: string;
	textClassName?: string;
	wrap?: (run: ReactNode) => ReactNode;
}) {
	const plain = (content: string, key: number) =>
		<span key={key} className={`block whitespace-pre-wrap ${textClassName ?? ""}`}>{wrap(<PathText text={content} />)}</span>;
	return <>
		{splitLearnerFences(text).map((segment, i) => {
			if (segment.kind === "text") return plain(segment.content, i);
			if (segment.language === BUILTIN_MERMAID_LANGUAGE) return <div key={i} className="my-2 not-italic"><MermaidInline chart={segment.content} /></div>;
			if (!segment.language) return plain(segment.raw, i);
			return <div key={i} className="my-2 not-italic"><PluginCodeBlock language={segment.language} source={segment.content} meta={segment.meta}
				incomplete={segment.incomplete} fallback={plain(segment.raw, i)} /></div>;
		})}
	</>;
}
