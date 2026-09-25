import { useEffect, useMemo, useState } from 'react';
import { aggregateAcross, fmt, fmtCompact, type OrgRows } from '../core/aggregate';
import { isAbort, tidyError } from '../core/lapis';
import type { CatalogField, Instance, OrganismPlan, ViewProps } from '../core/types';
import { CopyButton, FieldSelect, Legend, niceTicks, TipRow, Toggle, Tooltip, topRoundedRect, useWidth, type TipState } from './chartUtils';

type Rows = OrgRows<Record<string, unknown> & { count: number }>[];
type Unit = 'year' | 'month' | 'week';
type Precision = 'year' | 'month' | 'day';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KNOWN_DATE_STRINGS = ['sampleCollectionDate', 'earliestReleaseDate', 'ncbiReleaseDate', 'releasedDate', 'submittedDate'];
const PRECISION_RANK: Record<Precision, number> = { year: 0, month: 1, day: 2 };
const UNIT_RANK: Record<Unit, number> = { year: 0, month: 1, week: 2 };

function dateFields(instance: Instance, orgKeys: string[]): CatalogField[] {
  const keys = new Set(orgKeys);
  return [...instance.catalog.values()]
    .filter((f) => f.organisms.some((o) => keys.has(o)))
    .filter((f) => f.type === 'date' || (f.type === 'string' && KNOWN_DATE_STRINGS.includes(f.name)))
    .sort((a, b) => {
      const ia = KNOWN_DATE_STRINGS.indexOf(a.name);
      const ib = KNOWN_DATE_STRINGS.indexOf(b.name);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.displayName.localeCompare(b.displayName);
    });
}

interface Parsed {
  y: number;
  m: number; // 0-based, 0 when unknown
  d: number; // 1-based, 1 when unknown
  precision: Precision;
}

function parseDate(v: unknown): Parsed | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (!m[2]) return { y, m: 0, d: 1, precision: 'year' };
  const mo = Math.min(11, Math.max(0, Number(m[2]) - 1));
  if (!m[3]) return { y, m: mo, d: 1, precision: 'month' };
  return { y, m: mo, d: Math.max(1, Number(m[3])), precision: 'day' };
}

/** Monday of the ISO week, as a UTC ms timestamp. */
function weekStart(p: Parsed) {
  const t = Date.UTC(p.y, p.m, p.d);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return t - dow * 86400000;
}

function bucketStart(p: Parsed, unit: Unit): number {
  if (unit === 'year') return Date.UTC(p.y, 0, 1);
  if (unit === 'month') return Date.UTC(p.y, p.m, 1);
  return weekStart(p);
}

function nextBucket(t: number, unit: Unit): number {
  const d = new Date(t);
  if (unit === 'year') return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return t + 7 * 86400000;
}

function bucketLabel(t: number, unit: Unit) {
  const d = new Date(t);
  if (unit === 'year') return String(d.getUTCFullYear());
  if (unit === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `Week of ${d.toISOString().slice(0, 10)}`;
}

interface Bucket {
  t: number;
  byOrg: Record<string, number>;
  total: number;
}

export default function TimelineView({ instance, plans, focusOrganism }: ViewProps) {
  const orgKeys = useMemo(() => plans.map((p) => p.organism.key), [plans]);
  const fields = useMemo(() => dateFields(instance, orgKeys), [instance, orgKeys]);
  const [field, setField] = useState<string>(fields[0]?.name ?? '');
  const [unitChoice, setUnitChoice] = useState<'auto' | Unit>('auto');
  const [form, setForm] = useState<'bars' | 'area'>('bars');
  const [cumulative, setCumulative] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<{ from: number | null; to: number | null } | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [results, setResults] = useState<Rows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    if (!field) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    aggregateAcross(plans, [field], ac.signal)
      .then((r) => {
        setResults(r);
        setRange(null);
      })
      .catch((e) => !isAbort(e) && setError(tidyError(e)))
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [plans, field]);

  const included = useMemo(
    () => plans.filter((p) => results?.some((r) => r.organism === p.organism.key && !r.error)),
    [plans, results],
  );
  const excluded = useMemo(() => (results ?? []).filter((r) => r.error), [results]);

  // Flatten to parsed points once per result set.
  const points = useMemo(() => {
    const pts: { p: Parsed; org: string; n: number }[] = [];
    let nulls = 0;
    let unparsable = 0;
    const nullsByOrg: Record<string, number> = {};
    for (const r of results ?? []) {
      if (r.error) continue;
      for (const row of r.rows) {
        const v = row[field];
        if (v === null || v === undefined || v === '') {
          nulls += row.count;
          nullsByOrg[r.organism] = (nullsByOrg[r.organism] ?? 0) + row.count;
          continue;
        }
        const p = parseDate(v);
        if (!p) unparsable += row.count;
        else pts.push({ p, org: r.organism, n: row.count });
      }
    }
    return { pts, nulls, unparsable, nullsByOrg };
  }, [results, field]);

  // Year extent + default window that trims the sparse early tail (keeps 99.5% of records).
  const extent = useMemo(() => {
    const byYear = new Map<number, number>();
    let total = 0;
    for (const { p, n } of points.pts) {
      byYear.set(p.y, (byYear.get(p.y) ?? 0) + n);
      total += n;
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    if (years.length === 0) return null;
    let acc = 0;
    let trimmed = years[0];
    for (const y of years) {
      acc += byYear.get(y)!;
      if (acc > total * 0.005) {
        trimmed = y;
        break;
      }
    }
    return { min: years[0], max: years[years.length - 1], defaultFrom: trimmed };
  }, [points]);

  const from = range?.from ?? extent?.defaultFrom ?? 0;
  const to = range?.to ?? extent?.max ?? 0;
  const span = to - from + 1;
  const unit: Unit = unitChoice !== 'auto' ? unitChoice : span > 12 ? 'year' : span > 2 ? 'month' : 'week';

  const { buckets, coarse, outside, orgTotals } = useMemo(() => {
    const map = new Map<number, Bucket>();
    let coarse = 0;
    let outside = 0;
    const orgTotals: Record<string, number> = {};
    for (const { p, org, n } of points.pts) {
      orgTotals[org] = (orgTotals[org] ?? 0) + n;
      if (p.y < from || p.y > to) {
        outside += n;
        continue;
      }
      const need: Precision = unit === 'year' ? 'year' : unit === 'month' ? 'month' : 'day';
      if (PRECISION_RANK[p.precision] < PRECISION_RANK[need]) coarse += n;
      const t = bucketStart(p, unit);
      let b = map.get(t);
      if (!b) map.set(t, (b = { t, byOrg: {}, total: 0 }));
      b.byOrg[org] = (b.byOrg[org] ?? 0) + n;
      b.total += n;
    }
    // Continuous axis: fill empty buckets between the first and last.
    const out: Bucket[] = [];
    if (map.size) {
      const first = Math.min(...map.keys());
      const last = Math.max(...map.keys());
      for (let t = first; t <= last && out.length < 5000; t = nextBucket(t, unit)) {
        out.push(map.get(t) ?? { t, byOrg: {}, total: 0 });
      }
    }
    return { buckets: out, coarse, outside, orgTotals };
  }, [points, from, to, unit]);

  const visiblePlans = included.filter((p) => !hidden.has(p.organism.key));
  const def = instance.catalog.get(field);
  const precisionNote = coarse > 0 && UNIT_RANK[unit] > 0;

  const toggle = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const yearOptions = extent ? Array.from({ length: extent.max - extent.min + 1 }, (_, i) => extent.min + i) : [];

  return (
    <div className="cv">
      <div className="cv-controls">
        <label className="cv-control">
          <span className="label">Date</span>
          <FieldSelect
            id="timeline-field"
            fields={fields}
            value={field}
            onChange={(n) => n && setField(n)}
            totalOrgs={plans.length}
            orgKeys={orgKeys}
          />
        </label>
        <Toggle
          label="Bucket size"
          value={unitChoice}
          onChange={(v) => setUnitChoice(v as 'auto' | Unit)}
          options={[
            { id: 'auto', label: `Auto${unitChoice === 'auto' ? ` (${unit})` : ''}` },
            { id: 'year', label: 'Year' },
            { id: 'month', label: 'Month' },
            { id: 'week', label: 'Week' },
          ]}
        />
        <Toggle
          label="Chart form"
          value={form}
          onChange={(v) => setForm(v as 'bars' | 'area')}
          options={[
            { id: 'bars', label: 'Bars' },
            { id: 'area', label: 'Area' },
          ]}
        />
        <Toggle
          label="Accumulation"
          value={cumulative ? 'cum' : 'per'}
          onChange={(v) => setCumulative(v === 'cum')}
          options={[
            { id: 'per', label: 'Per period' },
            { id: 'cum', label: 'Cumulative' },
          ]}
        />
        {extent && (
          <span className="cv-control">
            <span className="label">Years</span>
            <select
              id="timeline-from"
              className="select"
              style={{ width: 'auto' }}
              value={from}
              onChange={(e) => setRange({ from: Number(e.target.value), to: Math.max(Number(e.target.value), to) })}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <span className="muted">to</span>
            <select
              id="timeline-to"
              className="select"
              style={{ width: 'auto' }}
              value={to}
              onChange={(e) => setRange({ from: Math.min(from, Number(e.target.value)), to: Number(e.target.value) })}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </span>
        )}
        <span className="cv-spacer" />
        {loading && <span className="spinner" aria-label="Loading" />}
        <button className="btn btn-sm" onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
          {showTable ? 'Hide table' : 'Show table'}
        </button>
        {buckets.length > 0 && <CopyButton getText={() => timelineTsv(buckets, included, unit)} />}
      </div>

      {included.length > 1 && (
        <Legend plans={included} totals={orgTotals} hidden={hidden} onToggle={toggle} onFocus={focusOrganism} />
      )}

      {error && <div className="err">{error}</div>}

      <div className={loading ? 'cv-loading' : ''}>
        {!results ? (
          <div className="empty">
            <span className="spinner" /> Loading timeline…
          </div>
        ) : buckets.length === 0 ? (
          <div className="empty">No records in this search have a usable {def?.displayName ?? field}.</div>
        ) : (
          <TimeChart
            buckets={buckets}
            plans={visiblePlans}
            unit={unit}
            form={form}
            cumulative={cumulative}
            setTip={setTip}
          />
        )}
      </div>

      <div className="cv-note num">
        {[
          points.nulls > 0 && `${fmt(points.nulls)} records have no ${def?.displayName ?? field}`,
          precisionNote && `${fmt(coarse)} records have only ${unit === 'week' ? 'year or month' : 'year'} precision and are placed at the start of that period`,
          outside > 0 && (
            <span key="out">
              {fmt(outside)} records fall outside {from}–{to}{' '}
              {extent && (from !== extent.min || to !== extent.max) && (
                <button className="btn btn-ghost btn-sm" onClick={() => setRange({ from: extent.min, to: extent.max })}>
                  Show all years ({extent.min}–{extent.max})
                </button>
              )}
            </span>
          ),
          points.unparsable > 0 && `${fmt(points.unparsable)} records have an unreadable date`,
          excluded.length > 0 &&
            `Not included (no such field): ${excluded.map((r) => instance.organisms.find((o) => o.key === r.organism)?.displayName ?? r.organism).join(', ')}`,
        ]
          .filter(Boolean)
          .map((x, i) => (
            <div key={i}>{x}</div>
          ))}
      </div>

      {showTable && buckets.length > 0 && <TimelineTable buckets={buckets} plans={included} unit={unit} />}
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------- chart ----------

function TimeChart({
  buckets,
  plans,
  unit,
  form,
  cumulative,
  setTip,
}: {
  buckets: Bucket[];
  plans: OrganismPlan[];
  unit: Unit;
  form: 'bars' | 'area';
  cumulative: boolean;
  setTip: (t: TipState | null) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  // Per-organism series, optionally accumulated.
  const series = useMemo(() => {
    const running: Record<string, number> = {};
    return buckets.map((b) => {
      const vals: Record<string, number> = {};
      for (const p of plans) {
        const k = p.organism.key;
        const v = b.byOrg[k] ?? 0;
        running[k] = (running[k] ?? 0) + v;
        vals[k] = cumulative ? running[k] : v;
      }
      return vals;
    });
  }, [buckets, plans, cumulative]);

  const H = 340;
  const M = { t: 14, r: 14, b: 30, l: 54 };
  const iw = Math.max(0, width - M.l - M.r);
  const ih = H - M.t - M.b;
  const totals = series.map((s) => Object.values(s).reduce((a, b) => a + b, 0));
  const maxY = Math.max(1, ...totals);
  const ticks = niceTicks(maxY);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => ih - (v / top) * ih;
  const band = buckets.length ? iw / buckets.length : 0;
  const barGap = band >= 6 ? Math.min(band * 0.2, 6) : band >= 3 ? 1 : 0;
  const bw = Math.min(24, Math.max(0.5, band - barGap));
  const xc = (i: number) => i * band + band / 2;

  // X ticks: pick a month interval so labels are >= ~64px apart.
  const xTicks = useMemo(() => {
    if (!buckets.length || !iw) return [];
    const first = new Date(buckets[0].t);
    const last = new Date(buckets[buckets.length - 1].t);
    const months = Math.max(1, (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1);
    const pxPerMonth = iw / months;
    const interval = [1, 2, 3, 6, 12, 24, 60, 120, 240].find((m) => m * pxPerMonth >= 64) ?? 240;
    const out: { i: number; label: string }[] = [];
    let lastKey = -1;
    buckets.forEach((b, i) => {
      const d = new Date(b.t);
      const mi = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (mi === lastKey) return;
      // week buckets: only the first bucket starting in each month counts
      const monthStart = unit === 'week' ? d.getUTCDate() <= 7 : true;
      if (monthStart && mi % interval === 0) {
        out.push({
          i,
          label: interval >= 12 || d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MONTHS[d.getUTCMonth()],
        });
      }
      lastKey = mi;
    });
    return out;
  }, [buckets, iw, unit]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(buckets.length - 1, Math.floor(((e.clientX - r.left) / r.width) * buckets.length)));
    setHover(i);
    const vals = series[i];
    const b = buckets[i];
    setTip({
      x: e.clientX,
      y: e.clientY,
      content: (
        <>
          <div className="tip-title">
            {bucketLabel(b.t, unit)}
            {cumulative ? ' · cumulative' : ''}
          </div>
          <TipRow value={fmt(totals[i])} label="total" />
          {plans
            .filter((p) => vals[p.organism.key])
            .sort((a, c) => vals[c.organism.key] - vals[a.organism.key])
            .map((p) => (
              <TipRow key={p.organism.key} color={p.organism.color} value={fmt(vals[p.organism.key])} label={p.organism.displayName} />
            ))}
          {totals[i] === 0 && <TipRow value="0" label="no records" muted />}
        </>
      ),
    });
  };

  // Stacked area paths (bottom-up in plan order).
  const areas = useMemo(() => {
    if (form !== 'area' || !buckets.length) return [];
    const base = new Array(buckets.length).fill(0);
    return plans.map((p) => {
      const lower = base.slice();
      const upper = series.map((s, i) => (base[i] += s[p.organism.key] ?? 0));
      const topPts = upper.map((v, i) => `${xc(i)},${y(v)}`);
      const botPts = lower.map((v, i) => `${xc(i)},${y(v)}`).reverse();
      return { p, d: `M${topPts.join('L')}L${botPts.join('L')}Z`, line: `M${topPts.join('L')}` };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, plans, series, iw, top]);

  return (
    <div className="chart-box" ref={box}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Records over time, stacked by organism">
          <g transform={`translate(${M.l},${M.t})`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
                <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" className="num">
                  {t >= 10000 ? fmtCompact(t) : fmt(t)}
                </text>
              </g>
            ))}

            {form === 'bars'
              ? series.map((vals, i) => {
                  let acc = 0;
                  const x = xc(i) - bw / 2;
                  const present = plans.filter((p) => vals[p.organism.key]);
                  const gap = bw >= 3 ? 2 : 0;
                  return (
                    <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                      {present.map((p, j) => {
                        const y0 = y(acc);
                        acc += vals[p.organism.key];
                        const y1 = y(acc);
                        const h = Math.max(0, y0 - y1 - (j > 0 ? gap : 0));
                        const isTop = j === present.length - 1;
                        return (
                          <path
                            key={p.organism.key}
                            fill={p.organism.color}
                            d={topRoundedRect(x, y1, bw, h, isTop && bw >= 8 ? 4 : 0)}
                          />
                        );
                      })}
                    </g>
                  );
                })
              : areas.map(({ p, d, line }) => (
                  <g key={p.organism.key}>
                    <path d={d} fill={p.organism.color} fillOpacity={0.78} />
                    <path d={line} fill="none" stroke="var(--surface)" strokeWidth={1.5} strokeLinejoin="round" />
                  </g>
                ))}

            <line className="chart-axis" x1={0} x2={iw} y1={ih} y2={ih} />
            {xTicks.map((t) => (
              <g key={t.i} transform={`translate(${t.i * band},0)`}>
                <line className="chart-axis" y1={ih} y2={ih + 4} />
                <text y={ih + 17} textAnchor="middle" className="num">
                  {t.label}
                </text>
              </g>
            ))}

            {hover !== null && form === 'area' && (
              <line className="chart-cross" x1={xc(hover)} x2={xc(hover)} y1={0} y2={ih} />
            )}
            <rect
              className="chart-hit"
              x={0}
              y={0}
              width={iw}
              height={ih}
              onPointerMove={onMove}
              onPointerLeave={() => {
                setHover(null);
                setTip(null);
              }}
            />
          </g>
        </svg>
      )}
    </div>
  );
}

// ---------- table view ----------

function TimelineTable({ buckets, plans, unit }: { buckets: Bucket[]; plans: OrganismPlan[]; unit: Unit }) {
  const rows = buckets.filter((b) => b.total > 0);
  return (
    <div className="table-wrap panel data-table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Period</th>
            <th className="num">Total</th>
            {plans.map((p) => (
              <th key={p.organism.key} className="num">
                <span className="dot" style={{ background: p.organism.color, marginRight: 6 }} />
                {p.organism.displayName}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.t}>
              <td className="num">{bucketLabel(b.t, unit)}</td>
              <td className="num">
                <strong>{fmt(b.total)}</strong>
              </td>
              {plans.map((p) => (
                <td key={p.organism.key} className="num">
                  {b.byOrg[p.organism.key] ? fmt(b.byOrg[p.organism.key]) : ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function timelineTsv(buckets: Bucket[], plans: OrganismPlan[], unit: Unit) {
  const iso = (t: number) => {
    const s = new Date(t).toISOString();
    return unit === 'year' ? s.slice(0, 4) : unit === 'month' ? s.slice(0, 7) : s.slice(0, 10);
  };
  const head = ['period', 'total', ...plans.map((p) => p.organism.key)].join('\t');
  const lines = buckets.map((b) => [iso(b.t), b.total, ...plans.map((p) => b.byOrg[p.organism.key] ?? 0)].join('\t'));
  return [head, ...lines].join('\n');
}
