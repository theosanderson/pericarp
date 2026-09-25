import { useState } from 'react';
import { fmt } from '../core/aggregate';
import type { CountResult, Instance, OrganismPlan, Query } from '../core/types';

export default function SummaryStrip(props: {
  instance: Instance;
  plans: OrganismPlan[];
  counts: Map<string, CountResult>;
  counting: boolean;
  query: Query;
  onChange: (q: Query) => void;
}) {
  const [showCompiled, setShowCompiled] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const rows = props.plans
    .map((p) => ({ plan: p, c: props.counts.get(p.organism.key) }))
    .sort((a, b) => (b.c?.count ?? -1) - (a.c?.count ?? -1));
  const total = rows.reduce((s, r) => s + (r.c?.count ?? 0), 0);
  const matching = rows.filter((r) => (r.c?.count ?? 0) > 0);
  const skipped = rows.filter((r) => r.c?.skippedReason);
  const errors = rows.filter((r) => r.c?.error);
  const hovered = hover ? rows.find((r) => r.plan.organism.key === hover) : null;

  return (
    <div className="summary panel">
      <div className="summary-top">
        <div className="summary-total">
          <span className="summary-num num">{fmt(total)}</span>
          <span className="summary-caption">
            {props.counting ? (
              <>
                <span className="spinner" /> counting…
              </>
            ) : (
              <>
                sequences in <strong>{matching.length}</strong> of {props.instance.organisms.length} organisms
              </>
            )}
          </span>
        </div>
        <div className="summary-hover num" aria-live="polite">
          {hovered ? (
            <>
              <span className="dot" style={{ background: hovered.plan.organism.color }} /> {hovered.plan.organism.displayName}:{' '}
              <strong>{fmt(hovered.c?.count)}</strong>
              {total > 0 && hovered.c?.count ? ` (${(((hovered.c.count ?? 0) / total) * 100).toFixed(1)}%)` : ''}
            </>
          ) : (
            <span className="muted">Click a segment to search only that organism</span>
          )}
        </div>
      </div>

      <div className="stackbar" role="img" aria-label="Matching sequences by organism">
        {total > 0 &&
          matching.map(({ plan, c }) => (
            <button
              key={plan.organism.key}
              className="stackbar-seg"
              style={{ flexGrow: c!.count!, background: plan.organism.color }}
              onMouseEnter={() => setHover(plan.organism.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(plan.organism.key)}
              onBlur={() => setHover(null)}
              onClick={() => props.onChange({ ...props.query, organisms: [plan.organism.key] })}
              aria-label={`${plan.organism.displayName}: ${fmt(c!.count)}`}
            />
          ))}
      </div>

      <div className="summary-notes">
        {skipped.length > 0 && (
          <details className="note">
            <summary>{skipped.length} organisms left out</summary>
            <ul>
              {skipped.map(({ plan, c }) => (
                <li key={plan.organism.key}>
                  <span className="dot" style={{ background: plan.organism.color }} /> {plan.organism.displayName}: {c!.skippedReason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {errors.length > 0 && (
          <details className="note note-bad" open>
            <summary>{errors.length} organisms returned an error</summary>
            <ul>
              {errors.map(({ plan, c }) => (
                <li key={plan.organism.key}>
                  <span className="dot" style={{ background: plan.organism.color }} /> {plan.organism.displayName}: <span className="mono">{c!.error}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => setShowCompiled((s) => !s)}>
          {showCompiled ? 'Hide' : 'Show'} compiled LAPIS queries
        </button>
      </div>
      {showCompiled && (
        <div className="compiled">
          {props.plans.map((p) => (
            <div key={p.organism.key} className="compiled-row">
              <span className="compiled-org">
                <span className="dot" style={{ background: p.organism.color }} /> {p.organism.key}
              </span>
              <code className="mono">{p.advancedQuery ?? `— ${p.skippedReason}`}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
