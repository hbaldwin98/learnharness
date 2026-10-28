/*
 * Local dictation — the main-process half (owner, 2026-10-27).
 *
 *   - Supervises the utility process that runs transcribe.cpp
 *     (electron/dictation-worker.mjs): restarts it when it dies, and — as
 *     Handy's engine supervisor does — a worker lost while loading on the
 *     GPU marks the GPU unusable for the session and reloads on the CPU.
 *   - Hands each window a direct MessagePort to the worker: audio flows
 *     window → worker, never through this process.
 *   - Downloads, verifies, and deletes the model files under
 *     userData/models (Handy's managers/model/download.rs flow: a
 *     `.partial` file resumed with Range, size then sha256, then rename).
 *
 * The window is the settings' reader: it sends {model, device, vad} via
 * "configure" whenever the dictation section resolves or changes.
 */
const { MessageChannelMain, utilityProcess } = require("electron");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MODELS, VAD } = require("./dictation-models.cjs");

// Handy's download constants (managers/model/download.rs).
const CONNECT_TIMEOUT_MS = 15_000;
const STALL_TIMEOUT_MS = 60_000;
const PROGRESS_THROTTLE_MS = 100;

const modelUrl = (entry) => `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}`;

async function sha256File(file) {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk);
	return hash.digest("hex");
}

/**
 * Download `entry` to `dir/entry.file`, resuming `<file>.partial`. Resolves
 * "done" or "cancelled" (the partial is kept for a later resume); rejects
 * with a user-facing message. Exported for tests (fetch is injectable).
 */
async function downloadFile({ entry, dir, signal, onProgress, fetchImpl = fetch }) {
	const dest = path.join(dir, entry.file);
	const partial = `${dest}.partial`;
	fs.mkdirSync(dir, { recursive: true });
	let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
	if (offset > entry.sizeBytes) { fs.rmSync(partial, { force: true }); offset = 0; }

	if (offset < entry.sizeBytes) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		let timer = setTimeout(abort, CONNECT_TIMEOUT_MS);
		const arm = () => { clearTimeout(timer); timer = setTimeout(abort, STALL_TIMEOUT_MS); };
		try {
			const res = await fetchImpl(modelUrl(entry), {
				headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
				signal: controller.signal,
			});
			if (res.status === 416) { fs.rmSync(partial, { force: true }); throw new Error("Download could not resume — try again"); }
			if (offset > 0 && res.status === 200) offset = 0; // server ignored Range: restart
			else if (res.status === 206) {
				const start = Number(/bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1]);
				if (start !== offset) { fs.rmSync(partial, { force: true }); throw new Error("Download resumed at the wrong place — try again"); }
			} else if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
			const out = fs.createWriteStream(partial, { flags: offset > 0 ? "a" : "w" });
			let received = offset;
			let lastEmit = 0;
			try {
				arm();
				for await (const chunk of res.body) {
					arm();
					received += chunk.length;
					if (received > entry.sizeBytes) throw new Error("Download is larger than expected");
					if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
					const now = Date.now();
					if (now - lastEmit >= PROGRESS_THROTTLE_MS) { lastEmit = now; onProgress({ received, total: entry.sizeBytes }); }
				}
			} finally {
				await new Promise((r) => out.end(r));
			}
			onProgress({ received, total: entry.sizeBytes });
		} catch (e) {
			if (signal.aborted) return "cancelled";
			if (controller.signal.aborted) throw new Error("Download stalled — try again (it will resume)");
			if (e instanceof Error && /larger than expected/.test(e.message)) fs.rmSync(partial, { force: true });
			throw e;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	}

	onProgress({ received: entry.sizeBytes, total: entry.sizeBytes, verifying: true });
	if (fs.statSync(partial).size !== entry.sizeBytes) { fs.rmSync(partial, { force: true }); throw new Error("Downloaded file has the wrong size — try again"); }
	if (await sha256File(partial) !== entry.sha256) { fs.rmSync(partial, { force: true }); throw new Error("Downloaded file failed verification — try again"); }
	fs.renameSync(partial, dest);
	return "done";
}

/**
 * @param {{ modelsDir: string, workerEnv: Record<string,string>, log: (s: string) => void, broadcast: (snapshot: object) => void }} opts
 */
function createLocalDictation({ modelsDir, workerEnv, log, broadcast }) {
	let worker = null;
	let workerReady = false;
	let engine = { state: "none", model: null, backend: null, device: null, error: null };
	let gpuLost = false;
	let config = null; // {model, device, vad} from the window
	const downloads = new Map(); // id → {controller, received, total, verifying}
	const errors = new Map(); // id → message
	let unloadToken = 0;
	const unloadWaiters = new Map();

	const fileOf = (entry) => path.join(modelsDir, entry.file);
	const present = (entry) => fs.existsSync(fileOf(entry));

	function modelState(entry) {
		const d = downloads.get(entry.id);
		if (d) return { state: d.verifying ? "verifying" : "downloading", received: d.received, total: entry.sizeBytes };
		if (present(entry)) return { state: "ready", received: entry.sizeBytes, total: entry.sizeBytes };
		const partial = `${fileOf(entry)}.partial`;
		const received = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
		return { state: received > 0 ? "partial" : "absent", received, total: entry.sizeBytes, error: errors.get(entry.id) ?? null };
	}

	function snapshot() {
		const models = {};
		for (const entry of MODELS) models[entry.id] = modelState(entry);
		return { available: true, engine: { ...engine, gpuFallback: gpuLost }, models, vad: modelState(VAD) };
	}
	const changed = () => broadcast(snapshot());

	function spawnWorker() {
		workerReady = false;
		const child = utilityProcess.fork(path.join(__dirname, "dictation-worker.mjs"), [], {
			serviceName: "LearnHarness Dictation",
			stdio: "pipe",
			env: { ...process.env, ...workerEnv },
		});
		child.stdout?.on("data", (d) => log(String(d).trimEnd()));
		child.stderr?.on("data", (d) => log(String(d).trimEnd()));
		child.on("spawn", () => { workerReady = true; sendConfig(); });
		child.on("message", (msg) => {
			if (msg?.type === "status") {
				engine = { state: msg.state, model: msg.model, backend: msg.backend, device: msg.device, error: msg.error ?? null };
				changed();
			} else if (msg?.type === "unloaded") {
				unloadWaiters.get(msg.token)?.();
				unloadWaiters.delete(msg.token);
			}
		});
		child.on("exit", (code) => {
			if (worker !== child) return;
			log(`[dictation] worker exited (${code})`);
			// Handy supervisor.rs: a worker LOST while loading on a GPU-capable
			// device marks the GPU unusable for the session; the reload runs
			// on the CPU. An explicit GPU choice never silently falls back.
			if (engine.state === "loading" && config?.device === "auto" && !gpuLost) {
				gpuLost = true;
				log("[dictation] worker lost while loading — falling back to CPU for this session");
			}
			engine = { state: "error", model: engine.model, backend: null, device: null, error: "The dictation engine stopped — restarting" };
			changed();
			for (const resolve of unloadWaiters.values()) resolve();
			unloadWaiters.clear();
			worker = null;
			setTimeout(() => { if (!worker && !quitting) worker = spawnWorker(); }, 500);
		});
		return child;
	}

	function workerConfig() {
		const entry = config && MODELS.find((m) => m.id === config.model);
		if (!entry || !present(entry)) return null;
		return {
			model: { id: entry.id, path: fileOf(entry), family: entry.stream },
			vadPath: config.vad && present(VAD) ? fileOf(VAD) : null,
			device: gpuLost && config.device === "auto" ? "cpu" : config.device,
		};
	}

	function sendConfig() {
		if (worker && workerReady) worker.postMessage({ type: "configure", config: workerConfig() });
	}

	/** Free the model before its file is touched (Handy: Unloading::wait). */
	function unloadWorker() {
		if (!worker || !workerReady) return Promise.resolve();
		const token = ++unloadToken;
		return new Promise((resolve) => {
			unloadWaiters.set(token, resolve);
			worker.postMessage({ type: "unload", token });
		});
	}

	async function download(id) {
		const entry = MODELS.find((m) => m.id === id);
		if (!entry) throw new Error("Unknown model");
		if (downloads.has(id)) return;
		const controller = new AbortController();
		const state = { controller, received: 0, verifying: false };
		downloads.set(id, state);
		errors.delete(id);
		changed();
		try {
			// The VAD model rides along with the first model (1.2 MB).
			for (const item of present(VAD) ? [entry] : [VAD, entry]) {
				const result = await downloadFile({
					entry: item, dir: modelsDir, signal: controller.signal,
					onProgress: (p) => {
						if (item !== entry) return;
						state.received = p.received;
						state.verifying = Boolean(p.verifying);
						changed();
					},
				});
				if (result === "cancelled") return;
			}
			log(`[dictation] downloaded ${entry.file}`);
		} catch (e) {
			errors.set(id, e instanceof Error ? e.message : String(e));
			log(`[dictation] download ${id} failed: ${errors.get(id)}`);
		} finally {
			downloads.delete(id);
			changed();
			sendConfig();
		}
	}

	async function remove(id) {
		const entry = MODELS.find((m) => m.id === id);
		if (!entry) throw new Error("Unknown model");
		downloads.get(id)?.controller.abort();
		if (engine.model === id) await unloadWorker();
		fs.rmSync(fileOf(entry), { force: true });
		fs.rmSync(`${fileOf(entry)}.partial`, { force: true });
		errors.delete(id);
		changed();
		sendConfig();
	}

	let quitting = false;
	worker = spawnWorker();

	return {
		snapshot,
		configure(next) {
			const valid = next && MODELS.some((m) => m.id === next.model) && ["auto", "gpu", "cpu"].includes(next.device);
			config = valid ? { model: next.model, device: next.device, vad: next.vad !== false } : null;
			sendConfig();
			return snapshot();
		},
		download: (id) => { void download(id); return snapshot(); },
		cancel(id) { downloads.get(id)?.controller.abort(); return snapshot(); },
		remove: async (id) => { await remove(id); return snapshot(); },
		/** Give `webContents` a fresh direct port to the worker. */
		connect(webContents) {
			if (!worker || !workerReady) return false;
			const { port1, port2 } = new MessageChannelMain();
			worker.postMessage({ type: "port" }, [port1]);
			webContents.postMessage("lh:dictation:port", null, [port2]);
			return true;
		},
		dispose() {
			quitting = true;
			for (const d of downloads.values()) d.controller.abort();
			worker?.kill();
			worker = null;
		},
	};
}

module.exports = { createLocalDictation, downloadFile };
