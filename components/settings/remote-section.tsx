"use client";
// Fork feature: phone remote control (docs/remote-control.md).

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { SettingsRow, Toggle } from "./controls.tsx";

export type RemoteSnapshot = {
	enabled: boolean;
	listening: boolean;
	url: string | null;
	error: string | null;
	devices: { id: string; name: string; createdAt: string; lastSeen: string }[];
};

type RemoteCommand = { op: "status" | "enable" | "disable" | "pair" } | { op: "revoke"; id: string };

export type RemoteControlBridge = {
	control: (command: RemoteCommand) => Promise<unknown>;
	onChange: (cb: (snapshot: RemoteSnapshot) => void) => () => void;
};

export function RemoteSection() {
	const [bridge, setBridge] = useState<RemoteControlBridge | null>(null);
	const [snap, setSnap] = useState<RemoteSnapshot | null>(null);
	const [qr, setQr] = useState<{ src: string; expiresAt: number } | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const b = window.lh?.remote ?? null;
		setBridge(b);
		if (!b) return;
		const off = b.onChange(setSnap);
		void b.control({ op: "status" }).then((s) => setSnap(s as RemoteSnapshot));
		return off;
	}, []);

	useEffect(() => {
		if (!snap?.listening) setQr(null);
	}, [snap?.listening]);

	useEffect(() => {
		if (!qr) return;
		const left = qr.expiresAt - Date.now();
		const t = setTimeout(() => setQr(null), Math.max(0, left));
		return () => clearTimeout(t);
	}, [qr]);

	if (!bridge) {
		return <p className="px-1 text-xs text-muted-foreground">Remote control is managed from the desktop app.</p>;
	}
	if (!snap) return <p className="px-1 text-xs text-muted-foreground">Loading…</p>;

	const toggle = async (on: boolean) => {
		setBusy(true);
		try { setSnap((await bridge.control({ op: on ? "enable" : "disable" })) as RemoteSnapshot); } finally { setBusy(false); }
	};
	const pair = async () => {
		const { url, expiresAt } = (await bridge.control({ op: "pair" })) as { url: string; expiresAt: number };
		setQr({ src: await QRCode.toDataURL(url, { margin: 1, width: 220 }), expiresAt });
	};

	return (
		<div className="flex flex-col gap-2" data-testid="remote-settings">
			<SettingsRow
				label="Remote control"
				hint={snap.error ?? (snap.listening ? `Listening on ${snap.url} (home network only)` : "Control this app from your phone on the same Wi-Fi")}
				testid="row-remote-enabled"
			>
				<Toggle checked={snap.enabled} disabled={busy} onChange={(on) => void toggle(on)} label="Remote control" />
			</SettingsRow>
			{snap.listening && (
				<SettingsRow label="Pair a phone" hint="Scan with your phone's camera. The code works once and expires in 5 minutes." testid="row-remote-pair">
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" onClick={() => void pair()}>{qr ? "New code" : "Show QR code"}</Button>
				</SettingsRow>
			)}
			{qr && (
				<div className="flex justify-center py-2">
					{/* eslint-disable-next-line @next/next/no-img-element -- data URL, nothing to optimize */}
					<img src={qr.src} alt="Pairing QR code" width={220} height={220} className="rounded" />
				</div>
			)}
			{snap.devices.map((d) => (
				<SettingsRow key={d.id} label={d.name} hint={`Paired ${new Date(d.createdAt).toLocaleDateString()} · last seen ${new Date(d.lastSeen).toLocaleString()}`} testid="row-remote-device">
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" onClick={() => void bridge.control({ op: "revoke", id: d.id })}>Revoke</Button>
				</SettingsRow>
			))}
		</div>
	);
}
