"use client";
// Fork feature: phone dictation over remote control (docs/remote-control.md).
// A remote page has no Electron bridge, so this stands in for
// window.lh.dictation: status comes from the LAN proxy, and "connect" opens a
// WebSocket that the proxy relays onto the desktop's local dictation worker
// (electron/remote-dictation.cjs). The page receives an ordinary
// MessagePort exactly as on the desktop, so components/dictation.tsx runs
// unchanged.

import type { LocalDictationBridge, LocalDictationCommand, LocalDictationSnapshot } from "@/components/local-dictation";
import { remoteStatusSync } from "@/components/remote-upload";

const STATUS_URL = "/_remote/dictation/status";
const SOCKET_PATH = "/_remote/dictation";
const OPEN_TIMEOUT_MS = 5000;
/** After the worker ends a run, give stray messages a beat before closing. */
const LINGER_MS = 1500;

async function status(): Promise<LocalDictationSnapshot> {
	const res = await fetch(STATUS_URL, { cache: "no-store" });
	if (!res.ok) throw new Error("Local dictation is unavailable");
	return (await res.json()) as LocalDictationSnapshot;
}

let current: WebSocket | null = null;

/** Opens the relay socket; resolves true once the worker port is attached
 *  (the page then receives its MessagePort), false while the engine starts. */
function connect(): Promise<boolean> {
	current?.close();
	return new Promise((resolve, reject) => {
		const url = new URL(SOCKET_PATH, window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		current = ws;
		let settled = false;
		const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new Error("The dictation engine is not responding")); } }, OPEN_TIMEOUT_MS);
		const { port1, port2 } = new MessageChannel();
		let closing: ReturnType<typeof setTimeout> | undefined;
		const lingerClose = () => { clearTimeout(closing); closing = setTimeout(() => ws.close(), LINGER_MS); };

		// page → desktop: control messages as JSON, audio as [u32 LE runId][PCM].
		port1.onmessage = ({ data }) => {
			if (ws.readyState !== WebSocket.OPEN || !data) return;
			if (data.type === "audio" && data.pcm instanceof ArrayBuffer) {
				const frame = new Uint8Array(4 + data.pcm.byteLength);
				new DataView(frame.buffer).setUint32(0, data.runId >>> 0, true);
				frame.set(new Uint8Array(data.pcm), 4);
				ws.send(frame.buffer);
				return;
			}
			ws.send(JSON.stringify(data));
			if (data.type === "cancel") lingerClose();
		};
		// desktop → page: the worker's messages verbatim, after the handshake.
		ws.onmessage = ({ data }) => {
			let msg: { type?: string } | null = null;
			try { msg = JSON.parse(String(data)); } catch { return; }
			if (!msg) return;
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				if (msg.type !== "ready") { ws.close(); resolve(false); return; }
				window.postMessage({ type: "lh:dictation:port" }, window.location.origin, [port2]);
				resolve(true);
				return;
			}
			port1.postMessage(msg);
			if (msg.type === "final" || msg.type === "error") lingerClose();
		};
		ws.onerror = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error("Couldn’t reach the dictation engine"));
		};
		ws.onclose = () => {
			clearTimeout(closing);
			port1.close();
			if (current === ws) current = null;
			if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
		};
	});
}

const remoteBridge: LocalDictationBridge = {
	control(command: LocalDictationCommand) {
		switch (command.op) {
			case "status":
			case "configure": // the desktop owns the engine config; the phone only uses it
				return status();
			case "connect":
				return connect();
			default:
				return Promise.reject(new Error("Manage dictation models on your computer"));
		}
	},
	onChange: () => () => {},
};

/** The bridge for remote-served pages whose desktop offers dictation over
 *  HTTPS (the phone mic needs a secure context); undefined otherwise. */
export function remoteDictationBridge(): LocalDictationBridge | undefined {
	if (typeof window === "undefined" || window.lh || !window.isSecureContext) return undefined;
	return remoteStatusSync()?.dictation ? remoteBridge : undefined;
}
