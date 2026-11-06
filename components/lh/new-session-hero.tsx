/**
 * The new-session heading (Graphite Home board; fork-owned, see
 * docs/graphite-plan.md). graphite.css hides upstream's empty state and
 * centers the composer under this.
 */
export function NewSessionHero({ mode }: { mode?: string }) {
	const practice = mode === "practice";
	return (
		<div className="lh-hero" data-testid="new-session-hero">
			<span className="lh-hero-kicker">{practice ? "Practice" : "Teaching"}</span>
			<h1 className="lh-hero-title">
				What do you want <span className="lh-hero-muted">{practice ? "to practice?" : "to understand?"}</span>
			</h1>
		</div>
	);
}
