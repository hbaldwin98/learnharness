"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { DownloadIcon, Loader2Icon, Trash2Icon, XIcon } from "lucide-react";
import {
	LOCAL_DICTATION_MODELS, localDictationModel, resolveLocalLanguage,
	type DictationDevice, type DictationEngine, type DictationSettings, type LocalDictationLanguage,
	type LocalDictationModel,
} from "@/src/core";
import { SettingsRow, ThinSelect, Toggle } from "@/components/settings/controls";
import { useDictationSettings } from "@/components/dictation-preference";
import { useDictationActive } from "@/components/dictation-state";
import { localDictationCommand, useLocalDictation, type LocalModelState } from "@/components/local-dictation";
import { cn } from "@/lib/utils";

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/**
 * Settings → Providers → Dictation (engines wave, 2026-10-27): the engine
 * choice, the local models (download / delete / use), the local language,
 * device and VAD, and the cleanup switches shared by both engines.
 * `deepgram` is the Deepgram key row + language, shown for that engine.
 */
export function DictationSettingsGroup({ deepgram, focus }: { deepgram: ReactNode; focus?: boolean }) {
	const { settings, saving, error, save } = useDictationSettings();
	const local = useLocalDictation();
	const active = useDictationActive();
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: "center" }); }, [focus]);

	if (!settings) return <p className="px-1 text-xs text-muted-foreground">Loading…</p>;
	const edit = (patch: (s: DictationSettings) => DictationSettings) => { void save(patch); };
	const editLocal = (patch: NonNullable<DictationSettings["local"]>) =>
		edit((s) => ({ ...s, local: { ...s.local, ...patch } }));
	const locked = active || saving;
	const model = localDictationModel(settings.local.model);
	const language = resolveLocalLanguage(model, settings.local.language);

	return <div ref={ref} className="flex flex-col gap-2" data-testid="dictation-settings">
		<SettingsRow label="Engine" hint={settings.engine === "local" ? "On this computer — nothing leaves it" : "Deepgram's cloud service"} dimmed={active} testid="row-dictation-engine">
			<ThinSelect
				value={settings.engine}
				onChange={(v) => edit((s) => ({ ...s, engine: v as DictationEngine }))}
				ariaLabel="Dictation engine"
				testid="dictation-engine"
				disabled={locked}
			>
				<option value="local">Local</option>
				<option value="deepgram">Deepgram</option>
			</ThinSelect>
		</SettingsRow>

		{settings.engine === "local" ? <>
			{!local.available ? (
				<p className="px-1 text-xs text-muted-foreground/70" data-testid="dictation-local-unavailable">
					Local dictation runs in the desktop app.
				</p>
			) : <>
				<div className="flex flex-col gap-1" data-testid="dictation-models">
					{LOCAL_DICTATION_MODELS.map((m) => (
						<ModelRow
							key={m.id}
							model={m}
							state={local.models[m.id]}
							selected={m.id === settings.local.model}
							locked={locked}
							onUse={() => editLocal({ model: m.id })}
						/>
					))}
				</div>
				<EngineLine />
			</>}
			{model.languages && language && (
				<SettingsRow label="Language" dimmed={active} testid="row-dictation-local-language">
					<ThinSelect
						value={language}
						onChange={(v) => editLocal({ language: v as LocalDictationLanguage })}
						ariaLabel="Local dictation language"
						testid="dictation-local-language"
						disabled={locked}
					>
						{model.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
					</ThinSelect>
				</SettingsRow>
			)}
			<SettingsRow label="Device" hint="Auto uses the GPU when there is one" dimmed={active} testid="row-dictation-device">
				<ThinSelect
					value={settings.local.device}
					onChange={(v) => editLocal({ device: v as DictationDevice })}
					ariaLabel="Dictation device"
					testid="dictation-device"
					disabled={locked}
				>
					<option value="auto">Auto</option>
					<option value="gpu">GPU</option>
					<option value="cpu">CPU</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow label="Voice activity detection" hint="Skip silence before it reaches the model" dimmed={active}>
				<Toggle checked={settings.local.vad} disabled={locked} label="Voice activity detection" onChange={(vad) => editLocal({ vad })} />
			</SettingsRow>
		</> : deepgram}

		<SettingsRow label="Remove filler words" hint="Drops “uh”, “um”, “hmm”…" dimmed={active}>
			<Toggle checked={settings.removeFillerWords} disabled={locked} label="Remove filler words" onChange={(removeFillerWords) => edit((s) => ({ ...s, removeFillerWords }))} />
		</SettingsRow>
		<SettingsRow label="Append trailing space" hint="End each dictation with a space" dimmed={active}>
			<Toggle checked={settings.appendTrailingSpace} disabled={locked} label="Append trailing space" onChange={(appendTrailingSpace) => edit((s) => ({ ...s, appendTrailingSpace }))} />
		</SettingsRow>
		{error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
	</div>;
}

function ModelRow({ model, state, selected, locked, onUse }: {
	model: LocalDictationModel;
	state: LocalModelState | undefined;
	selected: boolean;
	locked: boolean;
	onUse: () => void;
}) {
	const s = state?.state ?? "absent";
	const busy = s === "downloading" || s === "verifying";
	const pct = state && state.total ? Math.floor((state.received / state.total) * 100) : 0;
	const command = (op: "download" | "cancel" | "delete") => { void localDictationCommand({ op, id: model.id }).catch(() => {}); };
	return <div
		data-testid={`dictation-model-${model.id}`}
		className={cn("flex items-center gap-3 rounded-md border px-2.5 py-2", selected ? "border-muted-foreground/60" : "border-border/60")}
	>
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			aria-label={`Use ${model.label}`}
			disabled={locked || selected}
			onClick={onUse}
			className={cn("size-3.5 shrink-0 rounded-full border", selected ? "border-foreground bg-foreground" : "border-muted-foreground", locked && "cursor-not-allowed")}
		/>
		<span className="min-w-0 flex-1">
			<span className="block truncate text-sm text-foreground">{model.label}</span>
			<span className="block text-xs text-muted-foreground/70">
				{model.blurb} · {mb(model.sizeBytes)}
				{s === "downloading" && ` · ${pct}%`}
				{s === "verifying" && " · verifying…"}
				{s === "partial" && ` · paused at ${pct}%`}
				{state?.error && <span className="text-destructive"> · {state.error}</span>}
			</span>
			{busy && <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-muted">
				<span className="block h-full bg-muted-foreground transition-[width]" style={{ width: `${pct}%` }} />
			</span>}
		</span>
		{s === "ready" ? (
			<button type="button" onClick={() => command("delete")} disabled={locked} aria-label={`Delete ${model.label}`} className="text-muted-foreground hover:text-destructive disabled:cursor-not-allowed">
				<Trash2Icon className="size-3.5" />
			</button>
		) : busy ? (
			s === "verifying"
				? <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
				: <button type="button" onClick={() => command("cancel")} aria-label={`Cancel ${model.label} download`} className="text-muted-foreground hover:text-foreground">
					<XIcon className="size-3.5" />
				</button>
		) : (
			<button type="button" onClick={() => command("download")} aria-label={`Download ${model.label}`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
				<DownloadIcon className="size-3.5" />{s === "partial" ? "Resume" : "Download"}
			</button>
		)}
	</div>;
}

/** One quiet line: what the engine is doing right now. */
function EngineLine() {
	const { engine } = useLocalDictation();
	const text =
		engine.state === "loading" ? "Loading the model…" :
		engine.state === "ready" ? `Ready on ${engine.device ?? engine.backend ?? "this computer"}` :
		engine.state === "idle" ? "Unloaded after 10 minutes idle — reloads when you dictate" :
		engine.state === "error" ? engine.error ?? "The engine failed" :
		"Download a model to dictate locally";
	return <p className={cn("px-1 text-xs", engine.state === "error" ? "text-destructive" : "text-muted-foreground/70")} data-testid="dictation-engine-status">
		{text}{engine.gpuFallback && " · running on the CPU (the GPU failed this session)"}
	</p>;
}
