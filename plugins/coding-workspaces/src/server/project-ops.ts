import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { OPS, TOPICS, type ProjectsState } from "../shared/protocol.ts";
import type { DockerRunner } from "./docker-runner.ts";
import type { CodeImage } from "./languages.ts";
import { createProjectContainers } from "./project-container.ts";
import { createProjectRuntime } from "./project-runtime.ts";
import { createProjects } from "./projects.ts";

const obj = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be an object");
	return value as Record<string, unknown>;
};
const str = (value: unknown, name: string): string => {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
};
const optStr = (value: unknown, name: string): string | undefined => value === undefined ? undefined : str(value, name);

const refOf = (p: { id: string; image: string; hostPath: string; runCommand: string }) => ({ id: p.id, image: p.image as CodeImage, hostPath: p.hostPath, runCommand: p.runCommand });

/** Project workspaces: registry, containers, Run, and their frontend operations. */
export function registerProjectOps(ctx: PluginBackendContext, runner: DockerRunner) {
	const projects = createProjects({ dataDirectory: ctx.dataDirectory });
	const changed = () => { if (!ctx.signal.aborted) ctx.events.emit(TOPICS.projects, {}); };
	const containers = createProjectContainers(runner, { onIdleRemoved: () => changed() });
	const runtime = createProjectRuntime({
		runsDirectory: path.join(ctx.dataDirectory, "project-runs"),
		dockerStatus: () => runner.status(),
		containerRunning: id => containers.running(id),
		exec: (project, command, opts) => containers.run(project, command, opts),
		stopContainer: id => containers.remove(id),
		changed,
	});

	async function state(chatId: string): Promise<ProjectsState> {
		const base = projects.state(chatId);
		return { ...base, runtime: base.attached ? await runtime.state(base.attached.id) : null };
	}
	/** The project the chat is attached to (errors when none). */
	const attachedTo = (chatId: string) => {
		const p = projects.forChat(chatId);
		if (!p) throw new Error("This session has no project workspace");
		return p;
	};

	const handle = (name: string, fn: (input: Record<string, unknown>) => unknown) => ctx.handle(name, input => fn(obj(input ?? {})));
	const cleanups: Array<() => unknown> = [
		handle(OPS.projectsGet, input => state(str(input.chatId, "chatId"))),
		handle(OPS.projectCreate, input => {
			const chatId = str(input.chatId, "chatId");
			const folder = optStr(input.folder, "folder");
			const runCommand = optStr(input.runCommand, "runCommand");
			const created = projects.create({ name: str(input.name, "name"), image: str(input.image, "image"), ...(folder !== undefined ? { folder } : {}), ...(runCommand !== undefined ? { runCommand } : {}) });
			projects.attach(chatId, created.id);
			changed();
			return state(chatId);
		}),
		handle(OPS.projectUpdate, async input => {
			const id = str(input.id, "id");
			const name = optStr(input.name, "name");
			const image = optStr(input.image, "image");
			const runCommand = optStr(input.runCommand, "runCommand");
			const before = projects.get(id);
			projects.update(id, { ...(name !== undefined ? { name } : {}), ...(image !== undefined ? { image } : {}), ...(runCommand !== undefined ? { runCommand } : {}) });
			// A new image takes effect on the next start.
			if (image !== undefined && image !== before.image) await containers.remove(id);
			changed();
			return state(str(input.chatId, "chatId"));
		}),
		handle(OPS.projectAttach, input => {
			const chatId = str(input.chatId, "chatId");
			projects.attach(chatId, str(input.id, "id"));
			changed();
			return state(chatId);
		}),
		handle(OPS.projectDetach, input => {
			const chatId = str(input.chatId, "chatId");
			projects.detach(chatId);
			changed();
			return state(chatId);
		}),
		handle(OPS.projectRemove, async input => {
			const id = str(input.id, "id");
			runtime.forget(id);
			if ((await runner.status()) === "running") await containers.destroy(id);
			projects.remove(id, input.deleteFiles === true);
			changed();
			return state(str(input.chatId, "chatId"));
		}),
		handle(OPS.projectRun, async input => {
			const chatId = str(input.chatId, "chatId");
			const command = optStr(input.command, "command");
			const project = attachedTo(chatId);
			return runtime.run(refOf(project), command);
		}),
		handle(OPS.projectStop, input => {
			runtime.stop(attachedTo(str(input.chatId, "chatId")).id);
			return null;
		}),
	];

	// Orphaned project containers from an earlier run (best effort).
	void runner.status().then(s => s === "running" ? containers.reapAll() : undefined).catch(() => {});

	cleanups.push(async () => {
		containers.dispose();
		if ((await runner.status().catch(() => "stopped")) === "running") await containers.reapAll().catch(() => {});
	});
	return cleanups;
}
