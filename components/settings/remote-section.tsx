"use client";
// Fork feature: phone remote control (docs/remote-control.md).

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

export type RemoteSnapshot = {
	enabled: boolean;
	listening: boolean;
	url: string | null;
	error: string | null;
	/** Chosen adapter address; null = automatic (first adapter). */
	host: string | null;
	networks: { name: string; address: string }[];
	/** Tailscale HTTPS (null when Tailscale isn't installed/running). */
	tailscale: { dnsName: string; certificates: boolean; httpsReady: boolean; url: string; serveCommand: string | null } | null;
	devices: { id: string; name: string; createdAt: string; lastSeen: string }[];
};

type RemoteCommand =
	| { op: "status" | "enable" | "disable" | "pair" }
	| { op: "revoke"; id: string }
	| { op: "setHost"; host: string | null }
	| { op: "checkTailscale" };

export type RemoteControlBridge = {
	control: (command: RemoteCommand) => Promise<unknown>;
	onChange: (cb: (snapshot: RemoteSnapshot) => void) => () => void;
};

export function RemoteSection() {
	const [bridge, setBridge] = useState<RemoteControlBridge | null>(null);
	const [snap, setSnap] = useState<RemoteSnapshot | null>(null);
	const [qr, setQr] = useState<{ src: string; expiresAt: number; shortCode: string } | null>(null);
	const [checking, setChecking] = useState(false);
	const [copied, setCopied] = useState(false);
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
	const pickNetwork = async (value: string) => {
		setBusy(true);
		try { setSnap((await bridge.control({ op: "setHost", host: value === "" ? null : value })) as RemoteSnapshot); } finally { setBusy(false); }
	};
	const missing = snap.host !== null && !snap.networks.some((n) => n.address === snap.host);
	const pair = async () => {
		const { url, expiresAt, shortCode } = (await bridge.control({ op: "pair" })) as { url: string; expiresAt: number; shortCode: string };
		setQr({ src: await QRCode.toDataURL(url, { margin: 1, width: 220 }), expiresAt, shortCode });
	};
	const checkTailscale = async () => {
		setChecking(true);
		try { setSnap((await bridge.control({ op: "checkTailscale" })) as RemoteSnapshot); } finally { setChecking(false); }
	};
	const copyServe = async (command: string) => {
		try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard denied */ }
	};
	const ts = snap.tailscale;

	return (
		<div className="flex flex-col gap-2" data-testid="remote-settings">
			<SettingsRow
				label="Remote control"
				hint={snap.error ?? (snap.listening ? `Listening on ${snap.url} (home network only)` : "Control this app from your phone on the same Wi-Fi")}
				testid="row-remote-enabled"
			>
				<Toggle checked={snap.enabled} disabled={busy} onChange={(on) => void toggle(on)} label="Remote control" />
			</SettingsRow>
			<SettingsRow label="Network" hint="Pick your home Wi-Fi or Ethernet adapter. Tailscale works too, if your phone runs it." testid="row-remote-network">
				<ThinSelect value={snap.host ?? ""} onChange={(v) => void pickNetwork(v)} ariaLabel="Remote control network" testid="remote-network" disabled={busy}>
					<option value="">Automatic{snap.networks[0] ? ` (${snap.networks[0].name})` : ""}</option>
					{missing && <option value={snap.host ?? ""}>{snap.host} (unavailable)</option>}
					{snap.networks.map((n) => <option key={`${n.name}-${n.address}`} value={n.address}>{n.name} · {n.address}</option>)}
				</ThinSelect>
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
			{qr && (
				<p className="text-center text-xs text-muted-foreground" data-testid="remote-short-code">
					In the installed app, enter <span className="ml-1 font-mono text-base tracking-widest text-foreground">{qr.shortCode}</span>
				</p>
			)}
			{snap.listening && (
				<SettingsRow
					label="HTTPS (Tailscale)"
					hint={!ts ? "Tailscale isn’t running on this computer. Install it for HTTPS and an installable phone app."
						: ts.httpsReady ? `Ready: ${ts.url} (QR codes use this address)`
						: !ts.certificates ? "Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console, then check again."
						: "Run this once in a terminal, then check again:"}
					testid="row-remote-tailscale"
				>
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={checking} onClick={() => void checkTailscale()}>{checking ? "Checking…" : "Check again"}</Button>
				</SettingsRow>
			)}
			{snap.listening && ts && !ts.httpsReady && ts.certificates && ts.serveCommand && (
				<div className="flex items-center gap-2 px-1">
					<code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs" data-testid="remote-serve-command">{ts.serveCommand}</code>
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" onClick={() => void copyServe(ts.serveCommand!)}>{copied ? "Copied" : "Copy"}</Button>
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
