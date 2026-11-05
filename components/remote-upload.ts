"use client";
// Fork feature: phone attachments over remote control (docs/remote-control.md).
// The LAN proxy (electron/remote-control.cjs) answers /_remote/*; the Next
// server never sees these routes. Uploaded files land on the desktop, and
// their saved paths enter the draft exactly like a desktop attachment.

import { useEffect, useState } from "react";

let probe: Promise<boolean> | null = null;

/** True when this page is served through the remote-control proxy with uploads on. */
export function remoteUploadsAvailable(): Promise<boolean> {
	probe ??= fetch("/_remote/status", { cache: "no-store" })
		.then(async (res) => res.ok && (await res.json())?.uploads === true)
		.catch(() => false);
	return probe;
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
