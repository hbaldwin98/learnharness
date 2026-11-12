/**
 * Dictated-text cleanup — a port of Handy's filler-word removal
 * (cjpais/Handy, MIT: src-tauri/src/audio_toolkit/text.rs).
 *
 * Two tiers, exactly as Handy ships them:
 *   - UNIVERSAL fillers are not lexical words in any language the models
 *     output, so they go regardless of language evidence;
 *   - GATED fillers are real words somewhere (Portuguese "um" = "a",
 *     Spanish "ha" = "has"), so they go only when the run's output language
 *     is KNOWN. Unknown fails closed: the gated tier is skipped.
 * A capitalized filler that opened a sentence hands its capital to the word
 * that takes its place ("Um, so I think" → "So I think").
 *
 * Ported from Handy — Copyright (c) 2025 CJ Pais, MIT License
 * (https://github.com/cjpais/Handy/blob/main/LICENSE). The same notice
 * covers the SmoothedVad port in electron/dictation-worker.mjs.
 */

const UNIVERSAL_FILLER_WORDS = [
	"uh", "uhm", "umm", "uhh", "uhhh", "ehh", "ehm", "ahm", "hmm", "hm", "mmm", "хм", "ммм",
] as const;

function gatedFillerWords(language: string): readonly string[] {
	switch (language.split(/[-_]/)[0]) {
		case "en": return ["um", "ah", "eh"];
		case "de": return ["äh", "ähm"];
		case "fr": return ["euh"];
		default: return [];
	}
}

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Handy's `(?i)\bword\b[,.]?` — with Unicode-aware boundaries, since JS's
 *  \b is ASCII-only and the list carries Cyrillic. */
const fillerPattern = (word: string) =>
	new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])[,.]?`, "giu");

/** Whether a word appended to `kept` would open a sentence. */
function opensSentence(kept: string): boolean {
	const last = kept.trimEnd().at(-1);
	return last === undefined || ".!?…".includes(last);
}

function removeFillerMatches(text: string, pattern: RegExp): string {
	let kept = "";
	let resume = 0;
	let capitalOwed = false;
	const push = (segment: string) => {
		if (capitalOwed) {
			const i = segment.search(/[\p{L}\p{N}]/u);
			if (i >= 0) {
				capitalOwed = false;
				kept += segment.slice(0, i) + segment[i]!.toUpperCase() + segment.slice(i + 1);
				return;
			}
		}
		kept += segment;
	};
	for (const filler of text.matchAll(pattern)) {
		push(text.slice(resume, filler.index));
		const first = filler[0][0]!;
		capitalOwed ||= first !== first.toLowerCase() && opensSentence(kept);
		resume = filler.index + filler[0].length;
	}
	push(text.slice(resume));
	return kept;
}

/**
 * Remove filler words. `language` is the evidence for the OUTPUT language
 * (a BCP-47-ish tag, base subtag is what counts), or null when unknown.
 */
export function removeFillerWords(text: string, language: string | null): string {
	let out = text;
	for (const word of [...UNIVERSAL_FILLER_WORDS, ...(language ? gatedFillerWords(language) : [])]) {
		out = removeFillerMatches(out, fillerPattern(word));
	}
	return out;
}

/**
 * Handy's normalize_transcription_output, which runs on every FINAL text
 * whether or not filler removal is on: a purely alphabetic word repeated 3+
 * times in a row (case-insensitive) collapses to its first instance, then
 * whitespace collapses and trims.
 */
export function normalizeDictation(text: string): string {
	const words = text.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < words.length;) {
		const word = words[i]!;
		const lower = word.toLowerCase();
		let count = 1;
		if (/^\p{L}+$/u.test(word)) while (words[i + count]?.toLowerCase() === lower) count++;
		out.push(word);
		i += count >= 3 ? count : 1;
	}
	return out.join(" ");
}

/**
 * The text a dictation run shows for its raw transcript so far.
 *
 * Local streaming models commit mid-word ("Americ" then "ans", verified
 * live), so while filler removal is on and the text may end mid-word
 * (`complete` false), the trailing token is held back until the next
 * boundary arrives — a filler can only be recognized as a whole word.
 * Deepgram's finals always end on a word boundary (`complete` true).
 * Removal leaves doubled spaces; they collapse, and the run's text never
 * starts with whitespace (the caller owns the separator against existing
 * text). The FINAL text gets Handy's normalization.
 */
export function cleanDictation(
	raw: string,
	opts: { removeFillers: boolean; language: string | null; final: boolean; complete?: boolean },
): string {
	let text = raw;
	if (opts.removeFillers) {
		if (!opts.final && !opts.complete) {
			const cut = text.search(/\s\S*$/);
			text = cut >= 0 ? text.slice(0, cut + 1) : "";
		}
		text = removeFillerWords(text, opts.language);
	}
	if (opts.final) return normalizeDictation(text);
	return text.replace(/\s{2,}/g, " ").replace(/^\s+/, "");
}
