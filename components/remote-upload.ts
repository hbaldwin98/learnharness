"use client";
// Fork feature: phone attachments over remote control (docs/remote-control.md).
// The LAN proxy (electron/remote-control.cjs) answers /_remote/*; the Next
// server never sees these routes. Uploaded files land on the desktop, and
// their saved paths enter the draft exactly like a desktop attachment.

import { useEffect, useState } from "react";

export type RemoteStatus = { remote: true; uploads: boolean; dictation?: boolean };

let probe: Promise<RemoteStatus | null> | null = null;
let known: RemoteStatus | null = null;

/** The proxy's /_remote/status, or null when this page isn't remote-served. Cached. */
export function remoteStatus(): Promise<RemoteStatus | null> {
	probe ??= fetch("/_remote/status", { cache: "no-store" })
		.then(async (res) => {
			const body = res.ok ? ((await res.json()) as RemoteStatus | null) : null;
			known = body?.remote === true ? body : null;
			return known;
		})
		.catch(() => null);
	return probe;
}

/** The status once the probe has answered (null before, or when not remote). */
export function remoteStatusSync(): RemoteStatus | null {
	return known;
}

/** True when this page is served through the remote-control proxy with uploads on. */
export function remoteUploadsAvailable(): Promise<boolean> {
	return remoteStatus().then((s) => s?.uploads === true);
}

export function useRemoteUploads(enabled: boolean): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		void remoteUploadsAvailable().then((ok) => { if (live) setAvailable(ok); });
		return () => { live = false; };
	}, [enabled]);
	return available;
}

/** Uploads each file; returns the saved desktop paths and per-file errors. */
export async function uploadFilesToDesktop(files: File[]): Promise<{ paths: string[]; errors: string[] }> {
	const paths: string[] = [];
	const errors: string[] = [];
	for (const file of files) {
		try {
			const res = await fetch(`/_remote/upload?name=${encodeURIComponent(file.name)}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: file,
			});
			const reply = (await res.json().catch(() => null)) as { path?: string; error?: string } | null;
			if (res.ok && reply?.path) paths.push(reply.path);
			else errors.push(`${file.name}: ${reply?.error ?? "upload failed"}`);
		} catch {
			errors.push(`${file.name}: upload failed`);
		}
	}
	return { paths, errors };
}

/** Remote-served pages only: add the PWA manifest + iOS tags and register the
 *  install-only service worker (all assets come from the proxy). Idempotent. */
export function installRemotePwa(): void {
	if (window.lh) return; // the desktop window is never a remote page
	void remoteStatus().then((status) => {
		if (!status) return;
		// Phone dictation relays to the desktop engine; the mic needs HTTPS.
		if (status.dictation && window.isSecureContext) document.documentElement.dataset.lhRemoteDictation = "";
		if (document.querySelector('link[rel="manifest"]')) return;
		const add = (tag: string, attrs: Record<string, string>) => {
			const el = document.createElement(tag);
			for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
			document.head.appendChild(el);
		};
		add("link", { rel: "manifest", href: "/_remote/manifest.webmanifest" });
		add("link", { rel: "apple-touch-icon", href: "/_remote/icon-192.png" });
		add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
		add("meta", { name: "mobile-web-app-capable", content: "yes" });
		add("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black" });
		add("meta", { name: "apple-mobile-web-app-title", content: "LearnHarness" });
		add("meta", { name: "theme-color", content: "#141414" });
		if ("serviceWorker" in navigator && window.isSecureContext) {
			void navigator.serviceWorker.register("/_remote/sw.js", { scope: "/" }).catch(() => {});
		}
	});
}
