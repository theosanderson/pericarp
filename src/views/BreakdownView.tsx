import { useEffect, useMemo, useState } from 'react';
import { aggregateAcross, fmt, fmtCompact, mergeByValue, type MergedValue, type OrgRows } from '../core/aggregate';
import { sharedFields } from '../core/instance';
import { isAbort, tidyError } from '../core/lapis';
import type { CatalogField, OrganismPlan, ViewProps } from '../core/types';
import {
  CopyButton,
  FieldSelect,
  Legend,
  NULL_LABEL,
  niceStep,
  niceTicks,
  TipRow,
  Toggle,
  Tooltip,
  topRoundedRect,
  useWidth,
  type TipState,
} from './chartUtils';

type Rows = OrgRows<Record<string, unknown> & { count: number }>[];

// Grouping on a per-record identifier would return one row per sequence.
const EXCLUDED = new Set(['accessionVersion', 'accession']);
const TOP_N = 50;

const pct = (n: number) => (n >= 0.001 ? `${(n * 100).toFixed(1)}%` : n > 0 ? '<0.1%' : '0%');

export default function BreakdownView({ instance, plans, addFilter, addRangeFilter, focusOrganism }: ViewProps) {
  const orgKeys = useMemo(() => plans.map((p) => p.organism.key), [plans]);
  const fields = useMemo(
    () => sharedFields(instance, orgKeys).filter((f) => !EXCLUDED.has(f.name) && f.type !== 'timestamp'),
    [instance, orgKeys],
  );
  const [field, setField] = useState<string>(() =>
    fields.some((f) => f.name === 'geoLocCountry') ? 'geoLocCountry' : (fields[0]?.name ?? ''),
  );
  const [field2, setField2] = useState<string | null>(null);
  const [stack, setStack] = useState<'org' | 'single'>('org');
  const [measure, setMeasure] = useState<'count' | 'share'>('count');
  const [needle, setNeedle] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [results, setResults] = useState<Rows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const def = instance.catalog.get(field);
  const isNumeric = !field2 && (def?.type === 'int' || def?.type === 'float');

  useEffect(() => {
    if (!field) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    aggregateAcross(plans, field2 ? [field, field2] : [field], ac.signal)
      .then((r) => setResults(r))
      .catch((e) => !isAbort(e) && setError(tidyError(e)))
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [plans, field, field2]);

  const included = useMemo(
    () => plans.filter((p) => results?.find((r) => r.organism === p.organism.key && !r.error)),
    [plans, results],
  );
  const excluded = useMemo(() => (results ?? []).filter((r) => r.error), [results]);
  const merged = useMemo(() => (results && !field2 ? mergeByValue(results, field) : []), [results, field, field2]);
  const orgTotals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of results ?? []) t[r.organism] = r.rows.reduce((s, x) => s + x.count, 0);
    return t;
  }, [results]);

  const label = (o: string) => instance.organisms.find((x) => x.key === o)?.displayName ?? o;

  return (
    <div className="cv">
      <div className="cv-controls">
        <label className="cv-control">
          <span className="label">Group by</span>
          <FieldSelect
            id="breakdown-field"
            fields={fields}
            value={field}
            onChange={(n) => {
              if (n) setField(n);
              setShowAll(false);
            }}
            totalOrgs={plans.length}
            orgKeys={orgKeys}
          />
        </label>
        <label className="cv-control">
          <span className="label">Then by</span>
          <FieldSelect
            id="breakdown-field2"
            fields={fields.filter((f) => f.name !== field)}
            value={field2}
            onChange={setField2}
            totalOrgs={plans.length}
            orgKeys={orgKeys}
            allowNone
            placeholder="None (1-D)"
          />
        </label>
        {!field2 && !isNumeric && (
          <>
            <Toggle
              label="Bar colour"
              value={stack}
              onChange={(v) => setStack(v as 'org' | 'single')}
              options={[
                { id: 'org', label: 'By organism' },
                { id: 'single', label: 'Single colour' },
              ]}
            />
            <Toggle
              label="Bar length"
              value={measure}
              onChange={(v) => setMeasure(v as 'count' | 'share')}
              options={[
                { id: 'count', label: 'Count' },
                { id: 'share', label: 'Organism share' },
              ]}
            />
          </>
        )}
        <span className="cv-spacer" />
        {loading && <span className="spinner" aria-label="Loading" />}
        {results && (
          <CopyButton
            getText={() => (field2 ? pivotTsv(results, field, field2) : rankTsv(merged, included, field))}
          />
        )}
      </div>

      {included.length > 1 && (
        <Legend plans={included} totals={orgTotals} onFocus={focusOrganism} />
      )}
      {excluded.length > 0 && (
        <div className="cv-note">
          Not included (no field {def?.displayName ?? field}
          {field2 ? ` or ${instance.catalog.get(field2)?.displayName ?? field2}` : ''}):{' '}
          {excluded.map((r) => label(r.organism)).join(', ')}
        </div>
      )}
      {error && <div className="err">{error}</div>}

      <div className={loading ? 'cv-loading' : ''}>
        {!results ? (
          <div className="empty">
            <span className="spinner" /> Loading breakdown…
          </div>
        ) : included.length === 0 ? (
          <div className="empty">No organism in this search has the field {def?.displayName ?? field}.</div>
        ) : field2 ? (
          <Pivot
            results={results}
            plans={included}
            field={field}
            field2={field2}
            def1={instance.catalog.get(field)}
            def2={instance.catalog.get(field2)}
            addFilter={addFilter}
            setTip={setTip}
          />
        ) : isNumeric ? (
          <Histogram merged={merged} plans={included} def={def!} setTip={setTip} addRangeFilter={addRangeFilter} />
        ) : (
          <Ranked
            merged={merged}
            plans={included}
            field={field}
            stack={stack}
            measure={measure}
            needle={needle}
            setNeedle={setNeedle}
            showAll={showAll}
            setShowAll={setShowAll}
            addFilter={addFilter}
            setTip={setTip}
          />
        )}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------- ranked list ----------

function Ranked({
  merged,
  plans,
  field,
  stack,
  measure,
  needle,
  setNeedle,
  showAll,
  setShowAll,
  addFilter,
  setTip,
}: {
  merged: MergedValue[];
  plans: OrganismPlan[];
  field: string;
  stack: 'org' | 'single';
  measure: 'count' | 'share';
  needle: string;
  setNeedle: (s: string) => void;
  showAll: boolean;
  setShowAll: (b: boolean) => void;
  addFilter: ViewProps['addFilter'];
  setTip: (t: TipState | null) => void;
}) {
  const grand = merged.reduce((s, m) => s + m.total, 0);
  const filtered = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return n ? merged.filter((m) => (m.value ?? NULL_LABEL).toLowerCase().includes(n)) : merged;
  }, [merged, needle]);
  const shown = showAll ? filtered : filtered.slice(0, TOP_N);
  const max = Math.max(1, ...shown.map((m) => m.total));

  const showTip = (m: MergedValue, x: number, y: number) =>
    setTip({
      x,
      y,
      content: (
        <>
          <div className="tip-title">{m.value ?? NULL_LABEL}</div>
          <TipRow value={fmt(m.total)} label={`total · ${pct(m.total / grand)} of records`} />
          {plans
            .filter((p) => m.byOrg[p.organism.key])
            .sort((a, b) => m.byOrg[b.organism.key] - m.byOrg[a.organism.key])
            .map((p) => (
              <TipRow
                key={p.organism.key}
                color={p.organism.color}
                value={fmt(m.byOrg[p.organism.key])}
                label={p.organism.displayName}
              />
            ))}
        </>
      ),
    });

  return (
    <div className="cv">
      <div className="rank-foot">
        <input
          id="breakdown-needle"
          className="input"
          style={{ maxWidth: 280 }}
          placeholder={`Filter ${fmt(merged.length)} values…`}
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
        <span className="cv-note num">
          {fmt(filtered.length)} distinct values · {fmt(grand)} records · click a value to filter on it
        </span>
      </div>
      <div className="rank" role="table">
        <div className="rank-head" role="row">
          <span className="label" style={{ paddingLeft: 4 }}>Value</span>
          <span className="label">{measure === 'share' ? 'Split by organism' : 'Records'}</span>
          <span className="label rank-num">Count</span>
          <span className="label rank-share">Share</span>
        </div>
        {shown.map((m) => {
          const segs =
            stack === 'single'
              ? [{ key: 'all', color: 'var(--accent)', n: m.total }]
              : plans
                  .filter((p) => m.byOrg[p.organism.key])
                  .map((p) => ({ key: p.organism.key, color: p.organism.color, n: m.byOrg[p.organism.key] }));
          const widthPct = measure === 'share' ? 100 : (m.total / max) * 100;
          return (
            <div
              key={m.value ?? '\u0000'}
              className="rank-row"
              role="row"
              onPointerMove={(e) => showTip(m, e.clientX, e.clientY)}
              onPointerLeave={() => setTip(null)}
            >
              <button
                className={`rank-value${m.value === null ? ' is-null' : ''}`}
                title={`Filter on ${m.value ?? NULL_LABEL}`}
                onClick={() => addFilter(field, m.value)}
                onFocus={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  showTip(m, r.right, r.top);
                }}
                onBlur={() => setTip(null)}
              >
                {m.value ?? NULL_LABEL}
              </button>
              <div className="rank-bar" aria-hidden="true">
                <div className="rank-track" style={{ width: `${Math.max(widthPct, 0.3)}%` }}>
                  {segs.map((s) => (
                    <span key={s.key} className="rank-seg" style={{ flexGrow: s.n, flexBasis: 0, background: s.color }} />
                  ))}
                </div>
              </div>
              <span className="rank-num" role="cell">{fmt(m.total)}</span>
              <span className="rank-share" role="cell">{pct(m.total / grand)}</span>
            </div>
          );
        })}
      </div>
      {filtered.length > TOP_N && (
        <div className="rank-foot">
          <span className="cv-note">
            Showing {fmt(shown.length)} of {fmt(filtered.length)} values
          </span>
          <button className="btn btn-sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? `Show top ${TOP_N}` : `Show all ${fmt(filtered.length)}`}
          </button>
        </div>
      )}
      {filtered.length === 0 && <div className="empty">No value matches “{needle}”.</div>}
    </div>
  );
}

function rankTsv(merged: MergedValue[], plans: OrganismPlan[], field: string) {
  const head = [field, 'total', ...plans.map((p) => p.organism.key)];
  const lines = merged.map((m) =>
    [m.value ?? '', m.total, ...plans.map((p) => m.byOrg[p.organism.key] ?? 0)].join('\t'),
  );
  return [head.join('\t'), ...lines].join('\n');
}

// ---------- histogram (numeric fields) ----------

function Histogram({
  merged,
  plans,
  def,
  setTip,
  addRangeFilter,
}: {
  merged: MergedValue[];
  plans: OrganismPlan[];
  def: CatalogField;
  setTip: (t: TipState | null) => void;
  addRangeFilter: ViewProps['addRangeFilter'];
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const nulls = merged.find((m) => m.value === null)?.total ?? 0;
  const numeric = merged.filter((m) => m.value !== null && Number.isFinite(Number(m.value)));

  const bins = useMemo(() => {
    if (numeric.length === 0) return [];
    const vals = numeric.map((m) => Number(m.value));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    let step = niceStep(max - min, 30);
    if (def.type === 'int') step = Math.max(1, Math.round(step));
    const start = Math.floor(min / step) * step;
    const n = Math.max(1, Math.floor((max - start) / step) + 1);
    const out = Array.from({ length: n }, (_, i) => ({
      lo: start + i * step,
      hi: start + (i + 1) * step,
      total: 0,
      byOrg: {} as Record<string, number>,
    }));
    for (const m of numeric) {
      const i = Math.min(n - 1, Math.floor((Number(m.value) - start) / step));
      const b = out[i];
      b.total += m.total;
      for (const [k, c] of Object.entries(m.byOrg)) b.byOrg[k] = (b.byOrg[k] ?? 0) + c;
    }
    return out;
  }, [numeric, def.type]);

  const H = 300;
  const M = { t: 12, r: 12, b: 34, l: 52 };
  const iw = Math.max(0, width - M.l - M.r);
  const ih = H - M.t - M.b;
  const maxY = Math.max(1, ...bins.map((b) => b.total));
  const ticks = niceTicks(maxY);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => ih - (v / top) * ih;
  const band = bins.length ? iw / bins.length : 0;
  const bw = Math.max(1, band - 2);
  const label = (v: number) =>
    def.percentage ? `${+(v * 100).toFixed(1)}%` : Math.abs(v) >= 10000 ? fmtCompact(v) : `${+v.toFixed(3)}`;
  // Range filters are inclusive, so an int bin [lo, hi) becomes lo..hi-1.
  const binFilter = (b: { lo: number; hi: number }) => {
    const r = (v: number) => String(+v.toFixed(6));
    addRangeFilter(def.name, r(b.lo), def.type === 'int' ? r(b.hi - 1) : r(b.hi));
  };
  const xEvery = Math.max(1, Math.ceil(60 / Math.max(band, 1)));

  return (
    <div className="cv">
      <div className="cv-note">
        Distribution of {def.displayName} ({fmt(numeric.reduce((s, m) => s + m.total, 0))} records)
        {nulls > 0 && ` · ${fmt(nulls)} records have no value`} · click a bar to filter on that range
      </div>
      <div className="chart-box" ref={box}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`Histogram of ${def.displayName}`}>
            <g transform={`translate(${M.l},${M.t})`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line className="chart-grid" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
                  <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" className="num">
                    {fmtCompact(t)}
                  </text>
                </g>
              ))}
              {bins.map((b, i) => {
                let acc = 0;
                const x = i * band + 1;
                const visible = plans.filter((p) => b.byOrg[p.organism.key]);
                return (
                  <g
                    key={i}
                    className="chart-bin"
                    role="button"
                    tabIndex={0}
                    aria-label={`${label(b.lo)} to ${label(b.hi)}: ${fmt(b.total)} records`}
                    onClick={() => b.total > 0 && binFilter(b)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && b.total > 0 && binFilter(b)}
                    onPointerMove={(e) =>
                      setTip({
                        x: e.clientX,
                        y: e.clientY,
                        content: (
                          <>
                            <div className="tip-title">
                              {label(b.lo)} – {label(b.hi)}
                            </div>
                            <TipRow value={fmt(b.total)} label="total · click to filter" />
                            {visible.map((p) => (
                              <TipRow key={p.organism.key} color={p.organism.color} value={fmt(b.byOrg[p.organism.key])} label={p.organism.displayName} />
                            ))}
                          </>
                        ),
                      })
                    }
                    onPointerLeave={() => setTip(null)}
                  >
                    <rect className="chart-hit" x={i * band} y={0} width={band} height={ih} />
                    {visible.map((p, j) => {
                      const v = b.byOrg[p.organism.key];
                      const y0 = y(acc);
                      acc += v;
                      const y1 = y(acc);
                      const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                      const isTop = j === visible.length - 1;
                      return (
                        <path
                          key={p.organism.key}
                          className="chart-mark"
                          fill={p.organism.color}
                          d={topRoundedRect(x, y1, bw, h, isTop && bw >= 8 ? 4 : 0)}
                        />
                      );
                    })}
                  </g>
                );
              })}
              <line className="chart-axis" x1={0} x2={iw} y1={ih} y2={ih} />
              {bins.map((b, i) =>
                i % xEvery === 0 ? (
                  <text key={i} x={i * band} y={ih + 16} textAnchor="middle" className="num">
                    {label(b.lo)}
                  </text>
                ) : null,
              )}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

// ---------- 2-D pivot ----------

const PIVOT_ROWS = 30;
const PIVOT_COLS = 12;

function Pivot({
  results,
  plans,
  field,
  field2,
  def1,
  def2,
  addFilter,
  setTip,
}: {
  results: Rows;
  plans: OrganismPlan[];
  field: string;
  field2: string;
  def1?: CatalogField;
  def2?: CatalogField;
  addFilter: ViewProps['addFilter'];
  setTip: (t: TipState | null) => void;
}) {
  const { rows, cols, cells, max, rowTotals, colTotals } = useMemo(() => buildPivot(results, field, field2), [results, field, field2]);
  const keyOf = (v: string | null) => v ?? '\u0000';

  return (
    <div className="cv">
      <div className="cv-note">
        Top {Math.min(rows.length, PIVOT_ROWS)} {def1?.displayName ?? field} × top {Math.min(cols.length, PIVOT_COLS)}{' '}
        {def2?.displayName ?? field2}. Darker cells hold more records; click a cell to filter on both values.
      </div>
      <div className="table-wrap panel">
        <table className="table pivot">
          <thead>
            <tr>
              <th className="row-head">
                {def1?.displayName ?? field} ↓ / {def2?.displayName ?? field2} →
              </th>
              {cols.slice(0, PIVOT_COLS).map((c) => (
                <th key={keyOf(c)} className="num" title={c ?? NULL_LABEL} style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c ?? NULL_LABEL}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, PIVOT_ROWS).map((r) => (
              <tr key={keyOf(r)}>
                <td className="row-head">
                  <button className={`rank-value${r === null ? ' is-null' : ''}`} onClick={() => addFilter(field, r)}>
                    {r ?? NULL_LABEL}
                  </button>
                </td>
                {cols.slice(0, PIVOT_COLS).map((c) => {
                  const cell = cells.get(`${keyOf(r)}\u0001${keyOf(c)}`);
                  const n = cell?.total ?? 0;
                  const a = n ? 0.1 + 0.8 * Math.sqrt(n / max) : 0;
                  return (
                    <td
                      key={keyOf(c)}
                      className="cell"
                      style={{
                        background: n ? `color-mix(in oklab, var(--accent) ${Math.round(a * 100)}%, var(--surface))` : undefined,
                        color: a > 0.55 ? 'var(--accent-ink)' : undefined,
                      }}
                      onClick={() => {
                        if (!n) return;
                        addFilter(field, r);
                        addFilter(field2, c);
                      }}
                      onPointerMove={(e) =>
                        setTip({
                          x: e.clientX,
                          y: e.clientY,
                          content: (
                            <>
                              <div className="tip-title">
                                {r ?? NULL_LABEL} · {c ?? NULL_LABEL}
                              </div>
                              <TipRow value={fmt(n)} label="records" />
                              {plans
                                .filter((p) => cell?.byOrg[p.organism.key])
                                .map((p) => (
                                  <TipRow key={p.organism.key} color={p.organism.color} value={fmt(cell!.byOrg[p.organism.key])} label={p.organism.displayName} />
                                ))}
                            </>
                          ),
                        })
                      }
                      onPointerLeave={() => setTip(null)}
                    >
                      {n ? fmt(n) : ''}
                    </td>
                  );
                })}
                <td className="num">
                  <strong>{fmt(rowTotals.get(keyOf(r)) ?? 0)}</strong>
                </td>
              </tr>
            ))}
            <tr>
              <td className="row-head label">Total</td>
              {cols.slice(0, PIVOT_COLS).map((c) => (
                <td key={keyOf(c)} className="num">
                  <strong>{fmt(colTotals.get(keyOf(c)) ?? 0)}</strong>
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function buildPivot(results: Rows, field: string, field2: string) {
  const k = (v: unknown) => (v === null || v === undefined ? '\u0000' : String(v));
  const cells = new Map<string, { total: number; byOrg: Record<string, number> }>();
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  const rowVal = new Map<string, string | null>();
  const colVal = new Map<string, string | null>();
  for (const r of results) {
    for (const row of r.rows) {
      const a = k(row[field]);
      const b = k(row[field2]);
      rowVal.set(a, a === '\u0000' ? null : a);
      colVal.set(b, b === '\u0000' ? null : b);
      const key = `${a}\u0001${b}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { total: 0, byOrg: {} }));
      c.total += row.count;
      c.byOrg[r.organism] = (c.byOrg[r.organism] ?? 0) + row.count;
      rowTotals.set(a, (rowTotals.get(a) ?? 0) + row.count);
      colTotals.set(b, (colTotals.get(b) ?? 0) + row.count);
    }
  }
  const rows = [...rowTotals.entries()].sort((x, y) => y[1] - x[1]).map(([key]) => rowVal.get(key)!);
  const cols = [...colTotals.entries()].sort((x, y) => y[1] - x[1]).map(([key]) => colVal.get(key)!);
  const topRows = new Set(rows.slice(0, PIVOT_ROWS).map(k));
  const topCols = new Set(cols.slice(0, PIVOT_COLS).map(k));
  let max = 1;
  for (const [key, c] of cells) {
    const [a, b] = key.split('\u0001');
    if (topRows.has(a) && topCols.has(b)) max = Math.max(max, c.total);
  }
  return { rows, cols, cells, max, rowTotals, colTotals };
}

function pivotTsv(results: Rows, field: string, field2: string) {
  const { rows, cols, cells } = buildPivot(results, field, field2);
  const k = (v: string | null) => v ?? '\u0000';
  const head = [`${field} \\ ${field2}`, ...cols.map((c) => c ?? '')].join('\t');
  const lines = rows.map((r) => [r ?? '', ...cols.map((c) => cells.get(`${k(r)}\u0001${k(c)}`)?.total ?? 0)].join('\t'));
  return [head, ...lines].join('\n');
}
