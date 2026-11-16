import type { PluginBackendContext } from "learnharness-plugin-api";
import { OPS, TOPICS } from "../shared/protocol.ts";
import { createProjects, type Projects } from "./projects.ts";

const obj = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be an object");
	return value as Record<string, unknown>;
};
const str = (value: unknown, name: string): string => {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
};
const optStr = (value: unknown, name: string): string | undefined => value === undefined ? undefined : str(value, name);

/** Frontend operations for project workspaces. Returns the cleanups. */
export function registerProjectOps(ctx: PluginBackendContext, projects: Projects = createProjects({ dataDirectory: ctx.dataDirectory })): Array<() => unknown> {
	const changed = () => { if (!ctx.signal.aborted) ctx.events.emit(TOPICS.projects, { projects: projects.list() }); };
	const handle = (name: string, fn: (input: Record<string, unknown>) => unknown) => ctx.handle(name, input => fn(obj(input ?? {})));
	return [
		handle(OPS.projectsGet, input => projects.state(str(input.chatId, "chatId"))),
		handle(OPS.projectCreate, input => {
			const chatId = str(input.chatId, "chatId");
			const folder = optStr(input.folder, "folder");
			const runCommand = optStr(input.runCommand, "runCommand");
			const created = projects.create({ name: str(input.name, "name"), image: str(input.image, "image"), ...(folder !== undefined ? { folder } : {}), ...(runCommand !== undefined ? { runCommand } : {}) });
			projects.attach(chatId, created.id);
			changed();
			return projects.state(chatId);
		}),
		handle(OPS.projectUpdate, input => {
			const name = optStr(input.name, "name");
			const image = optStr(input.image, "image");
			const runCommand = optStr(input.runCommand, "runCommand");
			projects.update(str(input.id, "id"), { ...(name !== undefined ? { name } : {}), ...(image !== undefined ? { image } : {}), ...(runCommand !== undefined ? { runCommand } : {}) });
			changed();
			return projects.state(str(input.chatId, "chatId"));
		}),
		handle(OPS.projectAttach, input => {
			const chatId = str(input.chatId, "chatId");
			projects.attach(chatId, str(input.id, "id"));
			changed();
			return projects.state(chatId);
		}),
		handle(OPS.projectDetach, input => {
			const chatId = str(input.chatId, "chatId");
			projects.detach(chatId);
			changed();
			return projects.state(chatId);
		}),
		handle(OPS.projectRemove, input => {
			projects.remove(str(input.id, "id"), input.deleteFiles === true);
			changed();
			return projects.state(str(input.chatId, "chatId"));
		}),
	];
}
