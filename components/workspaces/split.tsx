"use client";

/**
 * The workspace side of the split view (practice workspaces, plan step 3;
 * owner ruling): a full-height sibling to the right of the transcript
 * column, with a draggable divider whose position is remembered on this
 * device. Below lg it overlays the session instead (the pane's own hide
 * button goes back to the transcript; the header's Code chip reopens it).
 */

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "lh:workspace-split";
const DEFAULT_FRACTION = 0.5;
const MIN_FRACTION = 0.25;
const MAX_FRACTION = 0.75;

const clamp = (f: number) => Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, f));

function loadFraction(): number {
	try {
		const v = Number(localStorage.getItem(STORAGE_KEY));
		return Number.isFinite(v) && v > 0 ? clamp(v) : DEFAULT_FRACTION;
	} catch {
		return DEFAULT_FRACTION;
	}
}

export function WorkspaceSide({ children }: { children: React.ReactNode }) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [fraction, setFraction] = useState(DEFAULT_FRACTION);
	const [dragging, setDragging] = useState(false);

	// localStorage is read after mount (SSR-safe).
	useEffect(() => setFraction(loadFraction()), []);

	useEffect(() => {
		if (!dragging) return;
		const parent = rootRef.current?.parentElement;
		if (!parent) return;
		let latest = fraction;
		const onMove = (e: PointerEvent) => {
			const rect = parent.getBoundingClientRect();
			latest = clamp((rect.right - e.clientX) / rect.width);
			setFraction(latest);
		};
		const onUp = () => {
			setDragging(false);
			try {
				localStorage.setItem(STORAGE_KEY, String(latest));
			} catch {
				// storage unavailable: the width holds for this page
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		// Re-subscribing per frame would drop the drag; fraction seeds it once.
	}, [dragging]);

	return (
		<div
			ref={rootRef}
			data-testid="workspace-side"
			style={{ "--lh-workspace-w": `${fraction * 100}%` } as React.CSSProperties}
			className="relative flex h-full shrink-0 max-lg:fixed max-lg:inset-0 max-lg:z-40 lg:w-(--lh-workspace-w)"
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize the workspace"
				data-testid="workspace-divider"
				onPointerDown={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDoubleClick={() => {
					setFraction(DEFAULT_FRACTION);
					try {
						localStorage.removeItem(STORAGE_KEY);
					} catch {
						// ignore
					}
				}}
				className="group relative z-10 hidden w-1.5 shrink-0 cursor-col-resize lg:block"
			>
				<div
					className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${dragging ? "bg-foreground/50" : "bg-border group-hover:bg-foreground/30"}`}
				/>
			</div>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
