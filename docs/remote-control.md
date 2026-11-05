# Phone remote control (fork feature)

Fork-only feature: control the running desktop app from a phone on the home LAN. The phone uses the same server, the same data and the same Claude Code sessions as the desktop window.

## Approved design (2026-11-04)

- **Network:** home LAN over plain HTTP, accepted on a trusted home network. The bind address is a stored setting, so Tailscale can be added later by binding to the Tailscale IP.
- **Shape:** an Electron-side LAN proxy, `electron/remote-control.cjs`. The Next server keeps binding to 127.0.0.1, and `proxy.ts` and `desktop-access.ts` are untouched. The proxy checks the phone's device token, then forwards the request to the loopback server with the per-launch desktop secret added.
- **Pairing:** Settings → Remote shows a QR code for a one-time pairing URL that expires after 5 minutes. Opening it sets a long-lived device token cookie (HttpOnly, SameSite=Strict). Only SHA-256 hashes of tokens are stored. Paired devices are listed in Settings, and each one can be revoked.
- **Toggle:** Settings → Remote control is off by default and persisted across launches. Turning it off closes the listener and drops connected sockets.
- **Phone UI:** the same app UI, made responsive. On the phone `window.lh` is absent, so features that depend on Electron (ChatGPT/subscription sign-in, updates, zoom, local dictation models) are hidden. The phone uses its own keyboard dictation and browser file uploads.
- **Isolation from upstream:** the feature lives in new files. Upstream files only get small wiring hunks: `electron/main.cjs`, `electron/preload.cjs`, the `window.lh` type in `components/sidebar.tsx`, and the section registry in `components/settings/settings-dialog.tsx`.

## Steps

1. ✅ LAN proxy and pairing (`electron/remote-control.cjs`), with tests.
2. ✅ Main/preload wiring, plus the Settings → Remote section with the QR code and network picker.
3. ✅ Phone attachments. The paperclip uploads to the proxy's `/_remote/upload`, and the saved desktop path is inserted like a desktop attachment. Uploads are saved under `userData/remote-uploads/<date>/<random>/<name>` and kept indefinitely (owner choice), with a 100 MB cap per file. Settings that depend on Electron already hide themselves because `window.lh` is absent on the phone.
4. ✅ Phone layout (`app/phone.css`, `components/phone.tsx`): sidebar drawer, full-screen Settings, compact chat header, capped question dock, desktop dictation hidden.

## Minor decisions (recommended defaults taken)

- Default port is 47800 (override it in `userData/remote-control.json`). Settings → Remote → Network chooses the adapter. "Automatic" falls back to the first non-internal IPv4 address, which on Windows may be Tailscale or WSL.
- The QR code is rendered in the renderer with the `qrcode` package. That keeps the Electron asar's dependency allow-list unchanged.
- State-changing requests carrying a foreign `Origin` header are rejected (403). The proxy rewrites `Host` and `Origin` to the loopback target so Next's server-action origin check passes.
- Responses can carry an absolute `Location` header pointing at the loopback origin. The proxy rewrites those to relative paths.

## Notes

- If Agent → File access is set to "Restrict to listed folders", add `%APPDATA%/LearnHarness/remote-uploads` to the allowed list, or the agent can't read phone attachments.
- Upload routes (`/_remote/status`, `/_remote/upload`) are answered by the proxy and never reach the Next server. They require a paired device, and uploads also require a same-origin `Origin` header.

## Tailscale HTTPS + installable PWA (2026-11-04)

- **Tailscale:** Settings → Remote detects the machine's `*.ts.net` name with `tailscale status --json` and checks `https://<name>/_remote/manifest.webmanifest`. When that works, it shows "Ready" and QR links use the HTTPS address. When it doesn't, it shows the `tailscale serve --bg http://<listen-ip>:<port>` command to copy. The app never changes Tailscale's config (owner choice).
- **Trusted origins:** the LAN listener origin plus `https://<name>.ts.net`, for writes, uploads and the pairing form.
- **Short codes:** each pairing also issues an 8-character code (`XXXX-XXXX`, alphabet without I/O/0/1). The QR link and the code are one pairing slot, single use and valid for 5 minutes. 10 wrong codes cancel the pairing. The unpaired page (`/_remote/pair-code` form) lets an installed home-screen app pair itself, because iOS standalone apps don't share Safari's cookies.
- **PWA:** the proxy serves `/_remote/manifest.webmanifest`, `/_remote/sw.js` (with `Service-Worker-Allowed: /`) and `/_remote/icon-{192,512}.png` without pairing. The icons are made from `electron/remote-icon.png`, a copy of `build/icon.png`, because only `electron/**` ships in the asar. The worker only enables installing and caches nothing. Failed navigations show a "Can't reach your computer" page. On pages served through remote control, `components/remote-upload.ts#installRemotePwa` adds the manifest and iOS tags; the desktop window skips this.
