"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { PlusIcon } from "lucide-react";
import { formatBinding, insertSnippet, isInsideMermaidFence } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { DIAGRAM_TEMPLATES, fencedTemplate, type DiagramTemplate } from "@/components/diagram-templates";
import { readPathSelection, restorePathSelection, type TextSelection } from "@/components/path-input-dom";

/** One dock field's diagram wiring, over a PathInput (offsets are source
 *  offsets — a chip counts as its quoted path). `getValue`/`setValue` are
 *  the field's own pair (setValue writes state AND its mirror ref — the
 *  docks' "nothing gets lost" rule). `track` (onSelect) keeps `inFence`
 *  current for the hint row and remembers the caret, which a contenteditable
 *  loses to the menu's focus; `enterIsNewline` decides a bare Enter inside
 *  a fence. */
export function useDiagramField(
	fieldRef: RefObject<HTMLElement | null>,
	getValue: () => string,
	setValue: (value: string) => void,
) {
	const [inFence, setInFence] = useState(false);
	const caretRef = useRef<TextSelection | null>(null);
	const range = (selection: TextSelection) => ({
		start: Math.min(selection.anchor, selection.focus),
		end: Math.max(selection.anchor, selection.focus),
	});
	const track = () => {
		const el = fieldRef.current;
		const selection = el && readPathSelection(el);
		if (!selection) return;
		caretRef.current = selection;
		setInFence(isInsideMermaidFence(getValue(), range(selection).start));
	};
	const insert = (template: DiagramTemplate) => {
		const el = fieldRef.current;
		const value = getValue();
		const live = el && el.ownerDocument.activeElement === el ? readPathSelection(el) : null;
		const caret = live ?? caretRef.current;
		const { start, end } = caret
			? { start: Math.min(range(caret).start, value.length), end: Math.min(range(caret).end, value.length) }
			: { start: value.length, end: value.length };
		const { snippet, cursor } = fencedTemplate(template);
		const next = insertSnippet(value, start, end, snippet, cursor);
		setValue(next.text);
		setInFence(true);
		caretRef.current = { anchor: next.cursor, focus: next.cursor };
		requestAnimationFrame(() => {
			if (!el) return;
			el.focus();
			restorePathSelection(el, { anchor: next.cursor, focus: next.cursor });
		});
	};
	const enterIsNewline = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.metaKey || event.ctrlKey) return false;
		const selection = readPathSelection(event.currentTarget);
		return selection !== null && isInsideMermaidFence(getValue(), range(selection).start);
	};
	return { inFence, track, insert, enterIsNewline };
}

/** The submit row's hint, fence-aware. */
export function submitHint(inFence: boolean): string {
	return inFence ? `↵ newline · ${formatBinding("mod+enter")} submits` : "↵ submits · ⇧↵ newline";
}

/** "+ Diagram" in a dock's submit row: a small upward menu of Mermaid
 *  starters. The dock owns insertion (caret, state + mirror ref); this
 *  only reports the pick. Dismissal is the site's own (the
 *  dictation-language pattern): outside pointerdown, Esc back to the
 *  trigger. */
export function DiagramButton({ onInsert }: { onInsert: (template: DiagramTemplate) => void }) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="diagram-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				data-testid="diagram-button"
				aria-label="Insert a diagram"
				aria-expanded={open}
				onKeyDown={(event) => {
					if (open) closeOnEscape(event);
				}}
				onClick={() => setOpen((v) => !v)}
				className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<PlusIcon className="size-3.5" />
				Diagram
			</button>
			{open && (
				<MenuShell
					anchorRef={triggerRef}
					testid="diagram-menu"
					preferredSide="up"
					align="left"
					menuClass="flex w-44 flex-col rounded-xl border border-border bg-card p-1 text-sm shadow-xl"
				>
					<div
						onKeyDown={(event) => {
							closeOnEscape(event);
							// A focused option's Enter is its native click — never the
							// dock's submit.
							if (event.key === "Enter") event.stopPropagation();
						}}
					>
						{DIAGRAM_TEMPLATES.map((template) => (
							<button
								key={template.id}
								type="button"
								data-testid={`diagram-template-${template.id}`}
								onClick={() => {
									setOpen(false);
									onInsert(template);
								}}
								className="w-full rounded-md px-2.5 py-1.5 text-left text-card-foreground hover:bg-accent"
							>
								{template.label}
							</button>
						))}
					</div>
				</MenuShell>
			)}
		</>
	);
}
