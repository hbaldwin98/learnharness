import type { PluginFrontendContext } from "learnharness-plugin-api";
import { OPS, type CodingSettings, type DockerStatus, type ImageInfo } from "../shared/protocol.ts";

const DOCKER_LABEL: Record<DockerStatus, string> = { running: "Running", stopped: "Installed, not running", missing: "Not installed" };

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/** Settings → Coding: listening, Docker status, and the sandbox images on this machine. */
export function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): () => void {
	const doc = container.ownerDocument;
	const root = doc.createElement("div");
	root.className = "lh-cw-settings";
	const rowsSlot = doc.createElement("div");
	const docker = doc.createElement("div");
	docker.className = "lh-cw-settings__docker";
	root.append(rowsSlot, docker);
	container.append(root);

	let rows: ReturnType<PluginFrontendContext["ui"]["mountSettingsRows"]> | undefined;
	const showRows = (settings: CodingSettings) => {
		const schema = { rows: [{
			key: "listening", type: "toggle" as const, label: "Agent listening",
			description: "While you work on a coding question or problem with the workspace open, the tutor looks in after Runs, quiet stretches, every few minutes, and when you sound stuck. It usually stays quiet.",
			value: settings.listening,
			onChange: async (value: boolean) => { const next = await ctx.call<CodingSettings>(OPS.settingsSet, { listening: value }); showRows(next); },
		}] };
		if (rows) rows.update(schema); else rows = ctx.ui.mountSettingsRows(rowsSlot, schema, { signal });
	};

	const refreshDocker = async () => {
		const status = await ctx.call<DockerStatus>(OPS.dockerStatus);
		const images = status === "running" ? await ctx.call<ImageInfo[]>(OPS.images) : [];
		if (signal.aborted) return;
		const heading = doc.createElement("h3");
		heading.textContent = `Docker: ${DOCKER_LABEL[status]}`;
		const note = doc.createElement("p");
		note.textContent = status === "running"
			? "Sandbox images build on first use of a language (a few minutes) and are kept until removed."
			: "Without Docker, Run is unavailable and Submit runs the tests on this machine without a sandbox.";
		const list = doc.createElement("ul");
		for (const image of images) {
			const li = doc.createElement("li");
			const label = doc.createElement("span");
			label.textContent = `${image.image} · ${size(image.sizeBytes)}${image.current ? "" : " · outdated"}`;
			const slot = doc.createElement("span");
			li.append(label, slot);
			ctx.ui.mountButton(slot, { label: "Remove", size: "xs", variant: "outline", onClick: async () => { await ctx.call(OPS.removeImages, { image: image.image }); await refreshDocker(); } }, { signal });
			list.append(li);
		}
		docker.replaceChildren(heading, note, ...(images.length ? [list] : []));
	};

	void ctx.call<CodingSettings>(OPS.settingsGet).then(settings => { if (!signal.aborted) showRows(settings); }).catch(error => console.error(error));
	void refreshDocker().catch(error => console.error(error));
	return () => { rows?.dispose(); root.remove(); };
}
