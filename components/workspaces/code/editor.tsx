"use client";

/**
 * One CodeMirror 6 editor (practice workspaces, plan step 3): a file's
 * text, its language's highlighting, Vim mode when on (live), read-only for
 * the visible tests. Theme from the app's CSS variables.
 *
 * Keys: while the editor has focus, Esc and Tab belong to it (owner ruling:
 * Esc never dismisses the problem or stops dictation from inside the
 * editor), and so does any key the editor itself handled — Vim's Ctrl-D, the
 * editor's own find. Everything else (Run, Submit, dictation) still reaches
 * the app's shortcut dispatcher.
 */

import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { CodeDiagnostic } from "@/src/core";
import { toEditorDiagnostics } from "./diagnostic-positions";
import { annotationField, annotationTheme, setAnnotations, type EditorAnnotation } from "./annotation-decorations";
import {
	EditorView,
	crosshairCursor,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	HighlightStyle,
	indentOnInput,
	indentUnit,
	StreamLanguage,
	syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { vim } from "@replit/codemirror-vim";

/** The highlighting for a file, by its extension. */
export function languageFor(path: string): Extension {
	const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
	switch (ext) {
		case "js":
		case "mjs":
		case "cjs":
			return javascript();
		case "ts":
		case "mts":
			return javascript({ typescript: true });
		case "py":
			return python();
		case "java":
			return java();
		case "c":
		case "cc":
		case "cpp":
		case "h":
		case "hpp":
			return cpp();
		case "rs":
			return rust();
		case "go":
			return go();
		case "cs":
			return StreamLanguage.define(csharp);
		default:
			return [];
	}
}

/** Muted token colours for the app's dark surface. */
const highlight = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c792ea" },
	{ tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6a7" },
	{ tag: [t.number, t.bool, t.null, t.atom], color: "#f6c177" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "#6f6f6f", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#82aaff" },
	{ tag: [t.typeName, t.className, t.namespace], color: "#ffcb6b" },
	{ tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e6e6e6" },
	{ tag: [t.propertyName], color: "#b8c4d6" },
	{ tag: [t.operator, t.punctuation, t.bracket], color: "#a0a0a0" },
	{ tag: [t.meta, t.annotation, t.processingInstruction], color: "#89ddff" },
	{ tag: t.invalid, color: "#ff6b6b" },
]);

const theme = EditorView.theme(
	{
		"&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)", fontSize: "13px" },
		".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
		".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
		".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none" },
		".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 45%, transparent)" },
		".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
		"&.cm-focused": { outline: "none" },
		".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
			backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent) !important",
		},
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
		".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
		".cm-panels-bottom": { borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: "12px" },
		".cm-tooltip": { backgroundColor: "var(--card)", color: "var(--foreground)", border: "1px solid var(--border)", borderRadius: "6px" },
		".cm-tooltip-lint": { fontFamily: "var(--font-mono)", fontSize: "12px", maxWidth: "36rem" },
		".cm-diagnostic": { padding: "4px 8px", whiteSpace: "pre-wrap" },
		".cm-diagnostic-error": { borderLeft: "3px solid #ef4444" },
		".cm-diagnostic-warning": { borderLeft: "3px solid #f59e0b" },
		".cm-diagnosticSource": { color: "var(--muted-foreground)" },
		".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--primary) 18%, transparent)", outline: "none" },
		".cm-fat-cursor": { background: "color-mix(in oklab, var(--foreground) 70%, transparent) !important", color: "var(--background) !important" },
		"&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--muted-foreground)" },
	},
	{ dark: true },
);

export interface CodeEditorProps {
	path: string;
	initial: string;
	readOnly?: boolean;
	vimMode: boolean;
	onChange?: (content: string) => void;
	/** Focus on mount (the active tab). */
	autoFocus?: boolean;
	/** The language server's errors and warnings for this file. */
	diagnostics?: readonly CodeDiagnostic[];
	/** The agent's live notes on this file (plan step 7). */
	annotations?: readonly EditorAnnotation[];
	onDismissAnnotation?: (id: string) => void;
}

export function CodeEditor({ path, initial, readOnly = false, vimMode, onChange, autoFocus, diagnostics, annotations, onDismissAnnotation }: CodeEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const vimSlot = useRef(new Compartment());
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// One view per mount; the document is owned by the view from here on.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: initial,
				extensions: [
					// Vim first, so its keys win over the default keymap.
					vimSlot.current.of(vimMode ? vim({ status: true }) : []),
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightSpecialChars(),
					history(),
					foldGutter(),
					drawSelection(),
					dropCursor(),
					EditorState.allowMultipleSelections.of(true),
					indentOnInput(),
					indentUnit.of("    "),
					syntaxHighlighting(highlight),
					bracketMatching(),
					rectangularSelection(),
					crosshairCursor(),
					highlightActiveLine(),
					highlightSelectionMatches(),
					keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
					languageFor(path),
					lintGutter(),
					annotationField,
					annotationTheme,
					theme,
					EditorState.readOnly.of(readOnly),
					EditorView.editable.of(!readOnly),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
					}),
				],
			}),
		});
		viewRef.current = view;
		if (autoFocus) view.focus();
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// The view is created once per mount (keyed by path upstream).
	}, []);

	// Vim follows the preference live.
	useEffect(() => {
		viewRef.current?.dispatch({ effects: vimSlot.current.reconfigure(vimMode ? vim({ status: true }) : []) });
	}, [vimMode]);

	// The language server's errors and warnings (plan step 4). They were
	// computed for the last save; positions are clamped to the current text,
	// and the lint extension maps them through later edits itself.
	const diagnosticsKey = JSON.stringify(diagnostics ?? []);
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch(setDiagnostics(view.state, toEditorDiagnostics(view.state.doc, diagnostics ?? [])));
		// diagnosticsKey stands in for the array (a new array each fetch).
	}, [diagnosticsKey]);

	// The agent's notes (plan step 7), rebuilt when the server's set changes.
	const dismissRef = useRef(onDismissAnnotation);
	dismissRef.current = onDismissAnnotation;
	const annotationsKey = JSON.stringify(annotations ?? []);
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({ effects: setAnnotations.of({ list: [...(annotations ?? [])], onDismiss: (id) => dismissRef.current?.(id) }) });
		// annotationsKey stands in for the array.
	}, [annotationsKey]);

	return (
		<div
			ref={hostRef}
			data-testid={`code-editor-${path}`}
			className="h-full min-h-0 overflow-hidden"
			onKeyDown={(e) => {
				const bare = !(e.metaKey || e.ctrlKey || e.altKey);
				if (e.key === "Escape" || (e.key === "Tab" && bare) || e.defaultPrevented) e.stopPropagation();
			}}
		/>
	);
}
