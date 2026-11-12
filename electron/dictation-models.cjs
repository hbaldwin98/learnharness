/*
 * The local dictation download catalog, for the main process.
 *
 * MIRRORS src/core/dictation-local.ts (LOCAL_DICTATION_MODELS +
 * LOCAL_VAD_MODEL) — the shell requires no TypeScript, and a renderer must
 * never name a URL the main process downloads. tests/dictation-local.test.ts
 * pins the two lists equal.
 */
const MODELS = [
	{
		id: "parakeet-unified-en-0.6b",
		repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
		file: "parakeet-unified-en-0.6b-Q8_0.gguf",
		sizeBytes: 731_357_568,
		sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
		stream: { kind: "parakeet_buffered", leftMs: 5600, chunkMs: 160, rightMs: 320 },
	},
	{
		id: "nemotron-3.5-asr-streaming-0.6b",
		repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
		file: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
		sizeBytes: 751_094_240,
		sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
		stream: { kind: "parakeet", attContextRight: 6 },
	},
];

const VAD = {
	id: "silero-vad-v6.2",
	repo: "handy-computer/silero-vad-v6.2-gguf",
	file: "silero-vad-v6.2-F32.gguf",
	sizeBytes: 1_241_056,
	sha256: "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6",
};

module.exports = { MODELS, VAD };
