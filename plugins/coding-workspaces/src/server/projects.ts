import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODE_IMAGES, type CodeImage } from "./languages.ts";
import type { ProjectInfo, ProjectsState } from "../shared/protocol.ts";

/**
 * Project workspaces: long-lived, named project folders on the host that teaching
 * sessions attach to. A managed project lives under the plugin's data directory; a
 * custom one points at a folder the learner chose and is never deleted by the app.
 * Several sessions may attach to the same project; a session attaches to at most one.
 */
export interface ProjectRecord {
	id: string;
	name: string;
	image: CodeImage;
	hostPath: string;
	managed: boolean;
	runCommand: string;
	createdAt: string;
}

interface Registry {
	projects: ProjectRecord[];
	/** chatId → project id */
	attachments: Record<string, string>;
}

export interface ProjectsDeps {
	/** The plugin data directory; registry and managed folders live under it. */
	dataDirectory: string;
	now?: () => Date;
}

const NAME_MAX = 80;

export function createProjects(deps: ProjectsDeps) {
	const registryFile = path.join(deps.dataDirectory, "projects.json");
	const managedRoot = path.join(deps.dataDirectory, "projects");
	const now = deps.now ?? (() => new Date());

	const load = (): Registry => {
		try {
			const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as Partial<Registry>;
			return { projects: Array.isArray(raw.projects) ? raw.projects : [], attachments: raw.attachments && typeof raw.attachments === "object" ? raw.attachments : {} };
		} catch {
			return { projects: [], attachments: {} };
		}
	};
	let registry = load();
	const save = () => {
		fs.mkdirSync(deps.dataDirectory, { recursive: true });
		const temp = `${registryFile}.${process.pid}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(registry, null, "\t")}\n`);
		fs.renameSync(temp, registryFile);
	};

	const find = (id: string): ProjectRecord => {
		const record = registry.projects.find(p => p.id === id);
		if (!record) throw new Error("Unknown project");
		return record;
	};
	const info = (record: ProjectRecord): ProjectInfo => ({
		...record,
		exists: fs.existsSync(record.hostPath),
		sessions: Object.entries(registry.attachments).filter(([, id]) => id === record.id).map(([chatId]) => chatId),
	});

	function validateName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Give the project a name");
		if (trimmed.length > NAME_MAX) throw new Error(`Names are at most ${NAME_MAX} characters`);
		return trimmed;
	}
	function validateImage(image: string): CodeImage {
		if (!(CODE_IMAGES as readonly string[]).includes(image)) throw new Error("Unknown language image");
		return image as CodeImage;
	}
	/** A custom folder must be absolute; it is created if missing. Must not already belong to a project. */
	function validateFolder(folder: string): string {
		const trimmed = folder.trim();
		if (!path.isAbsolute(trimmed)) throw new Error("Use an absolute folder path");
		const resolved = path.resolve(trimmed);
		if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) throw new Error("That path is a file, not a folder");
		const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
		if (registry.projects.some(p => same(path.resolve(p.hostPath), resolved))) throw new Error("Another project already uses that folder");
		return resolved;
	}

	return {
		list: (): ProjectInfo[] => registry.projects.map(info),
		get: (id: string): ProjectInfo => info(find(id)),
		/** The project a chat is attached to, or null. */
		forChat(chatId: string): ProjectInfo | null {
			const id = registry.attachments[chatId];
			const record = id ? registry.projects.find(p => p.id === id) : undefined;
			return record ? info(record) : null;
		},
		state(chatId: string): ProjectsState {
			return { chatId, attached: this.forChat(chatId), runtime: null, proposals: [], notes: [], suggestion: null, projects: this.list() };
		},
		create(input: { name: string; image: string; folder?: string; runCommand?: string }): ProjectInfo {
			const name = validateName(input.name);
			const image = validateImage(input.image);
			const id = randomUUID();
			const custom = input.folder?.trim() ? validateFolder(input.folder) : null;
			const hostPath = custom ?? path.join(managedRoot, id);
			fs.mkdirSync(hostPath, { recursive: true });
			const record: ProjectRecord = { id, name, image, hostPath, managed: custom === null, runCommand: input.runCommand?.trim() ?? "", createdAt: now().toISOString() };
			registry.projects.push(record);
			save();
			return info(record);
		},
		update(id: string, patch: { name?: string; image?: string; runCommand?: string }): ProjectInfo {
			const record = find(id);
			if (patch.name !== undefined) record.name = validateName(patch.name);
			if (patch.image !== undefined) record.image = validateImage(patch.image);
			if (patch.runCommand !== undefined) record.runCommand = patch.runCommand.trim();
			save();
			return info(record);
		},
		attach(chatId: string, id: string): ProjectInfo {
			const record = find(id);
			registry.attachments[chatId] = id;
			save();
			return info(record);
		},
		detach(chatId: string): void {
			if (!(chatId in registry.attachments)) return;
			delete registry.attachments[chatId];
			save();
		},
		/**
		 * Forget a project. Its sessions are detached. A managed folder is deleted only when
		 * `deleteFiles` is set; a custom folder is never deleted.
		 */
		remove(id: string, deleteFiles: boolean): void {
			const record = find(id);
			registry.projects = registry.projects.filter(p => p.id !== id);
			for (const [chatId, attached] of Object.entries(registry.attachments)) if (attached === id) delete registry.attachments[chatId];
			save();
			if (deleteFiles && record.managed && path.dirname(record.hostPath) === managedRoot) fs.rmSync(record.hostPath, { recursive: true, force: true });
		},
		reload() { registry = load(); },
	};
}

export type Projects = ReturnType<typeof createProjects>;
