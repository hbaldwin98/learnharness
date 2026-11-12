#!/usr/bin/env node
/**
 * One-time fork migration: rewrite the fork's old `reading-discussion` custom
 * messages in session files into the E1 `plugin-marker` entries the Readings
 * plugin writes now (pluginId "readings", typeId "discussed"). Run once, with
 * LearnHarness closed:
 *
 *   node plugins/readings/scripts/migrate-session-markers.mjs <learning-data-dir> [--dry-run]
 *
 * Every session file it changes is first copied to
 * `<file>.pre-readings-markers.bak` (an existing backup is never overwritten).
 * Idempotent: converted markers are no longer `reading-discussion`, so a rerun
 * changes nothing. Message ids, order and timestamps are kept.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BACKUP_SUFFIX = ".pre-readings-markers.bak";

/** Convert one old marker message (pure). */
export function convertMarker(message) {
	const data = message.details ?? {};
	const content = typeof message.content === "string" ? message.content : "";
	return {
		...message,
		customType: "plugin-marker",
		content: content.trim() ? `[plugin readings] ${content}` : "",
		display: true,
		details: { pluginId: "readings", typeId: "discussed", data, ...(typeof data.exchangeId === "string" ? { idempotencyKey: `rdq_${data.exchangeId}` } : {}) },
	};
}

export function migrateSessionMarkers(dataDir, { dryRun = false } = {}) {
	const chats = path.join(dataDir, "chats");
	const result = { sessionsScanned: 0, sessionsChanged: 0, markersConverted: 0, skipped: [] };
	let names = [];
	try {
		names = fs.readdirSync(chats).filter((n) => n.endsWith(".json"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	for (const name of names) {
		const file = path.join(chats, name);
		result.sessionsScanned++;
		let record;
		try {
			record = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			result.skipped.push(name);
			continue;
		}
		if (!record || !Array.isArray(record.messages)) continue;
		let count = 0;
		const messages = record.messages.map((m) => {
			if (m?.role !== "custom" || m.customType !== "reading-discussion") return m;
			count++;
			return convertMarker(m);
		});
		if (count === 0) continue;
		result.sessionsChanged++;
		result.markersConverted += count;
		if (dryRun) continue;
		const backup = file + BACKUP_SUFFIX;
		if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...record, messages }, null, "\t"), "utf8");
		fs.renameSync(tmp, file);
	}
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const dir = args.find((a) => !a.startsWith("--"));
	if (!dir) {
		console.error("Usage: node plugins/readings/scripts/migrate-session-markers.mjs <learning-data-dir> [--dry-run]");
		process.exit(2);
	}
	const r = migrateSessionMarkers(path.resolve(dir), { dryRun });
	console.log(`${dryRun ? "[dry run] " : ""}scanned ${r.sessionsScanned} sessions; ${dryRun ? "would change" : "changed"} ${r.sessionsChanged}; converted ${r.markersConverted} markers${r.skipped.length ? `; skipped unreadable: ${r.skipped.join(", ")}` : ""}`);
}
