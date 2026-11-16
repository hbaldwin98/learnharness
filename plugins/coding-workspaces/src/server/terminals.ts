/**
 * PROJECT TERMINALS: one interactive shell per project, a TTY `docker exec` in the
 * project's container (cwd /work). Output streams to the frontend as events and is
 * kept in a bounded backlog so a reopened pane (or another session on the same
 * project) sees recent output. The shell ends with the container (idle reap, image
 * change) or when the learner closes it.
 */

import type { Duplex } from "node:stream";
import type Docker from "dockerode";

export const BACKLOG_BYTES = 128 * 1024;
const SHELL = "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi";

export interface TerminalEvent {
	projectId: string;
	/** Output chunk (UTF-8 text). */
	data?: string;
	/** The shell ended. */
	exited?: boolean;
}

interface Session {
	stream: Duplex;
	exec: Docker.Exec;
	backlog: string;
}

/** Keep the tail of `text` within `max` characters. */
export const trimBacklog = (text: string, max = BACKLOG_BYTES) => text.length > max ? text.slice(text.length - max) : text;

export function createTerminals(deps: {
	container: (projectId: string) => Promise<Docker.Container>;
	emit: (event: TerminalEvent) => void;
}) {
	const sessions = new Map<string, Session>();
	const opening = new Map<string, Promise<Session>>();

	async function start(projectId: string, size: { cols: number; rows: number }): Promise<Session> {
		const container = await deps.container(projectId);
		const exec = await container.exec({
			Cmd: ["sh", "-c", SHELL],
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
			Tty: true,
			WorkingDir: "/work",
			Env: ["TERM=xterm-256color"],
		});
		const stream = await exec.start({ hijack: true, stdin: true });
		const session: Session = { stream, exec, backlog: "" };
		stream.setEncoding?.("utf8");
		stream.on("data", (chunk: string | Buffer) => {
			const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			session.backlog = trimBacklog(session.backlog + data);
			deps.emit({ projectId, data });
		});
		const ended = () => {
			if (sessions.get(projectId) !== session) return;
			sessions.delete(projectId);
			deps.emit({ projectId, exited: true });
		};
		stream.on("end", ended);
		stream.on("close", ended);
		stream.on("error", ended);
		await exec.resize({ h: size.rows, w: size.cols }).catch(() => {});
		sessions.set(projectId, session);
		return session;
	}

	return {
		/** Open (or join) the project's shell; returns the recent output to replay. */
		async open(projectId: string, size: { cols: number; rows: number }): Promise<{ backlog: string }> {
			const existing = sessions.get(projectId);
			if (existing) return { backlog: existing.backlog };
			let pending = opening.get(projectId);
			if (!pending) {
				pending = start(projectId, size).finally(() => opening.delete(projectId));
				opening.set(projectId, pending);
			}
			const session = await pending;
			return { backlog: session.backlog };
		},
		write(projectId: string, data: string): void {
			const session = sessions.get(projectId);
			if (!session) throw new Error("The terminal is not open");
			session.stream.write(data);
		},
		async resize(projectId: string, size: { cols: number; rows: number }): Promise<void> {
			await sessions.get(projectId)?.exec.resize({ h: size.rows, w: size.cols }).catch(() => {});
		},
		isOpen: (projectId: string) => sessions.has(projectId),
		close(projectId: string): void {
			const session = sessions.get(projectId);
			if (!session) return;
			sessions.delete(projectId);
			session.stream.destroy();
			deps.emit({ projectId, exited: true });
		},
		closeAll(): void { for (const id of [...sessions.keys()]) this.close(id); },
	};
}

export type Terminals = ReturnType<typeof createTerminals>;
