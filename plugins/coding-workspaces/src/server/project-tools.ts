import { Type } from "typebox";
import type { PluginTools } from "learnharness-plugin-api";
import type { EditProposal, FileNote, ProjectInfo, ProjectRun } from "../shared/protocol.ts";
import { numbered, readText, walkFiles } from "./project-files.ts";

type Tool = ReturnType<PluginTools["create"]>[number];

export interface ProjectToolDeps {
	forChat(chatId: string): ProjectInfo | null;
	/** Changes since the tutor's last look in the chat, as text for the model. */
	changes(chatId: string, project: ProjectInfo): Promise<string>;
	run(project: ProjectInfo, command: string): Promise<ProjectRun>;
	propose(chatId: string, project: ProjectInfo, input: { path: string; explanation: string; content?: string; replacements?: Array<{ find: string; replace: string }> }): EditProposal;
	annotate(chatId: string, project: ProjectInfo, input: { path: string; line: number; endLine?: number; note: string }): FileNote;
}

const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });

export function runText(run: ProjectRun): string {
	if (run.error) return `Could not run \`${run.command}\`: ${run.error}`;
	const outcome = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
	const stream = (label: string, s: string, cut: boolean) => s ? `\n${label}:\n${s}${cut ? "\n… (truncated)" : ""}` : "";
	return `\`${run.command}\` → ${outcome}${stream("stdout", run.stdout, run.stdoutTruncated)}${stream("stderr", run.stderr, run.stderrTruncated)}`;
}

export const PROJECT_INSTRUCTIONS = [
	"# Project workspaces",
	"A session may have a project workspace attached: a folder on the learner's machine that they build in over many turns and sessions, with their own editor. " +
		"It is mounted at /work in a long-lived Linux container (their language image, network on, HOME persists). " +
		"Use project_files and project_read to look at it, project_annotate to point at lines, project_changes to see what they changed since you last looked, and project_run to run a command in /work (the learner sees every run).",
	"- The learner builds it. Do not write their code for them: point, ask, and suggest. When a change from you is genuinely warranted (scaffolding they asked for, a fix after they understand it), propose it with project_propose_edit — they accept or reject it.",
	"- Teach toward the project: each step should leave it working and a little further along. Prefer small, runnable increments.",
	"- Their Ask includes the changes since your last look and the latest run; you do not need to fetch those again.",
].join("\n");

export function createProjectTools(chatId: string, deps: ProjectToolDeps): Tool[] {
	const attached = () => {
		const p = deps.forChat(chatId);
		if (!p) throw new Error("This session has no project workspace attached. The learner can create or attach one in the Coding pane.");
		if (!p.exists) throw new Error(`The project folder is missing on disk (${p.hostPath}).`);
		return p;
	};
	return [
		{
			name: "project_files",
			label: "list project files",
			description: "List the files in the learner's project workspace (relative to /work; dependency and build folders are skipped).",
			parameters: Type.Object({ under: Type.Optional(Type.String({ description: "A subfolder to list, relative to the project root." })) }),
			executionMode: "parallel",
			execute: async (_id: string, params: unknown) => {
				const p = attached();
				const { files, truncated } = walkFiles(p.hostPath, (params as { under?: string }).under ?? "");
				return text(files.length ? `${files.join("\n")}${truncated ? "\n… (more files not listed)" : ""}` : "(no files)", { count: files.length });
			},
		},
		{
			name: "project_read",
			label: "read project file",
			description: "Read a text file from the learner's project workspace, with line numbers. Optionally a line range.",
			parameters: Type.Object({
				path: Type.String({ description: "REQUIRED — path relative to the project root (or under /work)." }),
				startLine: Type.Optional(Type.Integer({ minimum: 1 })),
				endLine: Type.Optional(Type.Integer({ minimum: 1 })),
			}),
			executionMode: "parallel",
			execute: async (_id: string, params: unknown) => {
				const input = params as { path: string; startLine?: number; endLine?: number };
				const p = attached();
				const file = readText(p.hostPath, input.path);
				const lines = file.content.split("\n");
				const start = Math.max(1, input.startLine ?? 1);
				const end = Math.min(lines.length, input.endLine ?? lines.length);
				const body = numbered(lines.slice(start - 1, end).join("\n"), start);
				return text(`${input.path} (${lines.length} lines${file.truncated ? `, first ${file.content.length} bytes of ${file.size}` : ""})\n${body}`, { path: input.path });
			},
		},
		{
			name: "project_changes",
			label: "project changes",
			description: "What the learner changed in the project since you last looked in this session (a diff), then marks it seen.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				const p = attached();
				return text(await deps.changes(chatId, p));
			},
		},
		{
			name: "project_run",
			label: "run in project",
			description: "Run a shell command in /work in the project's container (5 minute limit, output capped). The learner sees the run in their Coding pane. Use it to check behaviour, never to change their code.",
			parameters: Type.Object({ command: Type.String({ description: "REQUIRED — the shell command, e.g. `npm test` or `python3 -m pytest -q`." }) }),
			executionMode: "sequential",
			execute: async (_id: string, params: unknown) => {
				const p = attached();
				const run = await deps.run(p, (params as { command: string }).command);
				return text(runText(run), { run });
			},
		},
		{
			name: "project_annotate",
			label: "note on a project file",
			description: "Pin a short note to lines of a file in the learner's project (\"look at this loop bound\"). It does not change the file. The note follows its lines as they edit and goes outdated if they delete them. Line numbers are of the file as it is now (read it first).",
			parameters: Type.Object({
				path: Type.String({ description: "REQUIRED — file path relative to the project root." }),
				line: Type.Integer({ minimum: 1, description: "REQUIRED — the first line (1-based)." }),
				endLine: Type.Optional(Type.Integer({ minimum: 1, description: "The last line (inclusive); omit for one line." })),
				note: Type.String({ description: "REQUIRED — one or two short sentences pointing at what to look at. Never the fix itself." }),
			}),
			executionMode: "sequential",
			execute: async (_id: string, params: unknown) => {
				const input = params as { path: string; line: number; endLine?: number; note: string };
				const note = deps.annotate(chatId, attached(), input);
				return text(`Noted ${note.path}:${note.line}${note.endLine > note.line ? `–${note.endLine}` : ""}. The learner sees it in the Coding pane.`, { note });
			},
		},
		{
			name: "project_propose_edit",
			label: "propose a change",
			description: "Propose a change to one file in the learner's project (or a new file). Nothing is written: the learner sees the diff and your explanation, and accepts or rejects it; you are told which. " +
				"Give either `replacements` (exact text to find, each occurring once, and its replacement) for an existing file, or `content` (the whole file) for a new or rewritten file. Use sparingly — the learner should write most of the code.",
			parameters: Type.Object({
				path: Type.String({ description: "REQUIRED — file path relative to the project root." }),
				explanation: Type.String({ description: "REQUIRED — one or two sentences on what the change does and why." }),
				replacements: Type.Optional(Type.Array(Type.Object({ find: Type.String(), replace: Type.String() }))),
				content: Type.Optional(Type.String({ description: "The complete new file content." })),
			}),
			executionMode: "sequential",
			execute: async (_id: string, params: unknown) => {
				const input = params as { path: string; explanation: string; content?: string; replacements?: Array<{ find: string; replace: string }> };
				const p = attached();
				const proposal = deps.propose(chatId, p, input);
				return text(`Proposed a change to ${proposal.path}; it is waiting for the learner to accept or reject it.`, { proposal: { id: proposal.id, path: proposal.path, explanation: proposal.explanation, diff: proposal.diff } });
			},
		},
	];
}
