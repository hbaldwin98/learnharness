/**
 * The way back from a pick-mode Deep dive (docs/readings.md §6.1): the
 * reading opens in place, so the practice draft it interrupts (picks,
 * typed text, Teach/Practice mode) is saved to sessionStorage just
 * before navigating and restored ONCE when its screen mounts again.
 * Storage is best-effort: when it is unavailable the draft is lost and
 * the Deep dive still runs.
 */

export type ReturnPick = { id: string; name: string; statement: string };
export type DeepDiveReturn = { text: string; picks: ReturnPick[]; mode?: "teach" | "practice" };

export const HOME_RETURN_KEY = "lh:deep-dive-return:home";
export const newSessionReturnKey = (mode: "teach" | "practice") => `lh:deep-dive-return:new-session:${mode}`;

export function saveDeepDiveReturn(key: string, value: DeepDiveReturn): void {
	try {
		sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Best-effort: no storage, no restore.
	}
}

/** Reads and removes the saved draft; null when absent or malformed. */
export function takeDeepDiveReturn(key: string): DeepDiveReturn | null {
	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem(key);
		sessionStorage.removeItem(key);
	} catch {
		return null;
	}
	if (raw === null) return null;
	try {
		return parseDeepDiveReturn(JSON.parse(raw));
	} catch {
		return null;
	}
}

function parseDeepDiveReturn(value: unknown): DeepDiveReturn | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.text !== "string" || !Array.isArray(v.picks)) return null;
	const picks: ReturnPick[] = [];
	for (const p of v.picks) {
		if (typeof p !== "object" || p === null) return null;
		const { id, name, statement } = p as Record<string, unknown>;
		if (typeof id !== "string" || typeof name !== "string" || typeof statement !== "string") return null;
		picks.push({ id, name, statement });
	}
	const mode = v.mode === "teach" || v.mode === "practice" ? v.mode : undefined;
	return { text: v.text, picks, ...(mode ? { mode } : {}) };
}
