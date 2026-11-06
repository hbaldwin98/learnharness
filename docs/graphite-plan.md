# Graphite tier 3: plan

Design: the "Learn Harness Redesign" canvas (boards Tokens, Layouts, Main, Home, Graph, Chains, Reading, Practice, Settings).
Tiers 1–2 shipped in `5fb6473`. This finishes the look while keeping upstream merges cheap.

## Merge rules
- All styling lives in fork-owned files under `app/theme/`. Upstream files only gain **one-line mounts** of fork components, or a `data-lh-*` attribute where a selector would otherwise depend on a fragile Tailwind class.
- CSS that targets an upstream utility class is scoped (e.g. `[data-testid="session-kind-filter"]`, `aside > .w-72`), so it can't leak into other places.
- Each upstream touch is listed below, so a merge conflict is easy to re-apply.

## Decisions (user)
- Scope: CSS plus small hooks.
- Confidence rail: indigo fill `#8B93FF` on a `#2A2A30` track; ticks stay.
- Top bar: breadcrumb `Teaching / <name>` at 13px. The name stays editable, and a status pill follows it.

## Minor decisions (recommended option taken)
- Pill states come from existing session state:
  - a pending question → "Probing"
  - streaming → "Working"
  - a practice problem waiting → "Problem waiting"
  - otherwise → no pill
- Home copy: "What do you want to understand?" (practice copy unchanged).
- Token names: add the design's names (`--lh-bg-sidebar`, `--lh-surface-2`, `--lh-inset`, `--lh-chip`, `--lh-control`, `--lh-control-on`, `--lh-track`, `--lh-ink-body/2/3/faint/sep`, `--lh-line/-control/-strong`, `--lh-success/warn`, `--lh-shadow-*`) as `--lh-` aliases. Shadcn names keep driving upstream.

## Steps (each one: build + commit)
1. **Tokens.** Add the full Graphite token set to `graphite.css`. Override radii (`--radius` → 6px default, so `rounded-lg` = 12 and `rounded-xl` = 14), prose to 16/1.7, and card/popover/modal shadows. Upstream files touched: none.
2. **Shell sizes.**
   - Sidebar: 264px wide on the #0E0E11 ground. The active row is #1A1A1F; the session-kind filter becomes a segmented control (#16161A track, #26262C active segment).
   - Top bar: 52px. The `h-15` override is scoped to `header.lh-wco-gutter` and the settings/setup headers.
   - Chat column: 760px.
   Upstream files touched: possibly a `data-lh-shell` attribute on the sidebar root, if the CSS selectors prove fragile.
3. **Confidence rail.** A CSS override on `[data-testid="confidence-rail"]`, plus the dock's range input, using `!important` to beat the inline style. If the dock input carries no stable hook, add one `data-lh-rail` attribute in `question-dock.tsx`.
4. **Breadcrumb top bar.** New `components/lh/breadcrumb-prefix.tsx` and `status-pill.tsx`, mounted in `chat.tsx` beside the title (2 lines). CSS shrinks the title from `font-title text-3xl` to 13px/500 inside the top bar. The practice workspace bar gets the same treatment.
5. **Home.** Change the placeholder copy (1 line each in `home.tsx` and `new-session.tsx`). Add a new `components/lh/resume-cards.tsx` ("Pick up where you left off": the 2 most recent sessions with a pending question or waiting problem, showing "A probe is waiting · 2d"), mounted under the composer (1 line). Style the composer as a 12px-radius card with the shadow-card shadow, and its chips at 28px.
6. **Reading.**
   - Rail: 300px wide, 48px gap, not sticky (CSS).
   - New `components/lh/reading-toc.tsx` ("On this page" from the section headings), mounted at the bottom of the Discuss rail (1 line).
   - Kind pill and "From <session> →" meta line: only if the reading data already carries a kind and a source session. If not, skip them and report.
7. **Overlays and dialogs.**
   - Settings: radius 14, a 200px nav, a 72% scrim with 4px blur, bordered section cards, indigo switches.
   - Chains overlay: 86% opacity with 8px blur; rows at 34/40px.
   - Graph popover: 320px with the popover shadow.
   - Practice pane headers: 52px; the editor pane on #0B0B0D.
   All CSS, scoped by existing test ids or a new `data-lh-*` attribute.
8. **Hard-coded colors.** The appearance hint's #141414 and the graph's #888888 fallback get CSS overrides where possible, otherwise a single-token edit.

## Out of scope
- The graph's floating composer, a reworked chains layout, and the probe header card. Each needs a structural rewrite of upstream components.
- Phone styling stays as it is.

## Verification
Build plus the existing tests after each step. Then run the app and take a screenshot of each screen to compare with its board.

## Implementation log
- Steps 1–8 went into one commit. Every step edits `graphite.css`, so splitting them wasn't practical.
- Confidence rail: `confidence-rail.tsx` now reads `var(--lh-conf-N, <upstream hex>)`. Without the fork CSS it renders exactly as upstream.
- Status pill: only "Probing" and "Working". "Problem waiting" was skipped because the chat bar has no practice-problem flag at hand.
- The practice workspace's own top bar gets the 52px height but no breadcrumb.
- Reading: the "From the session …" link already existed upstream. Kind pill and read time were skipped (no read-time data).
- Skipped: the graph popover, and the #141414 / #888888 fallbacks. Those are edge-case fallbacks that are never visible with the theme on.
- Upstream touches: `chat.tsx` (+3 lines), `home.tsx` (+2, 1 copy), `new-session.tsx` (1 copy), `reading-view.tsx` (+2), `confidence-rail.tsx` (7 values wrapped in var()). All marked `// fork: graphite`.
- Gates: build green. Tests: same 27 failures as unmodified main (Windows baseline), no new ones.
