import type { ReactNode } from "react";

/**
 * A named band of a page.
 *
 * ── WHY PAGES NEEDED THESE ──────────────────────────────────────────
 * Before this, a long page was a dozen cards in a column, every one the same
 * weight, with nothing saying that the top three answer "who is here" and the
 * next four answer "where did they come from". A reader had to reconstruct
 * that grouping from the card titles on every visit.
 *
 * The rule is what does the separating — a heading alone at this density
 * reads as one more card title. It is drawn full width so the eye gets a hard
 * stop, which is the thing that was missing.
 *
 * `aside` is for controls that belong to the section rather than the page:
 * a filter over these cards only, a count, a link out. Page-wide controls go
 * in the topbar via <PageActions> instead.
 */
export function SectionHead({ title, blurb, aside }: {
  title: string;
  blurb?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div className="section-head__text">
        <h2 className="section-head__title">{title}</h2>
        {blurb && <p className="section-head__blurb dim">{blurb}</p>}
      </div>
      {aside && <div className="section-head__aside">{aside}</div>}
    </div>
  );
}

/**
 * One tile in a KPI strip.
 *
 * Uniform by construction. Every headline number in this dashboard is the
 * same kind of object and should be the same size — the previous pages had a
 * hero tile, a compact tile and a bare stat block all rendering the same sort
 * of value, which made the layout look accidental and told the reader nothing
 * about relative importance that was actually true.
 *
 * `state` tints the tile when a number carries an alert meaning. Use it only
 * when zero and non-zero are genuinely different situations (errors, open
 * bugs); a permanently amber tile teaches people to ignore amber.
 */
export function Kpi({ label, value, sub, hint, accent, state, onClick }: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  accent?: boolean;
  state?: "ok" | "warn" | "danger";
  onClick?: () => void;
}) {
  const className = `kpi${accent ? " kpi--accent" : ""}${state ? ` kpi--${state}` : ""}${onClick ? " kpi--clickable" : ""}`;
  const body = (
    <>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  // A button when it navigates, an article when it does not — rather than an
  // article with an onClick, which is invisible to the keyboard.
  return onClick
    ? <button type="button" className={className} title={hint} onClick={onClick}>{body}</button>
    : <article className={className} title={hint}>{body}</article>;
}
