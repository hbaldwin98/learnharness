/**
 * Graphite top-bar breadcrumb (fork-owned; see docs/graphite-plan.md).
 * Upstream's chat bar mounts these beside its editable title; the title's
 * own size is shrunk by app/theme/graphite.css.
 */

/** "Teaching /" or "Practice /" before the session name. */
export function BreadcrumbPrefix({ kind }: { kind?: string | null }) {
	return (
		<span className="lh-crumb-prefix flex shrink-0 items-center gap-2" aria-hidden="true">
			<span className="lh-crumb-section">{kind === "practice" ? "Practice" : "Teaching"}</span>
			<span className="lh-crumb-sep">/</span>
		</span>
	);
}

/** One status pill after the name: a waiting probe, or a turn in flight. */
export function StatusPill({ probing, working }: { probing: boolean; working: boolean }) {
	const label = probing ? "Probing" : working ? "Working" : null;
	if (!label) return null;
	return (
		<span className="lh-status-pill" data-state={probing ? "probing" : "working"}>
			<span className="lh-status-dot" aria-hidden="true" />
			{label}
		</span>
	);
}
