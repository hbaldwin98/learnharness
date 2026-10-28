import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import { isDictationActive, useDictationActive } from "../components/dictation-state.ts";
import type { UserSettings } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	get language() { return new URL(this.url).searchParams.get("language"); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end(code = 1000) { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code })); }
	final(text: string, isFinal = true) {
		this.dispatchEvent(Object.assign(new Event("message"), {
			data: JSON.stringify({ type: "Results", is_final: isFinal, channel: { alternatives: [{ transcript: text }] } }),
		}));
	}
	interim(text: string) { this.final(text, false); }
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet { port = {}; connect() {} disconnect() {} }

const globals = globalThis as Record<string, unknown>;
/** These flows pin the Deepgram engine (Local is the factory default). */
const deepgram = (language: string, extra: Record<string, unknown> = {}) =>
	({ engine: "deepgram", language, ...extra }) as UserSettings["dictation"];
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(language: "pl" | "en" = "pl", delayedRead?: Promise<Response>, extra: Record<string, unknown> = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: deepgram(language, extra) } as UserSettings,
		nextRead: delayedRead,
		nextWrite: undefined as Promise<Response> | undefined,
		nextMic: undefined as Promise<{ getTracks: () => { stop: () => void }[] }> | undefined,
		readFails: false,
		reads: 0,
		active: false,
		captures: 0,
		stops: 0,
		text: "",
	};
	Socket.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			if (state.nextMic) return state.nextMic;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") return Response.json({ token: "test-token" });
			if (url === "/api/settings") {
				state.reads++;
				if (state.nextRead) { const response = state.nextRead; state.nextRead = undefined; return response; }
				return state.readFails ? Response.json({}, { status: 500 }) : Response.json({ settings: state.record });
			}
			assert.equal(url, "/api/settings/dictation");
			assert.equal(init?.method, "PUT");
			if (state.nextWrite) { const response = state.nextWrite; state.nextWrite = undefined; return response; }
			state.record = { ...state.record, dictation: JSON.parse(init.body as string) };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	let setting!: ReturnType<typeof useDictationLanguage>;
	function Harness() {
		latest = useDictation({ target: { read: () => state.text, write: (v) => { state.text = v; } } });
		setting = useDictationLanguage();
		state.active = useDictationActive();
		return null;
	}
	let root = createRoot(document.getElementById("root")!);
	let firstMount = true;
	const mount = async () => {
		await act(async () => { root.render(<Harness />); });
		// Each fixture is a new server record. Explicitly invalidate a prior
		// fixture's window-lifetime cache, but do not refetch on remounts.
		if (firstMount && setting.language !== undefined) {
			await act(async () => { notifySettingsSaved("dictation"); });
		}
		firstMount = false;
	};
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		get setting() { return setting; },
		mount,
		unmount: () => dispose!(),
		remount: async () => {
			await dispose!();
			root = createRoot(document.getElementById("root")!);
			await mount();
		},
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("waits for the saved language; reconnect preserves it and finals land live exactly once", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "connecting");
	assert.equal(f.state.active, true, "the settings row locks while connecting");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0, "must not open a default-English socket before settings arrive");
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	const first = Socket.all[0]!;
	assert.equal(first.language, "pl");
	await act(async () => { first.open(); first.final("Cześć"); });
	assert.equal(f.state.text, "Cześć", "finals land in the field as they stream");
	// A preference refresh during capture affects the next run only.
	f.state.record.dictation = deepgram("multi");
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { first.end(1006); });
	const second = Socket.all[1]!;
	assert.equal(second.language, "pl");
	assert.deepEqual(second.protocols, ["bearer", "test-token"]);
	await act(async () => { second.open(); second.final("świecie"); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.state.active, true, "the settings row remains locked while stopping");
	assert.equal(second.sent.at(-1), JSON.stringify({ type: "CloseStream" }));
	await act(async () => { second.end(); });
	assert.equal(f.state.text, "Cześć świecie");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.active, false);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[2]!.language, "multi");
});

test("a failed save keeps the previous language, including a shortcut pressed while saving", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let saved!: Promise<boolean>;
	await act(async () => { saved = f.setting.save("multi"); });
	assert.equal(f.setting.saving, true);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	await act(async () => { write.resolve(Response.json({}, { status: 500 })); await saved; });
	assert.equal(await saved, false);
	assert.equal(f.setting.language, "pl");
	assert.match(f.setting.error!, /Could not save/);
	assert.equal(Socket.all[0]!.language, "pl");
});

test("confirmed choices stay cached across navigation; failed explicit refreshes block capture", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { assert.equal(await f.setting.save("multi"), true); });
	const reads = f.state.reads;
	f.state.readFails = true;
	await f.remount();
	assert.equal(f.setting.language, "multi");
	assert.equal(f.state.reads, reads, "navigation must not reread a confirmed preference");
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.match(f.dictation.error!, /Could not load/);
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	f.state.readFails = false;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a shortcut waits for a language save made by the separate settings control", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let saved!: Promise<boolean>;
	await act(async () => { saved = f.setting.save("multi"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	f.state.record.dictation = deepgram("multi");
	await act(async () => { write.resolve(Response.json({ settings: f.state.record })); await saved; });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a saved-language refresh gates capture even when an older choice is cached", async () => {
	const f = await fixture();
	await f.mount();
	const read = deferred<Response>();
	f.state.nextRead = read.promise;
	f.state.record.dictation = deepgram("multi");
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a stale settings refresh cannot overwrite a newer confirmed choice", async () => {
	const f = await fixture();
	await f.mount();
	const read = deferred<Response>();
	f.state.nextRead = read.promise;
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { await f.setting.save("multi"); });
	await act(async () => { read.resolve(Response.json({ settings: { version: 1, dictation: deepgram("pl") } })); });
	assert.equal(f.setting.language, "multi");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("cancel while settings load does not open a microphone or socket later", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.cancel(); });
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
});

test("reopening settings during a save shares its busy state and rejects a competing selection", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let first!: Promise<boolean>;
	await act(async () => { first = f.setting.save("multi"); });
	await f.remount();
	assert.equal(f.setting.saving, true);
	assert.equal(await f.setting.save("en"), false, "a different selection cannot inherit another write's success");
	f.state.record.dictation = deepgram("multi");
	await act(async () => { write.resolve(Response.json({ settings: f.state.record })); await first; });
	assert.equal(f.setting.saving, false);
	assert.equal(f.setting.language, "multi");
});

test("a confirmed save applies to capture even when subsequent settings GET requests would fail", async () => {
	const f = await fixture();
	await f.mount();
	f.state.readFails = true;
	await act(async () => { assert.equal(await f.setting.save("multi"), true); });
	assert.equal(f.state.record.dictation?.language, "multi");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("unmount during a pending language read prevents orphaned capture", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await f.unmount();
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});

test("unmount during recording stops resources and nothing writes after it", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("already live"); });
	await f.unmount();
	assert.equal(f.state.stops, 1);
	assert.equal(socket.readyState, 3);
	assert.equal(isDictationActive(), false);
	await act(async () => { socket.final("late event"); socket.end(1006); });
	assert.equal(Socket.all.length, 1);
	assert.equal(f.state.text, "already live");
});

test("Esc removes exactly this run's text and keeps what the learner typed", async () => {
	const f = await fixture();
	await f.mount();
	f.state.text = "My idea:";
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("the graph"); });
	assert.equal(f.state.text, "My idea: the graph");
	f.state.text = "Typed first. " + f.state.text;
	await act(async () => { socket.final("is a tree"); });
	assert.equal(f.state.text, "Typed first. My idea: the graph is a tree");
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.text, "Typed first. My idea:");
	assert.equal(f.dictation.phase, "idle");
});

test("interims are the strip's guess, never the field's text", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("One"); socket.interim("two thr"); });
	assert.equal(f.state.text, "One");
	assert.equal(f.dictation.tentativeRef.current, "two thr");
	await act(async () => { socket.final("two three"); });
	assert.equal(f.state.text, "One two three");
	assert.equal(f.dictation.tentativeRef.current, "");
	const url = new URL(socket.url);
	assert.equal(url.searchParams.get("interim_results"), "true");
	assert.equal(url.searchParams.get("filler_words"), null, "removal on: Deepgram's default omits fillers");
});

test("filler removal cleans live finals, and the trailing space lands at the end", async () => {
	const f = await fixture("en", undefined, { appendTrailingSpace: true });
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("Um, so I think"); });
	assert.equal(f.state.text, "So I think", "a Deepgram final ends on a word boundary; the filler's capital moves on");
	await act(async () => { socket.final("uh, it works"); });
	await act(async () => { f.dictation.stop(); });
	await act(async () => { socket.end(); });
	assert.equal(f.state.text, "So I think it works ");
});

test("filler removal off keeps every word and asks Deepgram for fillers", async () => {
	const f = await fixture("en", undefined, { removeFillerWords: false });
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	assert.equal(new URL(socket.url).searchParams.get("filler_words"), "true");
	await act(async () => { socket.open(); socket.final("Um, so I think"); });
	assert.equal(f.state.text, "Um, so I think");
});

test("microphone permission resolving after unmount immediately stops the late stream", async () => {
	const f = await fixture();
	await f.mount();
	const mic = deferred<{ getTracks: () => { stop: () => void }[] }>();
	f.state.nextMic = mic.promise;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 1);
	await f.unmount();
	await act(async () => { mic.resolve({ getTracks: () => [{ stop() { f.state.stops++; } }] }); });
	assert.equal(f.state.stops, 1);
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});

/** Open MessagePorts keep Node's event loop alive — every fake channel closes. */
const fakePorts: MessagePort[] = [];
afterEach(() => { for (const port of fakePorts.splice(0)) port.close(); });

/** A stand-in for window.lh.dictation + the worker end of the run's port. */
function fakeLocal(models: Record<string, string> = { "parakeet-unified-en-0.6b": "ready" }) {
	const worker = { port: null as MessagePort | null, received: [] as { type: string; runId: number; [k: string]: unknown }[] };
	const snapshot = {
		available: true,
		engine: { state: "ready", model: "parakeet-unified-en-0.6b", backend: "Vulkan0", device: "GPU", error: null, gpuFallback: false },
		models: Object.fromEntries(Object.entries(models).map(([id, state]) => [id, { state, received: 1, total: 1 }])),
		vad: { state: "ready", received: 1, total: 1 },
	};
	const win = globalThis.window as unknown as EventTarget & { lh?: unknown; Event: typeof Event };
	win.lh = { dictation: {
		onChange: () => () => {},
		control: async (command: { op: string }) => {
			if (command.op !== "connect") return snapshot;
			const { port1, port2 } = new MessageChannel();
			fakePorts.push(port1, port2);
			worker.port = port1;
			port1.onmessage = ({ data }) => { worker.received.push(data); };
			// linkedom dispatches only its own Event class (it writes eventPhase).
			const DomEvent = win.Event;
			win.dispatchEvent(Object.assign(new DomEvent("message"), { source: win, data: { type: "lh:dictation:port" }, ports: [port2] }));
			return true;
		},
	} };
	return {
		worker,
		send: (msg: Record<string, unknown>) => worker.port!.postMessage(msg),
		/** Let both ends of the MessageChannel deliver. */
		flush: () => act(async () => { await new Promise((r) => setTimeout(r, 20)); }),
	};
}

test("local engine: committed text lands live (unfinished word held), the guess shows, the final full text wins", async () => {
	const f = await fixture("en", undefined, { engine: "local" });
	const local = fakeLocal();
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await local.flush();
	const start = local.worker.received[0]!;
	assert.equal(start.type, "start");
	assert.equal(start.language, null, "English-only Parakeet takes no language");
	assert.equal(start.vad, true);
	const runId = start.runId;
	local.send({ type: "started", runId });
	await local.flush();
	assert.equal(f.dictation.phase, "recording");
	local.send({ type: "text", runId, committed: "Um, and so, my fellow Americ", tentative: "ans" });
	await local.flush();
	assert.equal(f.state.text, "And so, my fellow ");
	assert.equal(f.dictation.tentativeRef.current, "ans");
	await act(async () => { f.dictation.stop(); });
	await local.flush();
	assert.equal(local.worker.received.at(-1)!.type, "stop");
	local.send({ type: "final", runId, text: "Um, and so, my fellow Americans, ask not.", language: null });
	await local.flush();
	assert.equal(f.state.text, "And so, my fellow Americans, ask not.");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(local.worker.received.some((m) => m.type === "cancel"), false, "an ended run is never cancelled");
});

test("local engine: Esc cancels the worker's run and removes its text", async () => {
	const f = await fixture("en", undefined, { engine: "local" });
	const local = fakeLocal();
	f.state.text = "Kept.";
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await local.flush();
	const runId = local.worker.received[0]!.runId;
	local.send({ type: "text", runId, committed: "dictated words here", tentative: "" });
	await local.flush();
	assert.equal(f.state.text, "Kept. dictated words ");
	await act(async () => { f.dictation.cancel(); });
	await local.flush();
	assert.equal(f.state.text, "Kept.");
	assert.deepEqual(local.worker.received.at(-1), { type: "cancel", runId });
});

test("local engine without a downloaded model says so and opens no microphone", async () => {
	const f = await fixture("en", undefined, { engine: "local" });
	fakeLocal({ "parakeet-unified-en-0.6b": "absent" });
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	assert.equal(f.dictation.error, "Dictation needs a local model");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.stops, f.state.captures, "any microphone opened was released");
});
