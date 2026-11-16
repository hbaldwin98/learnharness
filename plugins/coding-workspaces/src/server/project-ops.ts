import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { MARKERS, OPS, TOPICS, type ProjectsState } from "../shared/protocol.ts";
import type { DockerRunner } from "./docker-runner.ts";
import type { CodeImage } from "./languages.ts";
import { createProjectContainers } from "./project-container.ts";
import { createProjectRuntime } from "./project-runtime.ts";
import { createProjects } from "./projects.ts";
import { createProposals } from "./proposals.ts";
import { createFileNotes } from "./file-notes.ts";
import { readText, walkFiles } from "./project-files.ts";
import { createTerminals } from "./terminals.ts";
import { PROJECT_TASK_INSTRUCTIONS, registerProjectTask } from "./project-task.ts";
import { changesText, createSnapshots, hasGit } from "./snapshots.ts";
import { createProjectTools, PROJECT_INSTRUCTIONS } from "./project-tools.ts";
import { createProjectDiagnostics, problemsText, type ProjectDiagnostics } from "./project-diagnostics.ts";

const obj = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be an object");
	return value as Record<string, unknown>;
};
const str = (value: unknown, name: string): string => {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
};
const optStr = (value: unknown, name: string): string | undefined => value === undefined ? undefined : str(value, name);

const dim = (value: unknown, fallback: number) => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
const sizeOf = (input: Record<string, unknown>) => ({ cols: dim(input.cols, 80), rows: dim(input.rows, 24) });

const refOf =(p: { id: string; image: string; hostPath: string; runCommand: string }) => ({ id: p.id, image: p.image as CodeImage, hostPath: p.hostPath, runCommand: p.runCommand });

/** Project workspaces: registry, containers, Run, and their frontend operations. */
export function registerProjectOps(ctx: PluginBackendContext, runner: DockerRunner) {
	const projects = createProjects({ dataDirectory: ctx.dataDirectory });
	const changed = () => { if (!ctx.signal.aborted) ctx.events.emit(TOPICS.projects, {}); };
	const containers = createProjectContainers(runner, { onIdleRemoved: id => { dropLive(id); changed(); } });
	const servers = new Map<string, ProjectDiagnostics>();
	/** The container is going away: end its shell and language server. */
	const dropLive = (id: string) => {
		terminals.close(id);
		void servers.get(id)?.stop().catch(() => {});
		servers.delete(id);
	};
	/** Check a project with its language server (started on first use). */
	const problems = async (project: { id: string; image: string; hostPath: string; runCommand: string }) => {
		if ((await runner.status()) !== "running") throw new Error("Docker is not running");
		const ref = refOf(project);
		let server = servers.get(project.id);
		if (!server) {
			server = createProjectDiagnostics({ image: ref.image, hostPath: ref.hostPath, spawn: command => containers.spawn(ref, command) });
			servers.set(project.id, server);
		}
		return server.check();
	};
	const terminals = createTerminals({
		container: id => containers.ensure(refOf(projects.get(id))),
		emit: event => { if (!ctx.signal.aborted) ctx.events.emit(TOPICS.terminal, event); },
	});
	const proposals = createProposals(path.join(ctx.dataDirectory, "proposals"));
	const notes = createFileNotes(path.join(ctx.dataDirectory, "file-notes"));
	const runtime = createProjectRuntime({
		runsDirectory: path.join(ctx.dataDirectory, "project-runs"),
		dockerStatus: () => runner.status(),
		containerRunning: id => containers.running(id),
		exec: async (project, command, opts) => {
			await snapshot(project.hostPath, `run: ${command}`);
			return containers.run(project, command, opts);
		},
		stopContainer: id => { dropLive(id); return containers.remove(id); },
		changed,
	});

	/** Snapshot the folder (best effort; git may be missing). */
	async function snapshot(hostPath: string, reason: string): Promise<void> {
		if (!(await hasGit())) return;
		await createSnapshots(hostPath).snapshot(reason).catch(error => console.error("[coding-workspaces] snapshot failed", error));
	}

	/** The tutor's view of the project: what changed since its last look in this chat and the latest run. */
	async function projectTrace(chatId: string, project: { id: string; name: string; hostPath: string }): Promise<string> {
		const parts = [`Project workspace "${project.name}" (mounted at /work in its container).`];
		if (await hasGit()) parts.push(changesText(await createSnapshots(project.hostPath).changesSinceLook(chatId, "look")));
		else parts.push("(git is not installed on the learner's machine, so changes cannot be shown; use the workspace tools to read files.)");
		const last = (await runtime.state(project.id)).runs.at(-1);
		if (last) {
			const outcome = last.error ?? (last.timedOut ? "timed out" : `exit ${last.exitCode}`);
			const output = [last.stdout && `stdout:\n${last.stdout.slice(-4000)}`, last.stderr && `stderr:\n${last.stderr.slice(-4000)}`].filter(Boolean).join("\n");
			parts.push(`Latest run (${last.at}): \`${last.command}\` → ${outcome}\n${output}`);
		}
		return parts.join("\n\n");
	}

	async function state(chatId: string): Promise<ProjectsState> {
		const base = projects.state(chatId);
		return {
			...base,
			runtime: base.attached ? await runtime.state(base.attached.id) : null,
			proposals: base.attached ? proposals.pending(base.attached.id) : [],
			notes: base.attached?.exists ? notes.list(base.attached.id, base.attached.hostPath) : [],
		};
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
			if (image !== undefined && image !== before.image) { dropLive(id); await containers.remove(id); }
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
			proposals.forget(id);
			notes.forget(id);
			dropLive(id);
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
		handle(OPS.projectAsk, async input => {
			const chatId = str(input.chatId, "chatId");
			const question = (optStr(input.text, "text") ?? "").trim();
			const project = attachedTo(chatId);
			const trace = await projectTrace(chatId, project);
			const modelText = `${question ? `The learner asks about their project: ${question}` : "The learner asked for help with their project (no words)."}\n\n${trace}`;
			return ctx.turns.steer(chatId, {
				displayText: question ? `Ask: ${question}` : "Asked for help with the project",
				modelText,
				details: { kind: "project-ask", projectId: project.id, text: question },
				idempotencyKey: `project-ask:${project.id}:${Date.now()}`,
				trigger: "learner",
			});
		}),
		handle(OPS.proposalDecide, async input => {
			const chatId = str(input.chatId, "chatId");
			const project = attachedTo(chatId);
			const accept = input.accept === true;
			const decided = proposals.decide(project.id, project.hostPath, str(input.id, "id"), accept);
			if (decided.status === "accepted") await snapshot(project.hostPath, `accepted proposal for ${decided.path}`);
			const outcome = decided.status === "stale" ? "could not be applied: the learner changed the file after you proposed it" : decided.status;
			// Tell the chat the proposal came from (it may differ from the deciding chat).
			await ctx.markers.append(decided.chatId, {
				typeId: MARKERS.proposal,
				details: { path: decided.path, status: decided.status },
				modelText: `Your proposed change to ${decided.path} was ${outcome}.`,
				idempotencyKey: `proposal:${decided.id}`,
			}).catch(error => console.error("[coding-workspaces] proposal marker failed", error));
			changed();
			return state(chatId);
		}),
		handle(OPS.projectFiles, input => {
			const project = attachedTo(str(input.chatId, "chatId"));
			return walkFiles(project.hostPath);
		}),
		handle(OPS.projectReadFile, input => {
			const project = attachedTo(str(input.chatId, "chatId"));
			const relative = str(input.path, "path");
			return { path: relative, ...readText(project.hostPath, relative) };
		}),
		handle(OPS.noteDismiss, input => {
			const chatId = str(input.chatId, "chatId");
			notes.dismiss(attachedTo(chatId).id, str(input.id, "id"));
			changed();
			return state(chatId);
		}),
		handle(OPS.projectProblems, input => problems(attachedTo(str(input.chatId, "chatId")))),
		handle(OPS.terminalOpen, async input => {
			const project = attachedTo(str(input.chatId, "chatId"));
			if ((await runner.status()) !== "running") throw new Error("Docker is not running");
			const backlog = await terminals.open(project.id, sizeOf(input));
			changed();
			return { projectId: project.id, ...backlog };
		}),
		handle(OPS.terminalWrite, input => {
			terminals.write(attachedTo(str(input.chatId, "chatId")).id, str(input.data, "data"));
			return null;
		}),
		handle(OPS.terminalResize, async input => {
			await terminals.resize(attachedTo(str(input.chatId, "chatId")).id, sizeOf(input));
			return null;
		}),
		handle(OPS.terminalClose, input => {
			terminals.close(attachedTo(str(input.chatId, "chatId")).id);
			return null;
		}),
		handle(OPS.projectStop, input => {
			runtime.stop(attachedTo(str(input.chatId, "chatId")).id);
			return null;
		}),
	];

	cleanups.push(ctx.registerTools({
		agents: ["teacher", "practice"],
		create: context => createProjectTools(context.chatId, {
			forChat: chatId => projects.forChat(chatId),
			changes: async (chatId, project) => (await hasGit())
				? changesText(await createSnapshots(project.hostPath).changesSinceLook(chatId, "look"))
				: "git is not installed on the learner's machine, so changes cannot be shown; read the files instead.",
			run: (project, command) => runtime.run(refOf(project), command),
			problems: async project => problemsText(await problems(project)),
			propose: (chatId, project, input) => {
				const proposal = proposals.propose({ projectId: project.id, root: project.hostPath, chatId, ...input });
				changed();
				return proposal;
			},
			annotate: (chatId, project, input) => {
				const note = notes.add(project.id, project.hostPath, { chatId, ...input });
				changed();
				return note;
			},
		}),
	}));
	cleanups.push(ctx.registerInstructions({ agents: ["teacher", "practice"], text: PROJECT_INSTRUCTIONS }));

	cleanups.push(registerProjectTask(ctx, {
		forChat: chatId => projects.forChat(chatId),
		snapshot: async (project, reason) => (await hasGit()) ? createSnapshots(project.hostPath).snapshot(reason) : null,
		changesStat: async (chatId, project) => (await hasGit())
			? (await createSnapshots(project.hostPath).changesSinceLook(chatId, "task submission")).stat || "(no changes since your last look)"
			: "(git is not installed; changes unavailable)",
		runTask: async (project, input) => {
			if ((await runner.status()) !== "running") throw new Error("Docker is not running, so the project's tests cannot run");
			try { return await containers.runTask(refOf(project), input); }
			finally { changed(); }
		},
	}));
	cleanups.push(ctx.registerInstructions({ agents: ["practice"], text: PROJECT_TASK_INSTRUCTIONS }));

	// Orphaned project containers from an earlier run (best effort).
	void runner.status().then(s => s === "running" ? containers.reapAll() : undefined).catch(() => {});

	cleanups.push(async () => {
		for (const id of [...servers.keys()]) dropLive(id);
		terminals.closeAll();
		containers.dispose();
		if ((await runner.status().catch(() => "stopped")) === "running") await containers.reapAll().catch(() => {});
	});
	return cleanups;
}
