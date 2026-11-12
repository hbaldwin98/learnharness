import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKUP_SUFFIX, migrateSessionMarkers } from "../scripts/migrate-session-markers.mjs";
import { DISCUSSED_MARKER_TYPE } from "../src/contract.ts";

test("old reading-discussion markers become readings plugin-markers; backup, dry run, idempotent", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-readings-markers-"));
	try {
		const chats = path.join(root, "chats");
		fs.mkdirSync(chats);
		const details = { chatId: "c1", readingId: "rd_1", readingTitle: "R", threadId: "side", exchangeId: "dx_1" };
		const old = { id: "steer_rdq_dx_1", role: "custom", customType: "reading-discussion", content: "Reading discussion — …", display: true, details, timestamp: 5 };
		const session = { id: "c1", title: "T", messages: [{ id: "u", role: "user", content: "hi" }, old], version: 2 };
		fs.writeFileSync(path.join(chats, "c1.json"), JSON.stringify(session));
		fs.writeFileSync(path.join(chats, "c2.json"), JSON.stringify({ id: "c2", messages: [] }));
		const original = fs.readFileSync(path.join(chats, "c1.json"), "utf8");

		assert.deepEqual(migrateSessionMarkers(root, { dryRun: true }), { sessionsScanned: 2, sessionsChanged: 1, markersConverted: 1, skipped: [] });
		assert.equal(fs.readFileSync(path.join(chats, "c1.json"), "utf8"), original);

		assert.equal(migrateSessionMarkers(root).markersConverted, 1);
		assert.equal(fs.readFileSync(path.join(chats, "c1.json" + BACKUP_SUFFIX), "utf8"), original);
		const m = JSON.parse(fs.readFileSync(path.join(chats, "c1.json"), "utf8")).messages[1];
		assert.deepEqual(m, { ...old, customType: "plugin-marker", content: "[plugin readings] Reading discussion — …", details: { pluginId: "readings", typeId: DISCUSSED_MARKER_TYPE, data: details, idempotencyKey: "rdq_dx_1" } });

		const after = fs.readFileSync(path.join(chats, "c1.json"), "utf8");
		assert.equal(migrateSessionMarkers(root).markersConverted, 0);
		assert.equal(fs.readFileSync(path.join(chats, "c1.json"), "utf8"), after);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
