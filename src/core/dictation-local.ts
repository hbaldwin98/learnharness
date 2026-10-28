/**
 * Local dictation — the browser-safe facts the renderer, the settings
 * sanitizer, and the Electron dictation worker all share.
 *
 * The engine is transcribe.cpp (the speech library Handy runs), loaded in an
 * Electron utility process. Only the two streaming models the owner uses are
 * offered; Q8_0 is the library's recommended quantization. Sizes and sha256
 * come from the Hugging Face tree API (lfs.oid) for handy-computer/*-gguf.
 */

export type LocalDictationModelId = "parakeet-unified-en-0.6b" | "nemotron-3.5-asr-streaming-0.6b";

/** Nemotron 3.5's 32 supported locales (catalog/nemotron-3.5-asr-streaming-0.6b.json). */
const NEMOTRON_35_LOCALES = [
	["en-US", "English (US)"], ["en-GB", "English (UK)"], ["es-US", "Spanish (US)"], ["es-ES", "Spanish (Spain)"],
	["fr-FR", "French (France)"], ["fr-CA", "French (Canada)"], ["it-IT", "Italian"], ["pt-BR", "Portuguese (Brazil)"],
	["pt-PT", "Portuguese (Portugal)"], ["nl-NL", "Dutch"], ["de-DE", "German"], ["tr-TR", "Turkish"],
	["ru-RU", "Russian"], ["ar-AR", "Arabic"], ["hi-IN", "Hindi"], ["ja-JP", "Japanese"],
	["ko-KR", "Korean"], ["vi-VN", "Vietnamese"], ["uk-UA", "Ukrainian"], ["pl-PL", "Polish"],
	["sv-SE", "Swedish"], ["cs-CZ", "Czech"], ["nb-NO", "Norwegian (Bokmål)"], ["da-DK", "Danish"],
	["bg-BG", "Bulgarian"], ["fi-FI", "Finnish"], ["hr-HR", "Croatian"], ["sk-SK", "Slovak"],
	["zh-CN", "Chinese (Mandarin, Simplified)"], ["hu-HU", "Hungarian"], ["ro-RO", "Romanian"], ["et-EE", "Estonian"],
] as const;

/** "auto" is ours: the stream is begun WITHOUT a language (the library
 *  rejects the literal "auto"; omitting it selects the model's auto slot —
 *  verified on Nemotron 3.5, 2026-10-27). */
export type LocalDictationLanguage = "auto" | (typeof NEMOTRON_35_LOCALES)[number][0];

/** How the worker opens the model's stream (transcribe-cpp StreamOptions.family). */
export type LocalStreamFamily =
	| { kind: "parakeet"; attContextRight: number }
	| { kind: "parakeet_buffered"; leftMs: number; chunkMs: number; rightMs: number };

export interface LocalDictationModel {
	id: LocalDictationModelId;
	label: string;
	/** One line under the label in Settings. */
	blurb: string;
	repo: string;
	file: string;
	sizeBytes: number;
	sha256: string;
	/** null = single-language model (no language menu). */
	languages: readonly { code: LocalDictationLanguage; label: string }[] | null;
	/** The language the run's text is known to be in when the menu is absent. */
	fixedLanguage: string | null;
	defaultLanguage: LocalDictationLanguage | null;
	/** Owner choice (2026-10-27): the balanced ~480ms lookahead for both. */
	stream: LocalStreamFamily;
}

export const LOCAL_DICTATION_MODELS: readonly LocalDictationModel[] = [
	{
		id: "parakeet-unified-en-0.6b",
		label: "Parakeet Unified EN 0.6B",
		blurb: "English · streaming",
		repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
		file: "parakeet-unified-en-0.6b-Q8_0.gguf",
		sizeBytes: 731_357_568,
		sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
		languages: null,
		fixedLanguage: "en",
		defaultLanguage: null,
		// The (70,2,4) menu entry: 160ms chunks + 320ms right context.
		stream: { kind: "parakeet_buffered", leftMs: 5600, chunkMs: 160, rightMs: 320 },
	},
	{
		id: "nemotron-3.5-asr-streaming-0.6b",
		label: "Nemotron 3.5 ASR Streaming 0.6B",
		blurb: "32 languages · streaming",
		repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
		file: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
		sizeBytes: 751_094_240,
		sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
		languages: [
			{ code: "auto", label: "Auto-detect" },
			...NEMOTRON_35_LOCALES.map(([code, label]) => ({ code, label }))
				.sort((a, b) => a.label.localeCompare(b.label, "en")),
		],
		fixedLanguage: null,
		defaultLanguage: "auto",
		// R=6: 480ms lookahead.
		stream: { kind: "parakeet", attContextRight: 6 },
	},
];

/** Silero VAD v6.2 — the voice-activity model, downloaded with the first model. */
export const LOCAL_VAD_MODEL = {
	id: "silero-vad-v6.2",
	repo: "handy-computer/silero-vad-v6.2-gguf",
	file: "silero-vad-v6.2-F32.gguf",
	sizeBytes: 1_241_056,
	sha256: "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6",
} as const;

export const DEFAULT_LOCAL_DICTATION_MODEL: LocalDictationModelId = "parakeet-unified-en-0.6b";

export function localDictationModel(id: LocalDictationModelId): LocalDictationModel {
	return LOCAL_DICTATION_MODELS.find((m) => m.id === id)!;
}

export function isLocalDictationModelId(value: unknown): value is LocalDictationModelId {
	return LOCAL_DICTATION_MODELS.some((m) => m.id === value);
}

export function isLocalDictationLanguage(value: unknown): value is LocalDictationLanguage {
	return value === "auto" || NEMOTRON_35_LOCALES.some(([code]) => code === value);
}

/** The language a run uses: the saved one when the model supports it, else
 *  the model's default (switching models keeps a supported choice). */
export function resolveLocalLanguage(
	model: LocalDictationModel,
	saved: LocalDictationLanguage | undefined,
): LocalDictationLanguage | null {
	if (!model.languages) return null;
	return saved && model.languages.some((l) => l.code === saved) ? saved : model.defaultLanguage;
}

export function modelDownloadUrl(repo: string, file: string): string {
	return `https://huggingface.co/${repo}/resolve/main/${file}`;
}
