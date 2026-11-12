/**
 * Fork chrome: the session top-bar breadcrumb and status pill. Upstream's
 * chat bar mounts these beside its editable title. Styled with the host
 * theme tokens; the lh-* classes are hooks for theme plugins.
 */

/** "Teaching /" or "Practice /" before the session name. */
export function BreadcrumbPrefix({ kind }: { kind?: string | null }) {
	return (
		<span className="lh-crumb-prefix flex shrink-0 items-center gap-2 text-[13px]" aria-hidden="true">
			<span className="lh-crumb-section text-muted-foreground">{kind === "practice" ? "Practice" : "Teaching"}</span>
			<span className="lh-crumb-sep text-muted-foreground/50">/</span>
		</span>
	);
}

/** One status pill after the name: a waiting probe, or a turn in flight. */
export function StatusPill({ probing, working }: { probing: boolean; working: boolean }) {
	const label = probing ? "Probing" : working ? "Working" : null;
	if (!label) return null;
	return (
		<span
			className={`lh-status-pill inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium ${probing ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
			data-state={probing ? "probing" : "working"}
		>
			<span className={`lh-status-dot size-1.5 rounded-full ${probing ? "bg-primary" : "bg-muted-foreground"}`} aria-hidden="true" />
			{label}
		</span>
	);
}
