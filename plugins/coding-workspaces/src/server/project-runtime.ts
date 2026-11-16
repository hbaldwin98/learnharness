import fs from "node:fs";
import path from "node:path";
import type { DockerStatus, ProjectRun, ProjectRuntime } from "../shared/protocol.ts";
import type { ExecResult } from "./docker-runner.ts";
import type { ProjectRef } from "./project-container.ts";

const KEEP_RUNS = 10;

export interface ProjectRuntimeDeps {
	/** Where each project's recent runs are kept (one JSON file per project). */
	runsDirectory: string;
	dockerStatus: () => Promise<DockerStatus>;
	containerRunning: (id: string) => Promise<boolean>;
	exec: (project: ProjectRef, command: string, opts: { signal: AbortSignal; onProgress: (line: string) => void }) => Promise<ExecResult>;
	stopContainer: (id: string) => Promise<void>;
	/** A project's runtime changed (push to the frontend). */
	changed: (id: string) => void;
	now?: () => Date;
}

/** Runs of a project's run command: one at a time per project, recent runs persisted. */
export function createProjectRuntime(deps: ProjectRuntimeDeps) {
	const now = deps.now ?? (() => new Date());
	const running = new Map<string, { line: string; abort: AbortController }>();
	const fileOf = (id: string) => path.join(deps.runsDirectory, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
	const loadRuns = (id: string): ProjectRun[] => {
		try { const raw = JSON.parse(fs.readFileSync(fileOf(id), "utf8")); return Array.isArray(raw) ? raw as ProjectRun[] : []; } catch { return []; }
	};
	const saveRun = (id: string, run: ProjectRun) => {
		const runs = [...loadRuns(id), run].slice(-KEEP_RUNS);
		fs.mkdirSync(deps.runsDirectory, { recursive: true });
		const temp = `${fileOf(id)}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(runs));
		fs.renameSync(temp, fileOf(id));
	};

	return {
		async state(id: string): Promise<ProjectRuntime> {
			const docker = await deps.dockerStatus();
			return {
				docker,
				containerRunning: docker === "running" ? await deps.containerRunning(id) : false,
				running: running.get(id)?.line ?? null,
				runs: loadRuns(id),
			};
		},
		/** Run a command (default: the project's run command) in the project's container. */
		async run(project: ProjectRef & { runCommand: string }, command?: string): Promise<ProjectRun> {
			const cmd = (command ?? project.runCommand).trim();
			if (!cmd) throw new Error("Set a run command for this project first");
			if (running.has(project.id)) throw new Error("A run is already in progress");
			const abort = new AbortController();
			const entry = { line: `Running ${cmd}`, abort };
			running.set(project.id, entry);
			deps.changed(project.id);
			const base = { at: now().toISOString(), command: cmd };
			let run: ProjectRun;
			try {
				const docker = await deps.dockerStatus();
				if (docker !== "running") throw new Error(docker === "missing" ? "Docker is not installed" : "Docker is not running");
				const r = await deps.exec(project, cmd, {
					signal: abort.signal,
					onProgress: line => { entry.line = line; deps.changed(project.id); },
				});
				run = { ...base, exitCode: r.code, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stderrTruncated: r.stderrTruncated };
			} catch (error) {
				const message = abort.signal.aborted ? "Stopped" : error instanceof Error ? error.message : String(error);
				run = { ...base, exitCode: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, error: message };
			} finally {
				running.delete(project.id);
			}
			// A timed-out or stopped command may still be running inside: restart the container.
			if (run.timedOut || abort.signal.aborted) await deps.stopContainer(project.id).catch(() => {});
			saveRun(project.id, run);
			deps.changed(project.id);
			return run;
		},
		/** Stop the in-progress run, if any. */
		stop(id: string): void { running.get(id)?.abort.abort(); },
		forget(id: string): void { running.get(id)?.abort.abort(); fs.rmSync(fileOf(id), { force: true }); },
	};
}

export type ProjectRuntimeService = ReturnType<typeof createProjectRuntime>;
