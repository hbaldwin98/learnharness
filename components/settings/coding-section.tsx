"use client";

/**
 * SETTINGS → CODING (practice workspaces, plan steps 6 and 8): the coding
 * workspace's own section (owner ruling: its own section, not a row in the
 * Tools list, whose toggles filter the teaching registry only) — the
 * default language, Listening, and Docker with its images.
 */

import { useCallback, useEffect, useState } from "react";
import type { AgentSettings } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

/** The coding languages, as the learner sees them (ids match the module's). */
export const CODING_LANGUAGE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "python", label: "Python" },
	{ id: "javascript", label: "JavaScript" },
	{ id: "typescript", label: "TypeScript" },
	{ id: "java", label: "Java" },
	{ id: "csharp", label: "C#" },
	{ id: "go", label: "Go" },
	{ id: "rust", label: "Rust" },
	{ id: "cpp", label: "C++" },
];

/** Which languages each image serves (for the images list). */
const IMAGE_LANGUAGES: Record<string, string> = {
	node: "JavaScript, TypeScript",
	python: "Python",
	dotnet: "C#",
	java: "Java",
	go: "Go",
	rust: "Rust",
	cpp: "C++",
};

/** Compose the listening switch into the agent section (absent = ON; the
 *  write is explicit either way). Pure — exported for tests. */
export function composeListening(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, listening: { enabled: on } };
}

/** Compose the lessons' coding-exercise switch (plan step 9): the
 *  agent.tools key `coding_exercise` (absent = ON). Pure. */
export function composeCodingExercises(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, coding_exercise: on } };
}

/** Compose the default coding language ("" = the agent chooses). Pure. */
export function composeCodingLanguage(agent: AgentSettings | undefined, id: string): AgentSettings {
	const next = { ...agent };
	if (id) next.codingLanguage = id;
	else delete next.codingLanguage;
	return next;
}

interface DockerInfo {
	status: "running" | "stopped" | "missing";
	images: Array<{ image: string; tag: string; sizeBytes: number; current: boolean }>;
}

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function CodingSection({
	agent,
	onAgentChange,
}: {
	agent: AgentSettings | undefined;
	onAgentChange: (next: AgentSettings) => void;
}) {
	const on = agent?.listening?.enabled ?? true;
	return (
		<>
			<SettingsRow label="Default language" hint="Coding problems use it unless you ask for another" testid="coding-language-row">
				<ThinSelect
					value={agent?.codingLanguage ?? ""}
					ariaLabel="default coding language"
					testid="coding-language"
					onChange={(id) => onAgentChange(composeCodingLanguage(agent, id))}
				>
					<option value="">Agent chooses</option>
					{CODING_LANGUAGE_OPTIONS.map((l) => (
						<option key={l.id} value={l.id}>
							{l.label}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Listening"
				hint="While you work a coding problem, the agent looks in after a Run, a quiet stretch, every few minutes, or when you sound stuck — and speaks only if it helps. Each look is a model turn."
				testid="coding-listening-row"
			>
				<Toggle checked={on} label="listening" onChange={(next) => onAgentChange(composeListening(agent, next))} />
			</SettingsRow>
			<SettingsRow
				label="Exercises in lessons"
				hint="The teacher can give you a coding exercise mid-lesson, worked in the same workspace"
				testid="coding-exercises-row"
			>
				<Toggle
					checked={agent?.tools?.coding_exercise !== false}
					label="coding exercises in lessons"
					onChange={(next) => onAgentChange(composeCodingExercises(agent, next))}
				/>
			</SettingsRow>
			<DockerGroup />
		</>
	);
}

/** Docker's state and the coding images, with removal. */
function DockerGroup() {
	const [info, setInfo] = useState<DockerInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		void fetch("/api/workspaces/docker")
			.then((r) => (r.ok ? (r.json() as Promise<DockerInfo>) : null))
			.then((d) => d && setInfo(d))
			.catch(() => {});
	}, []);
	useEffect(load, [load]);
	const remove = async (which: string) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/workspaces/docker", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ remove: which }),
			});
			const body = (await res.json().catch(() => null)) as (DockerInfo & { error?: string }) | null;
			if (!res.ok || !body) throw new Error(body?.error ?? `${res.status}`);
			setInfo(body);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const status = info?.status;
	const total = (info?.images ?? []).reduce((n, i) => n + i.sizeBytes, 0);
	return (
		<SettingsGroup label="Docker" testid="group-coding-docker">
			<SettingsRow
				label="Status"
				hint={
					status === "running"
						? "Coding problems run in sandboxed containers on this machine"
						: status === "stopped"
							? "Start Docker Desktop to use coding problems"
							: status === "missing"
								? "Install Docker Desktop to use coding problems"
								: "Checking…"
				}
				testid="coding-docker-status"
			>
				<span className="font-mono text-xs text-muted-foreground">{status ?? "…"}</span>
			</SettingsRow>
			{status === "running" && (
				<>
					{(info?.images ?? []).length === 0 ? (
						<p className="py-1 text-xs text-muted-foreground">No coding images yet — each language builds its own on first use.</p>
					) : (
						<ul data-testid="coding-images" className="flex flex-col gap-1 py-1">
							{info!.images.map((i) => (
								<li key={i.tag} className="flex items-center gap-3 text-xs">
									<span className="min-w-0 flex-1">
										<span className="text-foreground">{IMAGE_LANGUAGES[i.image] ?? i.image}</span>
										<span className="ml-2 font-mono text-muted-foreground">
											{formatSize(i.sizeBytes)}
											{!i.current && " · outdated"}
										</span>
									</span>
									<button
										type="button"
										disabled={busy}
										onClick={() => void remove(i.image)}
										className="text-muted-foreground hover:text-foreground disabled:opacity-50"
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					)}
					{(info?.images ?? []).length > 0 && (
						<SettingsRow label="Remove all images" hint={`${formatSize(total)} — they rebuild on first use`} testid="coding-remove-all">
							<button
								type="button"
								disabled={busy}
								onClick={() => void remove("all")}
								className="rounded-sm border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
							>
								Remove all
							</button>
						</SettingsRow>
					)}
					{error && <p className="text-xs text-destructive">{error}</p>}
				</>
			)}
		</SettingsGroup>
	);
}
