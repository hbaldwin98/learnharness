"use client";

/**
 * THE NARRATION STRIP (practice workspaces, plan step 5; owner ruling): the
 * talk channel while the coding pane is open. The learner thinks aloud —
 * typed or dictated — and each piece is recorded, timestamped, into the
 * problem's trace WITHOUT starting a turn. The agent reads it with the next
 * Ask, Submit or thinking message.
 *
 * - The input is the dictation target while the pane is mounted.
 * - Recorded: on Enter (in the input, or anywhere outside a typing surface
 *   — the dictation reality), after AUTO_RECORD_MS without change unless
 *   the input has focus, and before Run and Submit (`record`).
 * - Ask takes the draft as its request instead (`takeDraft`).
 * - The unsent draft is kept on this device; the log comes from the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { bindingForAction, clockTime, formatBinding, type NarrationEntry } from "@/src/core";
import { useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { cn } from "@/lib/utils";

/** Dictated (or abandoned typed) text records itself after this long. */
export const AUTO_RECORD_MS = 4000;

const draftKey = (chatId: string, problemCallId: string) => `lh:narration-draft:${chatId}:${problemCallId}`;

function readDraft(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function writeDraft(key: string, value: string): void {
	try {
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {
		// storage unavailable: the draft just doesn't survive a reload
	}
}

export interface Narration {
	entries: NarrationEntry[];
	draft: string;
	setDraft: (v: string) => void;
	focused: boolean;
	setFocused: (v: boolean) => void;
	error: string | null;
	/** Record the draft (no-op when empty). Resolves once it is stored. */
	record: () => Promise<void>;
	/** Take the draft for an Ask: returns it and clears the field. */
	takeDraft: () => string;
}

export function useNarration(
	chatId: string,
	problemCallId: string,
	initial: NarrationEntry[] | null,
	active: boolean,
): Narration {
	const key = draftKey(chatId, problemCallId);
	const [entries, setEntries] = useState<NarrationEntry[]>([]);
	const [draft, setDraftState] = useState("");
	const draftRef = useRef("");
	const [focused, setFocused] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (initial) setEntries(initial);
	}, [initial]);
	useEffect(() => {
		const saved = readDraft(key);
		draftRef.current = saved;
		setDraftState(saved);
	}, [key]);

	const setDraft = useCallback(
		(v: string) => {
			draftRef.current = v;
			setDraftState(v);
			writeDraft(key, v);
		},
		[key],
	);

	const record = useCallback(async () => {
		const text = draftRef.current.trim();
		if (!text || !active) return;
		setDraft("");
		try {
			const res = await fetch(
				`/api/workspaces/${encodeURIComponent(chatId)}/${encodeURIComponent(problemCallId)}/narration`,
				{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) },
			);
			const body = (await res.json().catch(() => null)) as { narration?: NarrationEntry[]; error?: string } | null;
			if (!res.ok || !body?.narration) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
			setEntries(body.narration);
			setError(null);
		} catch (err) {
			// Nothing lost: the text goes back in front of whatever came since.
			setDraft(draftRef.current ? `${text} ${draftRef.current}` : text);
			setError((err as Error).message);
		}
	}, [active, chatId, problemCallId, setDraft]);

	const takeDraft = useCallback(() => {
		const text = draftRef.current.trim();
		setDraft("");
		return text;
	}, [setDraft]);

	// Dictation writes here while the pane is open (the dock lets go).
	useDictationTarget({ read: () => draftRef.current, write: setDraft }, active);

	// Auto-record: the draft settles while the learner isn't typing in it.
	useEffect(() => {
		if (!draft.trim() || focused || !active) return;
		const t = setTimeout(() => void record(), AUTO_RECORD_MS);
		return () => clearTimeout(t);
	}, [active, draft, focused, record]);

	// Enter outside any typing surface records (dictation never focuses).
	useEnterSubmits(() => void record());

	return { entries, draft, setDraft, focused, setFocused, error, record, takeDraft };
}

export function NarrationStrip({ narration, active }: { narration: Narration; active: boolean }) {
	const logRef = useRef<HTMLDivElement>(null);
	const count = narration.entries.length;
	useEffect(() => {
		const el = logRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [count]);
	const dictateKey = formatBinding(bindingForAction("toggle-dictation"));
	return (
		<div data-testid="narration-strip" className="shrink-0 border-t border-border/70">
			{count > 0 && (
				<div ref={logRef} data-testid="narration-log" className="max-h-24 overflow-y-auto px-3 pt-1.5 text-[13px]">
					{narration.entries.map((n, i) => (
						<div key={i} className="flex gap-2">
							<span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{clockTime(n.at)}</span>
							<span className="min-w-0 text-foreground/80">{n.text}</span>
						</div>
					))}
				</div>
			)}
			<div className="flex items-center gap-2 px-3 py-1.5">
				<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Narrate</span>
				<input
					data-testid="narration-input"
					value={narration.draft}
					disabled={!active}
					onChange={(e) => narration.setDraft(e.target.value)}
					onFocus={() => narration.setFocused(true)}
					onBlur={() => narration.setFocused(false)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
							e.preventDefault();
							void narration.record();
						}
					}}
					placeholder={`Think aloud — type, or dictate (${dictateKey}). Enter records; Ask sends.`}
					className={cn(
						"min-w-0 flex-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-sm outline-none",
						"placeholder:text-muted-foreground/60 focus:border-primary/50 disabled:opacity-50",
					)}
				/>
			</div>
			{narration.error && (
				<p role="alert" className="px-3 pb-1.5 text-xs text-destructive">
					Not recorded: {narration.error}
				</p>
			)}
		</div>
	);
}
