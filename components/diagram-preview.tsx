"use client";

import { useEffect, useMemo, useState } from "react";
import { splitMermaidFences } from "@/src/core";
import { renderMermaid } from "@/components/mermaid-render";

const DEBOUNCE_MS = 400;

/** The dock's live preview of the learner's ```mermaid fences — nothing
 *  when the draft has none. Debounced so each keystroke isn't a parse;
 *  mid-typing a chart is usually invalid, so a failure is one muted line,
 *  not the transcript's MermaidError card (its Retry means nothing here). */
export function DiagramPreview({ text }: { text: string }) {
	const [settled, setSettled] = useState(text);
	useEffect(() => {
		const id = setTimeout(() => setSettled(text), DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [text]);

	const charts = useMemo(
		() => splitMermaidFences(settled).filter((s) => s.kind === "mermaid").map((s) => s.content),
		[settled],
	);
	if (charts.length === 0) return null;
	return (
		<div data-testid="diagram-preview" className="mx-2.5 mb-1 max-h-64 overflow-auto rounded-md border border-border/60 p-2">
			{charts.map((chart, i) => (
				<PreviewChart key={i} chart={chart} />
			))}
		</div>
	);
}

function PreviewChart({ chart }: { chart: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		renderMermaid(chart)
			.then((s) => {
				if (cancelled) return;
				setSvg(s);
				setError(null);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [chart]);

	if (error !== null) {
		const firstLine = error.split("\n")[0];
		return (
			<p data-testid="diagram-preview-error" className="truncate text-xs text-muted-foreground" title={error}>
				Diagram doesn&apos;t parse yet: {firstLine}
			</p>
		);
	}
	if (svg === null) return null;
	return (
		<div
			data-streamdown="mermaid"
			className="flex justify-center [&_svg]:max-w-full"
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
