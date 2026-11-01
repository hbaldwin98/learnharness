"use client";

/**
 * THE CODE WORKSPACE PANE (practice workspaces, plan step 3): the coding
 * problem's working surface beside the transcript — the starter files to
 * edit (contents only; owner ruling), the visible tests read-only, Run
 * (visible tests, nothing goes to the agent) and Submit (every test,
 * hidden as counts; tells the agent). The thinking dock stays the talk
 * channel.
 *
 * Trust: the server owns the files (autosaved, debounced) and the tests;
 * Run, Submit and the thinking snapshot read from its store, so each one
 * flushes the pending save first (flush.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, PlayIcon, SendIcon, XIcon, LockIcon } from "lucide-react";
import {
	bindingForAction,
	formatBinding,
	kbdEventForAction,
	type CodeDiagnostic,
	type CodeFile,
	type DiagnosticsSnapshot,
	type WorkspaceRunResult,
	type WorkspaceState,
} from "@/src/core";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { registerWorkspaceFlush } from "@/components/workspaces/flush";
import { setVimEnabled, useVimEnabled } from "@/components/workspaces/vim-preference";
import type { WorkspaceProps } from "@/components/workspaces/registry";
import { CodeEditor } from "./editor";

const LANGUAGE_LABEL: Record<string, string> = {
	javascript: "JavaScript",
	typescript: "TypeScript",
	python: "Python",
	csharp: "C#",
	java: "Java",
	go: "Go",
	rust: "Rust",
	cpp: "C++",
};

/** How long typing settles before the files save (and the language server
 *  sees them — plan step 4 cut it from 600 ms). */
const SAVE_DEBOUNCE_MS = 400;

const url = (chatId: string, callId: string) =>
	`/api/workspaces/${encodeURIComponent(chatId)}/${encodeURIComponent(callId)}`;

async function readError(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `${res.status} ${res.statusText}`;
}

export function CodeWorkspace({ chatId, problemCallId, busy, onSubmitted, onHide }: WorkspaceProps) {
	const [state, setState] = useState<WorkspaceState | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [activePath, setActivePath] = useState<string | null>(null);
	const [running, setRunning] = useState<"run" | "submit" | null>(null);
	const [result, setResult] = useState<WorkspaceRunResult | null>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const vimMode = useVimEnabled();
	const diagnostics = useDiagnostics(chatId, problemCallId, state !== null);

	// The live files (the editors own their documents; this mirrors them for
	// saving) and the save machinery.
	const filesRef = useRef<CodeFile[]>([]);
	const dirtyRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inflightRef = useRef<Promise<void> | null>(null);

	useEffect(() => {
		let alive = true;
		setState(null);
		setLoadError(null);
		fetch(url(chatId, problemCallId))
			.then(async (res) => {
				if (!res.ok) throw new Error(await readError(res));
				return (await res.json()) as WorkspaceState;
			})
			.then((s) => {
				if (!alive) return;
				filesRef.current = s.files.map((f) => ({ ...f }));
				setState(s);
				setActivePath(s.files[0]?.path ?? s.visibleTests[0]?.path ?? null);
				setResult(s.lastSubmit && (!s.lastRun || s.lastSubmit.at > s.lastRun.at) ? s.lastSubmit : s.lastRun);
			})
			.catch((err: Error) => {
				if (alive) setLoadError(err.message);
			});
		return () => {
			alive = false;
		};
	}, [chatId, problemCallId]);

	const save = useCallback(async (): Promise<void> => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		// Chain behind an in-flight save so the last write wins in order.
		await inflightRef.current?.catch(() => {});
		if (!dirtyRef.current) return;
		dirtyRef.current = false;
		const body = JSON.stringify({ files: filesRef.current });
		const p = fetch(url(chatId, problemCallId), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body,
		}).then(async (res) => {
			if (!res.ok) {
				dirtyRef.current = true;
				throw new Error(await readError(res));
			}
			setSaveError(null);
		});
		inflightRef.current = p;
		try {
			await p;
		} catch (err) {
			setSaveError((err as Error).message);
			throw err;
		} finally {
			if (inflightRef.current === p) inflightRef.current = null;
		}
	}, [chatId, problemCallId]);

	// The flush others await (thinking, Run, Submit), and a last save when
	// the pane goes away.
	useEffect(() => registerWorkspaceFlush(problemCallId, save), [problemCallId, save]);
	useEffect(
		() => () => {
			if (dirtyRef.current) void save().catch(() => {});
		},
		[save],
	);

	const onEdit = useCallback(
		(path: string, content: string) => {
			filesRef.current = filesRef.current.map((f) => (f.path === path ? { path, content } : f));
			dirtyRef.current = true;
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => void save().catch(() => {}), SAVE_DEBOUNCE_MS);
		},
		[save],
	);

	const run = useCallback(
		async (mode: "run" | "submit") => {
			if (running || !state?.active) return;
			if (mode === "submit" && busy) return;
			setRunning(mode);
			setRunError(null);
			try {
				await save();
				const res = await fetch(`${url(chatId, problemCallId)}/run`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode }),
				});
				if (!res.ok) throw new Error(await readError(res));
				const r = (await res.json()) as WorkspaceRunResult;
				setResult(r);
				if (mode === "submit") onSubmitted(problemCallId);
			} catch (err) {
				setRunError((err as Error).message);
			} finally {
				setRunning(null);
			}
		},
		[busy, chatId, onSubmitted, problemCallId, running, save, state?.active],
	);

	// The hotkeys (registry actions; rebindable).
	const runRef = useRef(run);
	runRef.current = run;
	useEffect(() => {
		const onRun = () => void runRef.current("run");
		const onSubmit = () => void runRef.current("submit");
		window.addEventListener(kbdEventForAction("workspace-run"), onRun);
		window.addEventListener(kbdEventForAction("workspace-submit"), onSubmit);
		return () => {
			window.removeEventListener(kbdEventForAction("workspace-run"), onRun);
			window.removeEventListener(kbdEventForAction("workspace-submit"), onSubmit);
		};
	}, []);

	if (loadError) {
		return (
			<Shell onHide={onHide} title="Coding">
				<p role="alert" className="p-4 text-sm text-destructive">
					Couldn&apos;t load the workspace: {loadError}
				</p>
			</Shell>
		);
	}
	if (!state) {
		return (
			<Shell onHide={onHide} title="Coding">
				<div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
					<LoaderCircleIcon className="size-4 animate-spin" /> Loading…
				</div>
			</Shell>
		);
	}

	const tabs = [
		...state.files.map((f) => ({ file: f, readOnly: false })),
		...state.visibleTests.map((f) => ({ file: f, readOnly: true })),
	];
	const runKey = formatBinding(bindingForAction("workspace-run"));
	const submitKey = formatBinding(bindingForAction("workspace-submit"));

	return (
		<Shell
			onHide={onHide}
			title={`Coding · ${LANGUAGE_LABEL[state.language] ?? state.language}`}
			actions={
				<>
					<button
						type="button"
						data-testid="workspace-vim-toggle"
						aria-pressed={vimMode}
						onClick={() => setVimEnabled(!vimMode)}
						className={cn(
							"rounded-md px-1.5 py-0.5 font-mono text-xs transition-colors",
							vimMode ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
						title="Vim mode (also in Settings → Keyboard)"
					>
						VIM
					</button>
					<Button
						size="xs"
						variant="outline"
						data-testid="workspace-run"
						disabled={!state.active || running !== null}
						onClick={() => void run("run")}
						title={`Run the visible tests (${runKey})`}
					>
						{running === "run" ? <LoaderCircleIcon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
						Run
					</Button>
					<Button
						size="xs"
						data-testid="workspace-submit"
						disabled={!state.active || running !== null || busy}
						onClick={() => void run("submit")}
						title={busy ? "Wait for the agent to finish" : `Run every test and send it to the agent (${submitKey})`}
					>
						{running === "submit" ? <LoaderCircleIcon className="size-3 animate-spin" /> : <SendIcon className="size-3" />}
						Submit
					</Button>
				</>
			}
		>
			<div role="tablist" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border/70 px-2">
				{tabs.map(({ file, readOnly }) => (
					<button
						key={file.path}
						type="button"
						role="tab"
						aria-selected={activePath === file.path}
						data-testid={`workspace-tab-${file.path}`}
						onClick={() => setActivePath(file.path)}
						className={cn(
							"flex shrink-0 items-center gap-1 border-b-2 px-2 py-1.5 font-mono text-xs transition-colors",
							activePath === file.path
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{readOnly && <LockIcon className="size-3" aria-label="read-only" />}
						{file.path}
						<ProblemDot list={diagnostics?.files[file.path]} />
					</button>
				))}
			</div>
			<div className="relative min-h-0 flex-1">
				{tabs.map(({ file, readOnly }) => (
					<div key={file.path} className={cn("absolute inset-0", activePath !== file.path && "hidden")}>
						<CodeEditor
							path={file.path}
							initial={file.content}
							readOnly={readOnly || !state.active}
							vimMode={vimMode}
							onChange={readOnly ? undefined : (content) => onEdit(file.path, content)}
							diagnostics={diagnostics?.files[file.path]}
						/>
					</div>
				))}
			</div>
			<ServerStatus snapshot={diagnostics} />
			{saveError && (
				<p role="alert" className="shrink-0 border-t border-border/70 px-3 py-1 text-xs text-destructive">
					Not saved: {saveError}
				</p>
			)}
			<ResultPanel result={result} running={running} error={runError} />
		</Shell>
	);
}

function Shell({
	title,
	actions,
	onHide,
	children,
}: {
	title: string;
	actions?: React.ReactNode;
	onHide?: () => void;
	children: React.ReactNode;
}) {
	return (
		<div data-testid="code-workspace" className="flex h-full min-h-0 flex-col bg-background">
			{/* The session top bar's mechanics (top-bar.tsx): h-15 so the border
			    continues the session header's line, a window-drag band, and the
			    window-controls gutter — on Windows/Linux the native buttons sit
			    over this pane's top-right corner. */}
			<div className="lh-drag lh-wco-gutter flex h-15 shrink-0 select-none items-center gap-2 border-b border-border px-3">
				<span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
				<span className="ml-auto flex items-center gap-1.5">{actions}</span>
				{onHide && (
					<button
						type="button"
						onClick={onHide}
						aria-label="Back to the transcript"
						data-testid="workspace-hide"
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
					>
						<XIcon className="size-4" />
					</button>
				)}
			</div>
			{children}
		</div>
	);
}

function ResultPanel({
	result,
	running,
	error,
}: {
	result: WorkspaceRunResult | null;
	running: "run" | "submit" | null;
	error: string | null;
}) {
	let body: React.ReactNode;
	if (running) {
		body = (
			<div className="flex items-center gap-2 text-muted-foreground">
				<LoaderCircleIcon className="size-3.5 animate-spin" />
				{running === "run" ? "Running the visible tests…" : "Running every test…"}
			</div>
		);
	} else if (error) {
		body = (
			<p role="alert" className="text-destructive">
				{error}
			</p>
		);
	} else if (!result) {
		body = <p className="text-muted-foreground">Run the visible tests to see results here.</p>;
	} else {
		const passed = result.visible.filter((t) => t.status === "pass").length;
		const buildFailed = result.phase === "build" && !result.ok;
		body = (
			<div className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{result.mode === "submit" ? "Submitted" : "Run"}
					<span
						className={cn(
							"rounded px-1.5 py-0.5",
							result.ok ? "bg-green-500/15 text-green-500" : "bg-red-500/15 text-red-500",
						)}
					>
						{buildFailed
							? result.timedOut
								? "Build timed out"
								: "Build failed"
							: `${passed}/${result.visible.length} visible`}
					</span>
					{result.hidden && (
						<span
							className={cn(
								"rounded px-1.5 py-0.5",
								result.hidden.passed === result.hidden.total
									? "bg-green-500/15 text-green-500"
									: "bg-red-500/15 text-red-500",
							)}
						>
							{result.hidden.passed}/{result.hidden.total} hidden
						</span>
					)}
					{result.timedOut && !buildFailed && <span className="normal-case tracking-normal">timed out</span>}
				</div>
				{!buildFailed && (
					<ul className="flex flex-col gap-1 font-mono text-xs">
						{result.visible.map((t) => (
							<li key={t.name}>
								<span className={t.status === "pass" ? "text-green-500" : "text-red-500"}>
									{t.status === "pass" ? "✓" : "✗"}
								</span>{" "}
								{t.name}
								{t.message && t.status !== "pass" && (
									<pre className="mt-0.5 whitespace-pre-wrap pl-4 text-muted-foreground">{t.message}</pre>
								)}
							</li>
						))}
					</ul>
				)}
				{result.output && (buildFailed || result.visible.length === 0 || !result.ok) && (
					<pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{result.output}</pre>
				)}
			</div>
		);
	}
	return (
		<div data-testid="workspace-results" className="max-h-[40%] shrink-0 overflow-y-auto border-t border-border/70 px-3 py-2 text-sm">
			{body}
		</div>
	);
}

/** The problem's language-server diagnostics (plan step 4): fetched once
 *  the workspace has loaded (the load starts the server) and again on each
 *  workspace-diagnostics bus event for this problem — one fetch in flight,
 *  one more queued behind it. */
function useDiagnostics(chatId: string, problemCallId: string, loaded: boolean): DiagnosticsSnapshot | null {
	const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
	const inflight = useRef(false);
	const again = useRef(false);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const refetch = useCallback(() => {
		if (inflight.current) {
			again.current = true;
			return;
		}
		inflight.current = true;
		void fetch(`${url(chatId, problemCallId)}/diagnostics`)
			.then((res) => (res.ok ? (res.json() as Promise<DiagnosticsSnapshot>) : null))
			.then((s) => {
				if (s && alive.current) setSnapshot(s);
			})
			.catch(() => {})
			.finally(() => {
				inflight.current = false;
				if (again.current) {
					again.current = false;
					refetch();
				}
			});
	}, [chatId, problemCallId]);

	useEffect(() => {
		if (loaded) refetch();
	}, [loaded, refetch]);
	useServerEvent("workspace-diagnostics", (p) => {
		if (p.chatId === chatId && p.problemCallId === problemCallId) refetch();
	});
	return snapshot;
}

/** A tab's marker: red for errors, amber for warnings only. */
function ProblemDot({ list }: { list: readonly CodeDiagnostic[] | undefined }) {
	if (!list || list.length === 0) return null;
	const errors = list.filter((d) => d.severity === "error").length;
	const warnings = list.length - errors;
	return (
		<span
			data-testid="workspace-tab-problems"
			title={[errors && `${errors} error${errors === 1 ? "" : "s"}`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean).join(", ")}
			className={cn("size-1.5 rounded-full", errors > 0 ? "bg-red-500" : "bg-amber-500")}
		/>
	);
}

/** The quiet line under the editor while the server isn't ready. */
function ServerStatus({ snapshot }: { snapshot: DiagnosticsSnapshot | null }) {
	if (!snapshot || snapshot.status === "ready" || snapshot.status === "unavailable") return null;
	return (
		<div data-testid="workspace-lsp-status" className="flex shrink-0 items-center gap-1.5 border-t border-border/70 px-3 py-1 text-xs text-muted-foreground">
			{snapshot.status === "starting" ? (
				<>
					<LoaderCircleIcon className="size-3 animate-spin" />
					Starting the {snapshot.name} language server…
				</>
			) : (
				<>Error checking stopped: the {snapshot.name} language server crashed. Reopen the workspace to restart it.</>
			)}
		</div>
	);
}
