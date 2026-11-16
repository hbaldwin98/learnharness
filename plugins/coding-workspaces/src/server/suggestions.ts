import fs from "node:fs";
import path from "node:path";
import type { ProjectSuggestion } from "../shared/protocol.ts";
import { CODE_IMAGES } from "./languages.ts";

/** The tutor's pending "create a project" suggestions, at most one per chat (persisted). */
export function createSuggestions(file: string) {
	const load = (): Record<string, ProjectSuggestion> => {
		try { const raw = JSON.parse(fs.readFileSync(file, "utf8")); return raw && typeof raw === "object" ? raw : {}; } catch { return {}; }
	};
	const save = (all: Record<string, ProjectSuggestion>) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(all));
		fs.renameSync(temp, file);
	};
	return {
		get: (chatId: string): ProjectSuggestion | null => load()[chatId] ?? null,
		suggest(input: Omit<ProjectSuggestion, "at"> & { now?: Date }): ProjectSuggestion {
			const name = input.name.trim();
			if (!name || name.length > 80) throw new Error("name must be 1–80 characters");
			if (!(CODE_IMAGES as readonly string[]).includes(input.image)) throw new Error(`image must be one of ${CODE_IMAGES.join(", ")}`);
			const suggestion: ProjectSuggestion = { chatId: input.chatId, name, image: input.image, runCommand: input.runCommand.trim(), reason: input.reason.trim(), at: (input.now ?? new Date()).toISOString() };
			save({ ...load(), [input.chatId]: suggestion });
			return suggestion;
		},
		clear(chatId: string): ProjectSuggestion | null {
			const all = load();
			const existing = all[chatId] ?? null;
			if (existing) { delete all[chatId]; save(all); }
			return existing;
		},
	};
}
