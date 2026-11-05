"use strict";
/*
 * Phone remote control: PWA + Tailscale pieces (fork feature, docs/remote-control.md).
 * Static assets the proxy serves without pairing (browsers fetch manifests
 * and service workers without cookies), the pairing page, short pairing
 * codes, and Tailscale HTTPS detection.
 */
const { execFile } = require("node:child_process");
const { randomInt } = require("node:crypto");

// No I/O/0/1 — unambiguous when read off a screen and typed on a phone.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "K7QM-4XPA" */
function newShortCode() {
	let raw = "";
	for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** User input → canonical "XXXXXXXX" (case, spaces and dashes ignored), or null. */
function normalizeShortCode(input) {
	const raw = String(input ?? "").toUpperCase().replace(/[\s-]/g, "");
	return raw.length === 8 && [...raw].every((c) => CODE_ALPHABET.includes(c)) ? raw : null;
}

const THEME = "#141414";

const MANIFEST = JSON.stringify({
	name: "LearnHarness",
	short_name: "LearnHarness",
	start_url: "/",
	scope: "/",
	display: "standalone",
	background_color: THEME,
	theme_color: THEME,
	icons: [
		{ src: "/_remote/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "/_remote/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
	],
});

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LearnHarness</title><body style="font-family:system-ui;background:${THEME};color:#e5e5e5;padding:32px 24px;line-height:1.5"><h1 style="font-size:20px">Can’t reach your computer</h1><p style="color:#a3a3a3">LearnHarness runs on your computer. Make sure it’s on and awake, the desktop app is open with Remote control turned on, and this phone is on the same network (or Tailscale).</p><button onclick="location.reload()" style="margin-top:12px;padding:10px 16px;border-radius:8px;border:1px solid #333;background:#1f1f1f;color:#e5e5e5;font-size:15px">Try again</button>`;

// Install-only worker: no caching. Navigations go to the network; when the
// computer is unreachable, the offline page is answered from memory.
const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const OFFLINE = ${JSON.stringify(OFFLINE_HTML)};
self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return;
	event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HEAD_TAGS = `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${THEME}"><link rel="manifest" href="/_remote/manifest.webmanifest"><link rel="apple-touch-icon" href="/_remote/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="apple-mobile-web-app-title" content="LearnHarness">`;

/** The unpaired landing page: type the short code shown in desktop Settings → Remote. */
function notPairedPage(error) {
	return `<!doctype html><html><head><meta charset="utf-8">${HEAD_TAGS}<title>Pair this device</title></head>
<body style="font-family:system-ui;background:${THEME};color:#e5e5e5;padding:32px 24px;line-height:1.5;margin:0">
<h1 style="font-size:22px;margin:0 0 8px">Pair this device</h1>
<p style="color:#a3a3a3;margin:0 0 20px">On your computer, open LearnHarness → Settings → Remote → <b>Show QR code</b>, then type the code shown under it.</p>
<form method="POST" action="/_remote/pair-code" autocomplete="off">
<input name="code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" aria-label="Pairing code" required
 style="box-sizing:border-box;width:100%;font:600 24px ui-monospace,monospace;letter-spacing:3px;text-align:center;padding:14px;border-radius:10px;border:1px solid #333;background:#0a0a0a;color:#fafafa">
${error ? `<p role="alert" style="color:#f87171;margin:12px 0 0">${escapeHtml(error)}</p>` : ""}
<button type="submit" style="margin-top:16px;width:100%;padding:14px;border-radius:10px;border:0;background:#e5e5e5;color:#0a0a0a;font-size:16px;font-weight:600">Pair</button>
</form>
<script>if("serviceWorker" in navigator&&isSecureContext)navigator.serviceWorker.register("/_remote/sw.js",{scope:"/"}).catch(()=>{});</script>
</body></html>`;
}

/** Static, cookie-less routes. Returns true when handled. */
function servePwaAsset(pathname, res, icons) {
	const send = (type, body, extra = {}) => {
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...extra });
		res.end(body);
		return true;
	};
	if (pathname === "/_remote/manifest.webmanifest") return send("application/manifest+json", MANIFEST);
	if (pathname === "/_remote/sw.js") return send("text/javascript; charset=utf-8", SERVICE_WORKER, { "Service-Worker-Allowed": "/" });
	const icon = pathname === "/_remote/icon-192.png" ? icons?.[192] : pathname === "/_remote/icon-512.png" ? icons?.[512] : null;
	if (icon) return send("image/png", icon);
	return false;
}

/** {dnsName} from `tailscale status --json`, or null when Tailscale isn't installed/running. */
function detectTailscale({ run = execFile, timeoutMs = 4000 } = {}) {
	return new Promise((resolve) => {
		run("tailscale", ["status", "--json"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
			if (err) return resolve(null);
			try {
				const status = JSON.parse(String(stdout));
				const dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
				const certOk = Array.isArray(status?.CertDomains) && status.CertDomains.includes(dnsName);
				resolve(dnsName ? { dnsName, certificates: certOk } : null);
			} catch {
				resolve(null);
			}
		});
	});
}

/** True when https://<dnsName> reaches this proxy (i.e. `tailscale serve` is set up). */
async function probeHttps(dnsName, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
	try {
		const res = await fetchImpl(`https://${dnsName}/_remote/manifest.webmanifest`, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok && (await res.text()).includes("LearnHarness");
	} catch {
		return false;
	}
}

module.exports = { newShortCode, normalizeShortCode, notPairedPage, servePwaAsset, detectTailscale, probeHttps, HEAD_TAGS, CODE_ALPHABET };
