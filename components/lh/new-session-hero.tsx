/**
 * Fork chrome: the new-session display heading above the composer.
 * Styled with the host theme tokens; the lh-* classes are hooks for
 * theme plugins.
 */
export function NewSessionHero({ mode }: { mode?: string }) {
	const practice = mode === "practice";
	return (
		<div className="lh-hero mb-7 flex flex-col gap-2.5" data-testid="new-session-hero">
			<span className="lh-hero-kicker text-[13px] text-muted-foreground">{practice ? "Practice" : "Teaching"}</span>
			<h1 className="lh-hero-title m-0 text-[40px] font-semibold leading-[1.08] tracking-[-0.04em] text-foreground">
				What do you want <span className="lh-hero-muted text-muted-foreground/60">{practice ? "to practice?" : "to understand?"}</span>
			</h1>
		</div>
	);
}
