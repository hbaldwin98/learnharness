import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ItemKey } from "./docker-runner.ts";
import type { WorkspaceRecord, WorkspaceStore } from "./workspaces.ts";

/** One JSON file per item under the plugin's data directory; writes are atomic. */
export function createFileStore(directory: string): WorkspaceStore {
	const fileOf = (key: ItemKey) => path.join(directory, `${createHash("sha256").update(`${key.chatId}\0${key.itemId}`).digest("hex").slice(0, 32)}.json`);
	return {
		load(key) {
			try {
				const record = JSON.parse(fs.readFileSync(fileOf(key), "utf8")) as WorkspaceRecord;
				return record.chatId === key.chatId && record.itemId === key.itemId ? record : null;
			} catch {
				return null;
			}
		},
		save(record) {
			fs.mkdirSync(directory, { recursive: true });
			const file = fileOf(record);
			const temp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(temp, JSON.stringify(record));
			fs.renameSync(temp, file);
		},
	};
}
