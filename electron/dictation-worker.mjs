/*
 * The local dictation engine (owner, 2026-10-27): transcribe.cpp — the
 * speech library Handy runs — in an Electron utility process, so native
 * inference can never stall the main process or the window.
 *
 * Two channels:
 *   parentPort (main)   configure {model, vad, device} · unload · port
 *   MessagePort (window) start · audio · stop · cancel  →  started · text ·
 *                        final · error   — direct, the main process never
 *                        relays audio.
 *
 * Patterns ported from Handy (cjpais/Handy, MIT), noted where they land:
 * one model per worker; the final text is the stream's FULL transcript;
 * a lost or empty stream re-transcribes the run's audio in one batch pass;
 * Silero VAD smoothed with Handy's onset/pre-roll/hangover constants; idle
 * unload checked every 10s. Handy is Copyright (c) 2025 CJ Pais, MIT
 * License (https://github.com/cjpais/Handy/blob/main/LICENSE). One
 * deviation, measured on the owner's machine
 * (2026-10-27): a WARM-UP stream after load — a cold first feed took 2–3.7s.
 */
import { TranscribeModel, getAvailableBackendsAsync } from "transcribe-cpp";

const SAMPLE_RATE = 16000;
const IDLE_UNLOAD_MS = 10 * 60_000; // owner choice
const IDLE_CHECK_MS = 10_000; // Handy's idle watcher cadence
// Handy audio_toolkit/vad/mod.rs + managers/audio.rs (Silero: 32ms frames).
const SILERO_THRESHOLD = 0.3;
const VAD_PREFILL_MS = 450;
const VAD_ONSET_MS = 60;
const VAD_STREAMING_HANGOVER_MS = 1650;

const log = (...args) => console.log("[dictation-worker]", ...args);

/** Handy's frames_for_duration_ms (div_ceil). */
const framesFor = (ms, frameSamples) => Math.ceil((ms * SAMPLE_RATE) / (frameSamples * 1000));

/**
 * Handy's SmoothedVad (audio_toolkit/vad/smoothed.rs): speech must hold for
 * `onset` frames to open; opening emits the pre-roll buffer; after speech,
 * `hangover` frames keep flowing so the stream can commit its last words.
 */
class SmoothedVad {
	constructor(frameSamples) {
		this.prefill = framesFor(VAD_PREFILL_MS, frameSamples);
		this.onset = framesFor(VAD_ONSET_MS, frameSamples);
		this.hangover = framesFor(VAD_STREAMING_HANGOVER_MS, frameSamples);
		this.buffer = []; // {samples, emitted}
		this.hangoverCounter = 0;
		this.onsetCounter = 0;
		this.inSpeech = false;
	}

	/** One VAD frame in; the samples to feed out (possibly empty). */
	push(samples, isVoice) {
		this.buffer.push({ samples, emitted: false });
		while (this.buffer.length > this.prefill + 1) this.buffer.shift();
		const last = this.buffer.at(-1);
		if (!this.inSpeech && isVoice) {
			if (++this.onsetCounter < this.onset) return [];
			this.inSpeech = true;
			this.hangoverCounter = this.hangover;
			this.onsetCounter = 0;
			const out = [];
			for (const frame of this.buffer) if (!frame.emitted) { out.push(frame.samples); frame.emitted = true; }
			return out;
		}
		if (this.inSpeech && isVoice) {
			this.hangoverCounter = this.hangover;
			last.emitted = true;
			return [samples];
		}
		if (this.inSpeech) {
			if (this.hangoverCounter > 0) {
				this.hangoverCounter--;
				last.emitted = true;
				return [samples];
			}
			this.inSpeech = false;
			return [];
		}
		this.onsetCounter = 0;
		return [];
	}
}

const concat = (parts) => {
	const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
};

const toFloat = (buffer) => {
	const i16 = new Int16Array(buffer);
	const f32 = new Float32Array(i16.length);
	for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
	return f32;
};

// ── Engine state ────────────────────────────────────────────────────────

/** What main asked for: {model: {path, family, id}, vadPath, device} or null. */
let wanted = null;
/** What is loaded: {key, model, session, vad, backend, device}. */
let loaded = null;
/** Serializes load/unload — a configure storm can never interleave loads. */
let ops = Promise.resolve();
let lastActivity = Date.now();
let run = null;

const keyOf = (w) => w && JSON.stringify([w.model.path, w.vadPath, w.device]);

function status(state, extra = {}) {
	process.parentPort.postMessage({
		type: "status", state,
		model: loaded?.modelId ?? wanted?.model.id ?? null,
		backend: loaded?.backend ?? null,
		device: loaded?.deviceName ?? null,
		...extra,
	});
}

async function backendOptions(device) {
	if (device === "cpu") return { backend: "cpu" };
	if (device === "gpu") {
		// Exact selection never falls back (the library's rule, and Handy's
		// "pinned" device): no GPU is an honest error, not a silent CPU run.
		const devices = await getAvailableBackendsAsync();
		const gpu = devices.find((d) => d.deviceType === "gpu") ?? devices.find((d) => d.deviceType === "igpu");
		if (!gpu) throw new Error("No GPU found — choose Auto or CPU in Settings");
		return { device: gpu };
	}
	return { backend: "auto" };
}

function unloadNow() {
	if (!loaded) return;
	try { loaded.session.dispose(); } catch {}
	try { loaded.model.dispose(); } catch {}
	try { loaded.vadModel?.dispose(); } catch {}
	loaded = null;
}

/** Load (or keep) what `wanted` names; warm it; report. Idempotent. */
function ensureLoaded() {
	ops = ops.then(async () => {
		const key = keyOf(wanted);
		if (!wanted) { unloadNow(); status("none"); return; }
		if (loaded?.key === key) return;
		unloadNow();
		status("loading");
		const started = performance.now();
		try {
			const model = await TranscribeModel.load(wanted.model.path, await backendOptions(wanted.device));
			const session = model.createSession();
			let vadModel = null, vad = null;
			if (wanted.vadPath) {
				vadModel = await TranscribeModel.load(wanted.vadPath, { backend: "cpu" });
				vad = vadModel.createVadSession();
			}
			loaded = {
				key, model, session, vadModel, vad,
				modelId: wanted.model.id, family: wanted.model.family,
				backend: model.backend, deviceName: model.device?.description ?? model.device?.name ?? null,
			};
			// Warm-up: one second of near-silence through a real stream, so the
			// first dictated words don't pay the backend's first-compute cost.
			const warm = await session.stream({ family: loaded.family });
			await warm.feed(new Float32Array(SAMPLE_RATE).fill(1e-4));
			await warm.finalize();
			warm.reset();
			lastActivity = Date.now();
			log(`loaded ${loaded.modelId} on ${loaded.backend} (${loaded.deviceName}) in ${Math.round(performance.now() - started)}ms`);
			status("ready");
		} catch (e) {
			unloadNow();
			log("load failed:", e?.message ?? e);
			status("error", { error: e?.message ?? String(e) });
		}
	});
	return ops;
}

setInterval(() => {
	if (!loaded || run || Date.now() - lastActivity < IDLE_UNLOAD_MS) return;
	ops = ops.then(() => {
		if (!loaded || run) return;
		log("idle — unloading");
		unloadNow();
		status("idle");
	});
}, IDLE_CHECK_MS).unref();

// ── Runs (window port) ──────────────────────────────────────────────────

let port = null;
const post = (msg) => port?.postMessage(msg);

async function startRun({ runId, language, vad }) {
	if (run) cancelRun(run.id);
	if (!wanted) { post({ type: "error", runId, code: "no-model", message: "No local model selected" }); return; }
	const r = {
		id: runId, cancelled: false, chain: Promise.resolve(), stream: null,
		language: language && language !== "auto" ? language : null,
		smoother: null, vadPending: [], vadPendingLength: 0, recorded: [], committed: "", tentative: "",
	};
	run = r;
	lastActivity = Date.now();
	r.chain = r.chain.then(async () => {
		await ensureLoaded();
		if (r.cancelled) return;
		if (!loaded) throw Object.assign(new Error("The local model is not loaded"), { code: "not-loaded" });
		if (vad && loaded.vad) r.smoother = new SmoothedVad(loaded.vadModel.vadInfo.frameSamples);
		await loaded.vad?.streamReset();
		r.stream = await loaded.session.stream({
			family: loaded.family,
			...(r.language ? { language: r.language } : {}),
		});
		post({ type: "started", runId });
	}).catch((e) => fail(r, e));
}

function fail(r, e) {
	if (r.cancelled) return;
	post({ type: "error", runId: r.id, code: e?.code ?? "engine", message: e?.message ?? String(e) });
	r.cancelled = true;
	try { r.stream?.reset(); } catch {}
	if (run === r) run = null;
}

/** VAD gating: score the chunk, smooth per Silero frame, return what to feed. */
async function gate(r, pcm) {
	if (!r.smoother) return pcm;
	const { probs } = await loaded.vad.streamFeed(pcm);
	r.vadPending.push(pcm);
	r.vadPendingLength += pcm.length;
	const frameSamples = loaded.vadModel.vadInfo.frameSamples;
	const pending = concat(r.vadPending);
	const out = [];
	for (let i = 0; i < probs.length; i++) {
		const frame = pending.subarray(i * frameSamples, (i + 1) * frameSamples);
		out.push(...r.smoother.push(frame, probs[i] >= SILERO_THRESHOLD));
	}
	const rest = pending.subarray(probs.length * frameSamples);
	r.vadPending = rest.length ? [rest.slice()] : [];
	r.vadPendingLength = rest.length;
	return out.length ? concat(out) : null;
}

function audio({ runId, pcm }) {
	const r = run;
	if (!r || r.id !== runId || r.cancelled) return;
	lastActivity = Date.now();
	const samples = toFloat(pcm);
	r.chain = r.chain.then(async () => {
		if (r.cancelled || !r.stream) return;
		const feed = await gate(r, samples);
		if (!feed || r.cancelled) return;
		r.recorded.push(feed);
		await r.stream.feed(feed);
		if (r.cancelled || r.stream.state !== "active") return;
		const { committed, tentative } = r.stream.text;
		if (committed !== r.committed || tentative !== r.tentative) {
			r.committed = committed;
			r.tentative = tentative;
			post({ type: "text", runId, committed, tentative });
		}
	}).catch((e) => {
		// Handy: a lost feed is logged, never fatal — finalize falls back.
		log("feed failed:", e?.message ?? e);
	});
}

function stopRun({ runId }) {
	const r = run;
	if (!r || r.id !== runId || r.cancelled) return;
	lastActivity = Date.now();
	r.chain = r.chain.then(async () => {
		if (r.cancelled) return;
		let text = "", language = "";
		if (r.stream) {
			try {
				await r.stream.finalize();
				text = r.stream.text.full;
				if (!r.language) language = r.stream.snapshot.language;
			} catch (e) {
				log("finalize failed:", e?.message ?? e);
			}
			try { r.stream.reset(); } catch {}
		}
		// Handy live.rs: a stream can miss what a run over the whole recording
		// finds — empty or failed text retries the run's audio in batch.
		const recorded = concat(r.recorded);
		if (!text.trim() && loaded && recorded.length > SAMPLE_RATE / 4 && !r.cancelled) {
			log("stream produced no text; retrying in batch");
			const result = await loaded.session.run(recorded, r.language ? { language: r.language } : {});
			text = result.text;
			language ||= result.language;
		}
		if (r.cancelled) return;
		post({ type: "final", runId, text: text.trim(), language: language || null });
		if (run === r) run = null;
		lastActivity = Date.now();
	}).catch((e) => fail(r, e));
}

function cancelRun(runId) {
	const r = run;
	if (!r || r.id !== runId) return;
	r.cancelled = true;
	run = null;
	// Deferred behind any in-flight feed by the library.
	try { r.stream?.reset(); } catch {}
	lastActivity = Date.now();
}

function attachPort(next) {
	port?.close();
	port = next;
	port.on("message", ({ data }) => {
		switch (data?.type) {
			case "start": void startRun(data); break;
			case "audio": audio(data); break;
			case "stop": stopRun(data); break;
			case "cancel": cancelRun(data.runId); break;
		}
	});
	port.start();
}

process.parentPort.on("message", ({ data, ports }) => {
	switch (data?.type) {
		case "configure":
			wanted = data.config;
			if (run && keyOf(wanted) !== loaded?.key) cancelRun(run.id);
			void ensureLoaded();
			break;
		case "unload":
			wanted = null;
			if (run) cancelRun(run.id);
			void ensureLoaded().then(() => process.parentPort.postMessage({ type: "unloaded", token: data.token }));
			break;
		case "port":
			if (ports?.[0]) attachPort(ports[0]);
			break;
	}
});

status("none");
