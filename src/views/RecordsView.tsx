import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmt } from '../core/aggregate';
import { recordUrl, sharedFields } from '../core/instance';
import { isAbort, lapis, tidyError } from '../core/lapis';
import type { CatalogField, Instance, OrganismPlan, ViewProps } from '../core/types';
import RecordsDrawer from './RecordsDrawer';
import './RecordsView.css';

const PAGE = 50;
const CHUNK = 100;
const MAX_DEFAULT_COLS = 8;
const SORT_PREFERENCE = ['sampleCollectionDate', 'releasedAtTimestamp', 'earliestReleaseDate', 'accessionVersion'];

type Row = Record<string, unknown>;
type Dir = 'ascending' | 'descending';

interface MergedRow {
  organism: string;
  data: Row;
}

/** One organism's position in the merged stream. Non-null sort values are read first, then nulls. */
interface Cursor {
  plan: OrganismPlan;
  phase: 'values' | 'nulls';
  offset: number;
  buffer: Row[];
  done: boolean;
  error?: string;
}

interface Settings {
  columns?: string[];
  sortField?: string;
  sortDir?: Dir;
}

function storageKey(instance: Instance) {
  return `lcq:records:${instance.infoUrl}`;
}
function readSettings(instance: Instance): Settings {
  try {
    return JSON.parse(localStorage.getItem(storageKey(instance)) ?? '{}') as Settings;
  } catch {
    return {};
  }
}
function writeSettings(instance: Instance, s: Settings) {
  try {
    localStorage.setItem(storageKey(instance), JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

function defaultColumns(instance: Instance, plans: OrganismPlan[]) {
  const keys = plans.map((p) => p.organism.key);
  const half = Math.max(1, Math.ceil(keys.length / 2));
  const score = new Map<string, number>();
  for (const p of plans) {
    p.organism.tableColumns.forEach((c, i) => score.set(c, (score.get(c) ?? 0) + 100 - i));
    for (const f of p.organism.fields.values()) if (f.initiallyVisible) score.set(f.name, (score.get(f.name) ?? 0) + 50);
  }
  const candidates = sharedFields(instance, keys, half)
    .filter((f) => f.name !== 'accessionVersion' && score.has(f.name))
    .sort((a, b) => (score.get(b.name) ?? 0) - (score.get(a.name) ?? 0))
    .slice(0, MAX_DEFAULT_COLS - 1)
    .map((f) => f.name);
  return ['accessionVersion', ...candidates];
}

const numericTypes = new Set(['int', 'float', 'timestamp']);

function compareValues(a: unknown, b: unknown, numeric: boolean, dir: Dir) {
  // Nulls always sort last, independent of direction.
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  let c: number;
  if (numeric) c = Number(a) - Number(b);
  else {
    const sa = String(a);
    const sb = String(b);
    c = sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return dir === 'ascending' ? c : -c;
}

function formatCell(field: CatalogField | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (field?.type === 'timestamp' && typeof value === 'number') {
    return new Date(value * 1000).toISOString().slice(0, 10);
  }
  if (field?.type === 'float' && typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
  }
  return String(value);
}

export default function RecordsView({ instance, plans, counts, addFilter }: ViewProps) {
  const orgKeys = useMemo(() => plans.map((p) => p.organism.key), [plans]);
  const saved = useMemo(() => readSettings(instance), [instance]);

  // Sort fields must exist on every live organism, or the merge can't compare them.
  const sortable = useMemo(
    () => sharedFields(instance, orgKeys, orgKeys.length).filter((f) => f.type !== 'authors'),
    [instance, orgKeys],
  );
  const allFields = useMemo(() => sharedFields(instance, orgKeys, 1), [instance, orgKeys]);

  const [columns, setColumns] = useState<string[]>(() => {
    const cols = saved.columns?.filter((c) => instance.catalog.has(c));
    return cols?.length ? cols : defaultColumns(instance, plans);
  });
  const [sortField, setSortField] = useState<string>(() => {
    const names = new Set(sortable.map((f) => f.name));
    if (saved.sortField && names.has(saved.sortField)) return saved.sortField;
    return SORT_PREFERENCE.find((f) => names.has(f)) ?? sortable[0]?.name ?? 'accessionVersion';
  });
  const [sortDir, setSortDir] = useState<Dir>(saved.sortDir ?? 'descending');

  useEffect(() => writeSettings(instance, { columns, sortField, sortDir }), [instance, columns, sortField, sortDir]);

  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ organism: string; accessionVersion: string } | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);

  const cursors = useRef<Cursor[]>([]);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const sortDef = instance.catalog.get(sortField);
  const numeric = numericTypes.has(sortDef?.type ?? 'string');

  const fetchChunk = useCallback(
    async (c: Cursor, signal: AbortSignal) => {
      const org = c.plan.organism;
      const fields = [...new Set(['accessionVersion', sortField, ...columns])].filter((f) => org.fields.has(f));
      const nullTerm = c.phase === 'values' ? `!isNull(${sortField})` : `isNull(${sortField})`;
      const base = c.plan.advancedQuery;
      const advancedQuery = base ? `(${base}) & ${nullTerm}` : nullTerm;
      const orderBy = [{ field: sortField, type: sortDir }];
      if (sortField !== 'accessionVersion' && org.fields.has('accessionVersion')) {
        orderBy.push({ field: 'accessionVersion', type: 'ascending' });
      }
      const data = await lapis<Row>(
        org.lapisUrl,
        'details',
        { advancedQuery, fields, orderBy, limit: CHUNK, offset: c.offset },
        // Uncached: the shared cache hands one caller's abort to everyone awaiting that key.
        { signal, cache: false },
      );
      c.buffer.push(...data);
      c.offset += data.length;
      if (data.length < CHUNK) {
        if (c.phase === 'values') {
          c.phase = 'nulls';
          c.offset = 0;
        } else c.done = true;
      }
    },
    [sortField, sortDir, columns],
  );

  /** Pulls the next `n` rows from the k-way merge of all cursors. */
  const take = useCallback(
    async (n: number, signal: AbortSignal) => {
      const out: MergedRow[] = [];
      const cs = cursors.current;
      while (out.length < n) {
        signal.throwIfAborted();
        // Every live cursor needs a head row before we can pick the smallest.
        const needy = cs.filter((c) => !c.done && !c.error && c.buffer.length === 0);
        if (needy.length) {
          await Promise.all(
            needy.map(async (c) => {
              // A phase switch can leave the buffer empty; keep fetching until a row or the end.
              while (!c.done && !c.error && c.buffer.length === 0) {
                try {
                  await fetchChunk(c, signal);
                } catch (e) {
                  if (isAbort(e) || signal.aborted) throw e;
                  c.error = tidyError(e);
                }
              }
            }),
          );
          const errs: Record<string, string> = {};
          for (const c of cs) if (c.error) errs[c.plan.organism.key] = c.error;
          setErrors(errs);
        }
        let best: Cursor | null = null;
        for (const c of cs) {
          if (c.buffer.length === 0) continue;
          if (!best || compareValues(c.buffer[0][sortField], best.buffer[0][sortField], numeric, sortDir) < 0) best = c;
        }
        if (!best) break;
        out.push({ organism: best.plan.organism.key, data: best.buffer.shift()! });
      }
      const more = cs.some((c) => c.buffer.length > 0 || (!c.done && !c.error));
      return { out, more };
    },
    [fetchChunk, sortField, sortDir, numeric],
  );

  const loadMore = useCallback(async () => {
    if (busy.current || !abort.current) return;
    busy.current = true;
    setLoading(true);
    const signal = abort.current.signal;
    try {
      const { out, more } = await take(PAGE, signal);
      if (signal.aborted) return;
      setRows((r) => [...r, ...out]);
      setExhausted(!more);
    } catch (e) {
      if (!isAbort(e) && !signal.aborted) setFatal(tidyError(e));
    } finally {
      busy.current = false;
      if (!signal.aborted) setLoading(false);
    }
  }, [take]);

  // Restart the merge whenever the plan set, sort or requested columns change.
  useEffect(() => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    busy.current = false;
    cursors.current = plans.map((plan) => ({ plan, phase: 'values', offset: 0, buffer: [], done: false }));
    setRows([]);
    setErrors({});
    setFatal(null);
    setExhausted(false);
    void loadMore();
    return () => ac.abort();
  }, [plans, loadMore]);

  const total = useMemo(
    () => plans.reduce((s, p) => s + (counts.get(p.organism.key)?.count ?? 0), 0),
    [plans, counts],
  );
  const orgByKey = useMemo(() => new Map(plans.map((p) => [p.organism.key, p.organism])), [plans]);

  const moveColumn = (name: string, delta: number) => {
    setColumns((cols) => {
      const i = cols.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= cols.length) return cols;
      const next = [...cols];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  return (
    <div className="records">
      <div className="records-bar">
        <div className="records-status num">
          Showing <strong>{fmt(rows.length)}</strong> of <strong>{fmt(total)}</strong> records across{' '}
          <strong>{plans.length}</strong> organism{plans.length === 1 ? '' : 's'}
          {loading && <span className="spinner" aria-label="Loading" />}
        </div>
        <div className="records-controls">
          <label className="records-sort">
            <span className="label">Sort</span>
            <select id="records-sort-field" className="select" value={sortField} onChange={(e) => setSortField(e.target.value)}>
              {sortable.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Sort direction">
            <button aria-pressed={sortDir === 'descending'} onClick={() => setSortDir('descending')} title="Descending">
              ↓ Desc
            </button>
            <button aria-pressed={sortDir === 'ascending'} onClick={() => setSortDir('ascending')} title="Ascending">
              ↑ Asc
            </button>
          </div>
          <div className="records-chooser-anchor">
            <button className="btn" aria-expanded={chooserOpen} onClick={() => setChooserOpen((o) => !o)}>
              Columns · {columns.length}
            </button>
            {chooserOpen && (
              <ColumnChooser
                fields={allFields}
                orgCount={orgKeys.length}
                orgKeys={orgKeys}
                columns={columns}
                onChange={setColumns}
                onReset={() => setColumns(defaultColumns(instance, plans))}
                onClose={() => setChooserOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {Object.keys(errors).length > 0 && (
        <div className="warn records-errors">
          {Object.entries(errors).map(([k, e]) => (
            <div key={k}>
              <strong>{orgByKey.get(k)?.displayName ?? k}</strong> left out: {e}
            </div>
          ))}
        </div>
      )}
      {fatal && <div className="err">{fatal}</div>}

      <div className="table-wrap records-table-wrap">
        <table className="table records-table">
          <thead>
            <tr>
              <th>Organism</th>
              {columns.map((c) => {
                const f = instance.catalog.get(c);
                const isSort = c === sortField;
                return (
                  <th key={c} className={numericTypes.has(f?.type ?? '') ? 'num' : undefined}>
                    <span className="records-th">
                      <button
                        className="records-th-sort"
                        title={sortable.some((s) => s.name === c) ? 'Sort by this column' : 'Not present in every organism'}
                        disabled={!sortable.some((s) => s.name === c)}
                        onClick={() => {
                          if (isSort) setSortDir((d) => (d === 'ascending' ? 'descending' : 'ascending'));
                          else setSortField(c);
                        }}
                      >
                        {f?.displayName ?? c}
                        {isSort && <span aria-hidden="true">{sortDir === 'ascending' ? ' ↑' : ' ↓'}</span>}
                      </button>
                      <span className="records-th-move">
                        <button className="btn-ghost" aria-label={`Move ${f?.displayName ?? c} left`} onClick={() => moveColumn(c, -1)}>
                          ‹
                        </button>
                        <button className="btn-ghost" aria-label={`Move ${f?.displayName ?? c} right`} onClick={() => moveColumn(c, 1)}>
                          ›
                        </button>
                      </span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const org = orgByKey.get(r.organism);
              const acc = String(r.data.accessionVersion ?? '');
              return (
                <tr
                  key={`${r.organism}:${acc}`}
                  className="records-row"
                  tabIndex={0}
                  onClick={() => setDrawer({ organism: r.organism, accessionVersion: acc })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setDrawer({ organism: r.organism, accessionVersion: acc });
                  }}
                >
                  <td>
                    <span className="records-org">
                      <span className="dot" style={{ background: org?.color }} />
                      {org?.displayName ?? r.organism}
                    </span>
                  </td>
                  {columns.map((c) => {
                    const f = instance.catalog.get(c);
                    if (!org?.fields.has(c)) {
                      return (
                        <td key={c} className="muted" title="Field not defined for this organism">
                          –
                        </td>
                      );
                    }
                    const raw = r.data[c];
                    const text = formatCell(f, raw);
                    const isNum = numericTypes.has(f?.type ?? '');
                    if (c === 'accessionVersion' && text) {
                      return (
                        <td key={c} className="mono">
                          <a href={recordUrl(instance, text)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            {text}
                          </a>
                        </td>
                      );
                    }
                    const drillable = !!text && f?.type === 'string' && f.autocomplete;
                    return (
                      <td key={c} className={isNum ? 'num' : undefined} title={text || undefined}>
                        {text ? (
                          <span className="records-cell">
                            <span className="records-cell-text">{text}</span>
                            {drillable && (
                              <button
                                className="records-drill"
                                title={`Filter ${f.displayName} = ${text}`}
                                aria-label={`Filter ${f.displayName} = ${text}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  addFilter(c, String(raw));
                                }}
                              >
                                ⊕
                              </button>
                            )}
                          </span>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !loading && !fatal && <div className="empty">No records to show.</div>}
        {rows.length === 0 && loading && (
          <div className="empty">
            <span className="spinner" /> Merging records from {plans.length} organisms…
          </div>
        )}
      </div>

      <div className="records-footer">
        {!exhausted && rows.length > 0 && (
          <button className="btn" onClick={() => void loadMore()} disabled={loading}>
            {loading ? 'Loading…' : `Load ${PAGE} more`}
          </button>
        )}
        {exhausted && rows.length > 0 && <span className="muted">All {fmt(rows.length)} records loaded.</span>}
      </div>

      {drawer && (
        <RecordsDrawer
          instance={instance}
          organism={orgByKey.get(drawer.organism)!}
          accessionVersion={drawer.accessionVersion}
          addFilter={addFilter}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

function ColumnChooser(props: {
  fields: CatalogField[];
  orgCount: number;
  orgKeys: string[];
  columns: string[];
  onChange: (cols: string[]) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { fields, orgCount, orgKeys, columns, onChange, onReset, onClose } = props;
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const keySet = useMemo(() => new Set(orgKeys), [orgKeys]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const q = search.trim().toLowerCase();
  const shown = fields.filter(
    (f) => !q || f.displayName.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
  );

  return (
    <div className="panel records-chooser" ref={ref} role="dialog" aria-label="Choose columns">
      <div className="records-chooser-head">
        <input
          id="records-column-search"
          className="input"
          placeholder="Find a field…"
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn btn-sm" onClick={onReset}>
          Reset
        </button>
      </div>
      <ul className="records-chooser-list">
        {shown.map((f) => {
          const n = f.organisms.filter((o) => keySet.has(o)).length;
          const checked = columns.includes(f.name);
          return (
            <li key={f.name}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(checked ? columns.filter((c) => c !== f.name) : [...columns, f.name])}
                />
                <span className="records-chooser-name">{f.displayName}</span>
                <span className="muted num records-chooser-cov" title={`Defined for ${n} of ${orgCount} organisms`}>
                  {n}/{orgCount}
                </span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && <li className="muted records-chooser-none">No field matches “{search}”.</li>}
      </ul>
    </div>
  );
}
