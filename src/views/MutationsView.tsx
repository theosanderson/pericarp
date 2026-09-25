import { useEffect, useMemo, useState } from 'react';
import { fmt } from '../core/aggregate';
import { isAbort, lapis, tidyError } from '../core/lapis';
import { planFilter } from '../core/query';
import type { ViewProps } from '../core/types';
import './MutationsView.css';

interface MutationRow {
  mutation: string;
  count: number;
  coverage: number;
  proportion: number;
  sequenceName: string | null;
  mutationFrom: string;
  mutationTo: string;
  position: number;
}

type SortKey = 'mutation' | 'sequenceName' | 'position' | 'count' | 'coverage' | 'proportion';
const PAGE = 100;

export default function MutationsView({ plans, counts, addMutation }: ViewProps) {
  const sortedPlans = useMemo(
    () => [...plans].sort((a, b) => (counts.get(b.organism.key)?.count ?? 0) - (counts.get(a.organism.key)?.count ?? 0)),
    [plans, counts],
  );
  const [orgKey, setOrgKey] = useState(sortedPlans[0]?.organism.key ?? '');
  const plan = sortedPlans.find((p) => p.organism.key === orgKey) ?? sortedPlans[0];
  const org = plan?.organism;

  const [kind, setKind] = useState<'nuc' | 'aa'>('nuc');
  const [minProp, setMinProp] = useState(0.05);
  const [minPropInput, setMinPropInput] = useState('0.05');
  const [seq, setSeq] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'proportion', desc: true });
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<MutationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; row: MutationRow } | null>(null);

  // Debounce the proportion input so the slider doesn't flood LAPIS.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const v = Number(minPropInput);
      if (Number.isFinite(v) && v >= 0 && v <= 1) setMinProp(v);
    }, 300);
    return () => window.clearTimeout(t);
  }, [minPropInput]);

  useEffect(() => {
    if (!plan) return;
    const ac = new AbortController();
    setRows(null);
    setError(null);
    lapis<MutationRow>(
      plan.organism.lapisUrl,
      kind === 'nuc' ? 'nucleotideMutations' : 'aminoAcidMutations',
      { ...planFilter(plan), minProportion: minProp },
      { signal: ac.signal },
    )
      .then(setRows)
      .catch((e) => !isAbort(e) && setError(tidyError(e)));
    return () => ac.abort();
  }, [plan, kind, minProp]);

  useEffect(() => {
    setSeq('');
    setPage(0);
  }, [orgKey, kind]);
  useEffect(() => setPage(0), [seq, search, sort, minProp]);

  const seqOptions = org ? (kind === 'nuc' ? (org.isSegmented ? org.segments : []) : org.genes) : [];
  const seqOf = (r: MutationRow) => r.sequenceName ?? (org?.segments[0] ?? '');

  const filtered = useMemo(() => {
    if (!rows) return [];
    const s = search.trim().toLowerCase();
    const out = rows.filter((r) => (!seq || seqOf(r) === seq) && (!s || r.mutation.toLowerCase().includes(s)));
    const dir = sort.desc ? -1 : 1;
    out.sort((a, b) => {
      const av = sort.key === 'sequenceName' ? seqOf(a) : a[sort.key];
      const bv = sort.key === 'sequenceName' ? seqOf(b) : b[sort.key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, seq, search, sort]);

  // Genome track: one lane per segment/gene present in the filtered set.
  const lanes = useMemo(() => {
    const map = new Map<string, { name: string; max: number; rows: MutationRow[] }>();
    for (const r of filtered) {
      const n = seqOf(r);
      let l = map.get(n);
      if (!l) map.set(n, (l = { name: n, max: 0, rows: [] }));
      l.rows.push(r);
      l.max = Math.max(l.max, r.position);
    }
    for (const l of map.values()) {
      const ref = org?.referenceLengths?.[l.name];
      if (ref && ref >= l.max) l.max = ref;
    }
    const order = kind === 'nuc' ? org?.segments ?? [] : org?.genes ?? [];
    return [...map.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, kind, org]);

  const copy = async (code: string) => {
    const msg = `Copied ${code} — paste into Advanced query or Mutation filters`;
    try {
      await navigator.clipboard.writeText(code);
      setToast(msg);
    } catch {
      setToast(`Copy failed. Select and copy: ${code}`);
    }
    window.setTimeout(() => setToast(null), 3000);
  };

  const add = (code: string) => {
    if (!org) return;
    addMutation(org.key, kind, code);
    setToast(`Added ${code} as a mutation filter for ${org.displayName}`);
    window.setTimeout(() => setToast(null), 3000);
  };

  if (!plan || !org) return <div className="empty">No organisms to analyse.</div>;

  const pageRows = filtered.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const th = (key: SortKey, label: string, num = false) => (
    <th
      className={num ? 'num' : undefined}
      aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button className="mut-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : num }))}>
        {label}
        {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  const LANE_H = 34;
  const W = 1000;

  return (
    <div className="mut">
      <div className="mut-controls">
        <label className="mut-field">
          <span className="label">Organism</span>
          <select id="mut-org" className="select" value={org.key} onChange={(e) => setOrgKey(e.target.value)}>
            {sortedPlans.map((p) => (
              <option key={p.organism.key} value={p.organism.key}>
                {p.organism.displayName} ({fmt(counts.get(p.organism.key)?.count)})
              </option>
            ))}
          </select>
        </label>
        <div className="mut-field">
          <span className="label">Type</span>
          <div className="seg">
            <button aria-pressed={kind === 'nuc'} onClick={() => setKind('nuc')}>Nucleotide</button>
            <button aria-pressed={kind === 'aa'} onClick={() => setKind('aa')}>Amino acid</button>
          </div>
        </div>
        <label className="mut-field mut-prop">
          <span className="label">Min proportion</span>
          <span className="mut-prop-row">
            <input
              id="mut-prop-range"
              type="range"
              min={0.001}
              max={1}
              step={0.001}
              value={Number(minPropInput) || 0}
              onChange={(e) => setMinPropInput(e.target.value)}
            />
            <input
              id="mut-prop"
              className="input num"
              value={minPropInput}
              onChange={(e) => setMinPropInput(e.target.value)}
              inputMode="decimal"
            />
          </span>
        </label>
        {seqOptions.length > 0 && (
          <label className="mut-field">
            <span className="label">{kind === 'nuc' ? 'Segment' : 'Gene'}</span>
            <select id="mut-seq" className="select" value={seq} onChange={(e) => setSeq(e.target.value)}>
              <option value="">All ({seqOptions.length})</option>
              {seqOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        <label className="mut-field mut-grow">
          <span className="label">Search</span>
          <input
            id="mut-search"
            className="input mono"
            placeholder={kind === 'nuc' ? 'e.g. C3000T or 3000' : 'e.g. OPG001:T86N'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      {error && <div className="err">{error}</div>}
      {!rows && !error && (
        <div className="empty"><span className="spinner" /> Loading mutations for {org.displayName}…</div>
      )}

      {rows && (
        <>
          <div className="mut-summary muted">
            <span className="dot" style={{ background: org.color }} /> {fmt(filtered.length)} {kind === 'nuc' ? 'nucleotide' : 'amino acid'} mutations
            at ≥ {(minProp * 100).toFixed(1)}% in {org.displayName}
            {filtered.length !== rows.length && ` (of ${fmt(rows.length)})`}. Click a mutation to add it as a filter.
          </div>

          {lanes.length > 0 && (
            <div className="panel mut-track">
              <svg viewBox={`0 0 ${W + 90} ${lanes.length * LANE_H + 6}`} role="img" aria-label="Mutation positions along the genome">
                {lanes.map((l, i) => {
                  const y0 = i * LANE_H + 4;
                  const base = y0 + LANE_H - 8;
                  const max = Math.max(l.max, 1);
                  return (
                    <g key={l.name}>
                      <text x={0} y={base - 4} className="mut-lane-label">{l.name.length > 12 ? l.name.slice(0, 11) + '…' : l.name}</text>
                      <line x1={90} x2={90 + W} y1={base} y2={base} className="mut-axis" />
                      <text x={90 + W} y={base + 0} dy={-2} textAnchor="end" className="mut-lane-max">{fmt(l.max)}</text>
                      {l.rows.map((r) => {
                        const x = 90 + (r.position / max) * W;
                        const h = Math.max(1.5, r.proportion * (LANE_H - 12));
                        return (
                          <rect
                            key={r.mutation}
                            x={x - 1}
                            width={2}
                            y={base - h}
                            height={h}
                            fill={org.color}
                            opacity={hover?.row === r ? 1 : 0.75}
                            onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, row: r })}
                            onMouseLeave={() => setHover(null)}
                            onClick={() => add(r.mutation)}
                            style={{ cursor: 'pointer' }}
                          />
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
              <div className="muted mut-note">Bar height = proportion. Lane length = reference length (or highest mutated position when unknown). Click a bar to add it as a filter.</div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="empty">No mutations above this proportion.</div>
          ) : (
            <div className="panel table-wrap mut-table">
              <table className="table">
                <thead>
                  <tr>
                    {th('mutation', 'Mutation')}
                    {th('sequenceName', kind === 'nuc' ? 'Segment' : 'Gene')}
                    {th('position', 'Position', true)}
                    <th>Change</th>
                    {th('count', 'Count', true)}
                    {th('coverage', 'Coverage', true)}
                    {th('proportion', 'Proportion', true)}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.mutation}>
                      <td className="mono">
                        <button className="mut-code" onClick={() => add(r.mutation)} title="Add as mutation filter">
                          {r.mutation}
                        </button>
                      </td>
                      <td>{seqOf(r)}</td>
                      <td className="num">{fmt(r.position)}</td>
                      <td className="mono">{r.mutationFrom} → {r.mutationTo}</td>
                      <td className="num">{fmt(r.count)}</td>
                      <td className="num">{fmt(r.coverage)}</td>
                      <td className="num">
                        <span className="mut-bar-wrap">
                          <span className="mut-bar" style={{ width: `${r.proportion * 100}%`, background: org.color }} />
                        </span>
                        {(r.proportion * 100).toFixed(1)}%
                      </td>
                      <td className="mut-row-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => add(r.mutation)}>Add as filter</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(r.mutation)}>Copy</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="mut-pager">
              <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span className="muted num">Page {page + 1} of {pages}</span>
              <button className="btn btn-sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      {hover && (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div className="mono">{hover.row.mutation}</div>
          <div>Position {fmt(hover.row.position)}</div>
          <div>{fmt(hover.row.count)} of {fmt(hover.row.coverage)} ({(hover.row.proportion * 100).toFixed(1)}%)</div>
        </div>
      )}
      {toast && <div className="mut-toast" role="status">{toast}</div>}
    </div>
  );
}
