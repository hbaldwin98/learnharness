import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	LOCAL_DICTATION_MODELS, LOCAL_VAD_MODEL, cleanDictation, localDictationModel, normalizeDictation,
	removeFillerWords, resolveDictationSettings, resolveLocalLanguage, sanitizeUserSettings,
} from "../src/core/index.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { DictationSpans, type DictationTarget } from "../components/dictation-spans.ts";

const require = createRequire(import.meta.url);
const mirror = require("../electron/dictation-models.cjs") as {
	MODELS: { id: string; repo: string; file: string; sizeBytes: number; sha256: string; stream: unknown }[];
	VAD: typeof LOCAL_VAD_MODEL;
};
const { downloadFile } = require("../electron/dictation.cjs") as {
	downloadFile: (opts: {
		entry: { id: string; repo: string; file: string; sizeBytes: number; sha256: string };
		dir: string; signal: AbortSignal; onProgress: (p: unknown) => void; fetchImpl: typeof fetch;
	}) => Promise<"done" | "cancelled">;
};

/** Handy's own filter tests (audio_toolkit/text.rs), run through our port:
 *  removal with the language KNOWN, then the final normalization. */
const handy = (text: string, language: string | null) => normalizeDictation(removeFillerWords(text, language));

describe("filler removal — Handy's cases", () => {
	it("removes fillers, case-insensitively, with their punctuation", () => {
		assert.equal(handy("So uhm I was thinking uh about this", "en"), "So I was thinking about this");
		assert.equal(handy("UHM this is UH a test", "en"), "This is a test");
		assert.equal(handy("Well, uhm, I think, uh. that's right", "en"), "Well, I think, that's right");
		assert.equal(handy("  Uhm, so I was, uh, thinking about this  ", "en"), "So I was, thinking about this");
	});
	it("hands a sentence-opening filler's capital to the next word", () => {
		assert.equal(handy("Um, so I think we should ship it.", "en"), "So I think we should ship it.");
		assert.equal(handy("That works. Um, let me check.", "en"), "That works. Let me check.");
		assert.equal(handy("He said, Um, not today.", "en"), "He said, not today.");
	});
	it("gates real-word fillers on the known language; unknown fails closed", () => {
		assert.equal(handy("um I think um this is good", "en"), "I think this is good");
		assert.equal(handy("um gato bonito", "pt"), "um gato bonito");
		assert.equal(handy("um gato bonito", "pt-BR"), "um gato bonito");
		assert.equal(handy("ha sido un buen día", "es"), "ha sido un buen día");
		assert.equal(handy("uh I think uhm this works", "xx"), "I think this works");
		assert.equal(handy("um I think this works", null), "um I think this works");
		assert.equal(handy("uhh bueno hmm creo que um ha llegado", null), "bueno creo que um ha llegado");
		assert.equal(handy("Er griff ähm alles an", "de"), "Er griff alles an", "German 'er' is a word, never a filler");
	});
	it("normalizes stutters and whitespace", () => {
		assert.equal(normalizeDictation("w wh wh wh wh wh wh wh wh wh why"), "w wh why");
		assert.equal(normalizeDictation("I I I I think so so so so"), "I think so");
		assert.equal(normalizeDictation("No NO no NO no"), "No");
		assert.equal(normalizeDictation("no no is fine"), "no no is fine");
		assert.equal(normalizeDictation("  Hello    world  "), "Hello world");
	});
});

describe("cleanDictation (live)", () => {
	const live = { removeFillers: true, language: "en", final: false };
	it("holds back a possibly-unfinished token for mid-word commits", () => {
		assert.equal(cleanDictation("Um, so I thi", live), "So I ");
		assert.equal(cleanDictation("Americ", live), "");
		assert.equal(cleanDictation("And so, my fellow Americ", live), "And so, my fellow ");
	});
	it("shows complete text whole, and finals normalized", () => {
		assert.equal(cleanDictation("Um, so I think", { ...live, complete: true }), "So I think");
		assert.equal(cleanDictation("Um, so I think", { ...live, final: true }), "So I think");
		assert.equal(cleanDictation("so so so  fine ", { removeFillers: false, language: null, final: true }), "so fine");
		assert.equal(cleanDictation("Um, so I thi", { removeFillers: false, language: "en", final: false }), "Um, so I thi");
	});
});

function field(initial = ""): DictationTarget & { value: string } {
	const f = { value: initial, read: () => f.value, write: (v: string) => { f.value = v; } };
	return f;
}

describe("DictationSpans", () => {
	it("separates from existing text and rewrites in place", () => {
		const box = field("Note:  ");
		const spans = new DictationSpans(() => box);
		spans.set("");
		assert.equal(box.read(), "Note:  ", "nothing said, nothing touched");
		spans.set("And so");
		assert.equal(box.read(), "Note: And so");
		spans.set("And so, my fellow");
		box.value += " (typed)";
		spans.set("And so, my fellow Americans.");
		assert.equal(box.read(), "Note: And so, my fellow Americans. (typed)");
		spans.remove();
		assert.equal(box.read(), "Note: (typed)");
	});
	it("a retarget opens a new segment with only the new text", () => {
		const composer = field("draft");
		const answer = field("");
		let current = composer;
		const spans = new DictationSpans(() => current);
		spans.set("first part");
		current = answer;
		spans.set("first part second part");
		assert.equal(composer.read(), "draft first part");
		assert.equal(answer.read(), "second part");
		spans.remove();
		assert.equal(composer.read(), "draft");
		assert.equal(answer.read(), "");
	});
	it("text edited over is kept; only new words are added", () => {
		const box = field("");
		const spans = new DictationSpans(() => box);
		spans.set("one two");
		box.value = "one TWO";
		spans.set("one two three");
		assert.equal(box.read(), "one TWO three");
	});
});

describe("local dictation catalog", () => {
	it("the main-process mirror equals the core list", () => {
		assert.deepEqual(mirror.MODELS, LOCAL_DICTATION_MODELS.map(({ id, repo, file, sizeBytes, sha256, stream }) => ({ id, repo, file, sizeBytes, sha256, stream })));
		assert.deepEqual(mirror.VAD, LOCAL_VAD_MODEL);
	});
	it("languages: English-only Parakeet has none; Nemotron keeps a supported choice", () => {
		const parakeet = localDictationModel("parakeet-unified-en-0.6b");
		const nemotron = localDictationModel("nemotron-3.5-asr-streaming-0.6b");
		assert.equal(resolveLocalLanguage(parakeet, "de-DE"), null);
		assert.equal(resolveLocalLanguage(nemotron, "de-DE"), "de-DE");
		assert.equal(resolveLocalLanguage(nemotron, undefined), "auto");
		assert.equal(nemotron.languages!.length, 33);
	});
});

describe("dictation settings", () => {
	it("factory: Local + Parakeet, fillers removed, no trailing space, VAD on, auto device", () => {
		assert.deepEqual(resolveDictationSettings(undefined), {
			engine: "local", language: "en", removeFillerWords: true, appendTrailingSpace: false,
			local: { model: "parakeet-unified-en-0.6b", language: "auto", device: "auto", vad: true },
		});
	});
	it("an old language-only record keeps its Deepgram language", () => {
		const record = sanitizeUserSettings({ version: 1, dictation: { language: "pl" } });
		assert.equal(resolveDictationSettings(record?.dictation).language, "pl");
	});
	it("the sanitizer drops bad fields one by one", () => {
		const record = sanitizeUserSettings({ version: 1, dictation: {
			engine: "whisper", language: "pl", removeFillerWords: "yes", appendTrailingSpace: true,
			local: { model: "nope", language: "de-DE", device: "gpu", vad: false },
		} });
		assert.deepEqual(record?.dictation, { language: "pl", appendTrailingSpace: true, local: { language: "de-DE", device: "gpu", vad: false } });
	});
	it("the PUT parser is strict", () => {
		assert.equal(parseDictationSettingsBody({ engine: "local", local: { model: "nemotron-3.5-asr-streaming-0.6b", language: "auto" } }).ok, true);
		assert.equal(parseDictationSettingsBody({ engine: "whisper" }).ok, false);
		assert.equal(parseDictationSettingsBody({ local: { device: "tpu" } }).ok, false);
		assert.equal(parseDictationSettingsBody({ local: { language: "auto-detect" } }).ok, false);
		assert.equal(parseDictationSettingsBody({ appendTrailingSpace: 1 }).ok, false);
	});
});

describe("model download (Handy's partial/resume/verify flow)", () => {
	const bytes = Buffer.from("transcribe.cpp model bytes, sixty-four of them, give or take!!!!");
	const entry = {
		id: "m", repo: "r/m", file: "m.gguf", sizeBytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-dl-"));
	const serve = (log: (string | null)[]): typeof fetch => (async (_url: unknown, init?: RequestInit) => {
		const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
		log.push(range);
		const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
		return new Response(bytes.subarray(from), range
			? { status: 206, headers: { "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` } }
			: { status: 200 });
	}) as typeof fetch;

	it("downloads, verifies, and renames", async () => {
		const dir = tmp();
		const log: (string | null)[] = [];
		const result = await downloadFile({ entry, dir, signal: new AbortController().signal, onProgress: () => {}, fetchImpl: serve(log) });
		assert.equal(result, "done");
		assert.deepEqual(fs.readFileSync(path.join(dir, entry.file)), bytes);
		assert.equal(fs.existsSync(path.join(dir, `${entry.file}.partial`)), false);
		assert.deepEqual(log, [null]);
	});
	it("resumes a partial with Range", async () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, `${entry.file}.partial`), bytes.subarray(0, 20));
		const log: (string | null)[] = [];
		assert.equal(await downloadFile({ entry, dir, signal: new AbortController().signal, onProgress: () => {}, fetchImpl: serve(log) }), "done");
		assert.deepEqual(log, ["bytes=20-"]);
		assert.deepEqual(fs.readFileSync(path.join(dir, entry.file)), bytes);
	});
	it("a checksum mismatch deletes the partial and fails", async () => {
		const dir = tmp();
		await assert.rejects(
			downloadFile({ entry: { ...entry, sha256: "0".repeat(64) }, dir, signal: new AbortController().signal, onProgress: () => {}, fetchImpl: serve([]) }),
			/failed verification/,
		);
		assert.equal(fs.readdirSync(dir).length, 0);
	});
	it("a cancel keeps the partial for a later resume", async () => {
		const dir = tmp();
		const controller = new AbortController();
		const stalled = (async (_url: unknown, init?: RequestInit) => {
			const body = new ReadableStream({
				start(c) {
					c.enqueue(bytes.subarray(0, 10));
					init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
					controller.abort();
				},
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch;
		assert.equal(await downloadFile({ entry, dir, signal: controller.signal, onProgress: () => {}, fetchImpl: stalled }), "cancelled");
		assert.equal(fs.existsSync(path.join(dir, `${entry.file}.partial`)), true);
		assert.equal(fs.existsSync(path.join(dir, entry.file)), false);
	});
});
