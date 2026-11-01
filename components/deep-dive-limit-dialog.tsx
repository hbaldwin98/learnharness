"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { MAX_NODE_PICKS } from "@/src/core";
import { useBackdropDismiss } from "./backdrop-dismiss";

/**
 * The over-limit confirm for a Deep dive (docs/readings.md §6.1): a node
 * reading covers at most MAX_NODE_PICKS propositions. Rather than letting
 * the server drop the rest silently, the learner sees how many will be
 * covered and chooses to proceed with the first MAX_NODE_PICKS.
 */
export function DeepDiveLimitBody({ total, onCancel, onConfirm }: { total: number; onCancel: () => void; onConfirm: () => void }) {
	return <div role="dialog" aria-modal="true" aria-label="Deep dive limit" data-testid="deep-dive-limit-dialog"
		onClick={(e) => e.stopPropagation()} className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
		<h2 className="text-sm font-semibold">Deep dive covers up to {MAX_NODE_PICKS} propositions</h2>
		<p className="mt-1.5 text-sm text-muted-foreground" data-testid="deep-dive-limit-count">
			Only {MAX_NODE_PICKS} of {total} selected propositions will be included.
		</p>
		<div className="mt-4 flex justify-end gap-2">
			<button type="button" data-testid="deep-dive-limit-cancel" onClick={onCancel} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
			<button type="button" data-testid="deep-dive-limit-confirm" onClick={onConfirm} className="rounded-sm border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-primary/20">Deep dive anyway</button>
		</div>
	</div>;
}

export function DeepDiveLimitDialog({ total, onCancel, onConfirm }: { total: number | null; onCancel: () => void; onConfirm: () => void }) {
	const open = total !== null;
	const backdrop = useBackdropDismiss(onCancel);
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } };
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onCancel]);
	if (!open) return null;
	return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
		<DeepDiveLimitBody total={total} onCancel={onCancel} onConfirm={onConfirm} />
	</div>, document.body);
}
