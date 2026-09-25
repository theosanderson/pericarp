import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadInstance } from './core/instance';
import { isAbort, lapis, tidyError } from './core/lapis';
import { compile, decodeQuery, emptyQuery, encodeQuery, newId, NULL_VALUE, planFilter } from './core/query';
import type { CountResult, Instance, Query, ViewProps } from './core/types';
import InstancePicker from './components/InstancePicker';
import QueryPanel from './components/QueryPanel';
import SummaryStrip from './components/SummaryStrip';
import RecordsView from './views/RecordsView';
import BreakdownView from './views/BreakdownView';
import TimelineView from './views/TimelineView';
import MutationsView from './views/MutationsView';
import ExportView from './views/ExportView';
import './App.css';

const TABS = [
  { id: 'records', label: 'Records', View: RecordsView },
  { id: 'breakdown', label: 'Breakdown', View: BreakdownView },
  { id: 'timeline', label: 'Timeline', View: TimelineView },
  { id: 'mutations', label: 'Mutations', View: MutationsView },
  { id: 'export', label: 'Export', View: ExportView },
] as const;
type TabId = (typeof TABS)[number]['id'];

function readUrl() {
  const p = new URLSearchParams(location.search);
  return {
    instance: p.get('instance'),
    query: decodeQuery(p.get('q')),
    tab: (p.get('tab') as TabId) || 'records',
  };
}

export default function App() {
  const initial = useMemo(readUrl, []);
  const [instanceUrl, setInstanceUrl] = useState<string | null>(initial.instance);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<Query>(initial.query ?? emptyQuery());
  const [tab, setTab] = useState<TabId>(TABS.some((t) => t.id === initial.tab) ? initial.tab : 'records');

  // ---- load instance ----
  useEffect(() => {
    if (!instanceUrl) return;
    const ac = new AbortController();
    setLoading(true);
    setLoadError(null);
    loadInstance(instanceUrl, ac.signal)
      .then((inst) => {
        setInstance(inst);
        document.title = `${inst.title} · Cross-Query`;
      })
      .catch((e) => !isAbort(e) && setLoadError(tidyError(e)))
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [instanceUrl]);

  // ---- URL sync ----
  useEffect(() => {
    const p = new URLSearchParams();
    if (instanceUrl) p.set('instance', instanceUrl);
    if (instanceUrl) p.set('q', encodeQuery(query));
    if (tab !== 'records') p.set('tab', tab);
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }, [instanceUrl, query, tab]);

  // ---- run query (debounced) ----
  const [runId, setRunId] = useState(0);
  const [committed, setCommitted] = useState<Query>(query);
  const debounce = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      setCommitted(query);
      setRunId((n) => n + 1);
    }, 450);
    return () => window.clearTimeout(debounce.current);
  }, [query]);

  const allPlans = useMemo(() => (instance ? compile(committed, instance) : []), [instance, committed]);
  const plans = useMemo(() => allPlans.filter((p) => p.advancedQuery !== null), [allPlans]);

  const [counts, setCounts] = useState<Map<string, CountResult>>(new Map());
  const [counting, setCounting] = useState(false);
  const [doneFor, setDoneFor] = useState<unknown>(null);
  useEffect(() => {
    if (!instance) return;
    const ac = new AbortController();
    const next = new Map<string, CountResult>();
    for (const p of allPlans) {
      if (p.advancedQuery === null) next.set(p.organism.key, { organism: p.organism.key, count: null, skippedReason: p.skippedReason });
    }
    setCounts(new Map(next));
    setCounting(true);
    Promise.all(
      plans.map(async (p) => {
        try {
          const [row] = await lapis<{ count: number }>(p.organism.lapisUrl, 'aggregated', planFilter(p), { signal: ac.signal });
          next.set(p.organism.key, { organism: p.organism.key, count: row?.count ?? 0 });
        } catch (e) {
          if (isAbort(e)) return;
          next.set(p.organism.key, { organism: p.organism.key, count: null, error: tidyError(e) });
        }
        if (!ac.signal.aborted) setCounts(new Map(next));
      }),
    ).finally(() => {
      if (ac.signal.aborted) return;
      setCounting(false);
      setDoneFor(allPlans);
    });
    return () => ac.abort();
  }, [instance, allPlans, plans]);

  // Views only get organisms that returned a count > 0 (or are still loading).
  const livePlans = useMemo(
    () => plans.filter((p) => {
      const c = counts.get(p.organism.key);
      return !c || (c.count ?? 0) > 0;
    }),
    [plans, counts],
  );

  const addFilter = useCallback((field: string, value: string | null) => {
    const v = value ?? NULL_VALUE;
    setQuery((q) => {
      const existing = q.filters.find((f) => f.field === field && f.op === 'is');
      if (existing) {
        if (existing.values.includes(v)) return q;
        return { ...q, filters: q.filters.map((f) => (f === existing ? { ...f, values: [...f.values, v] } : f)) };
      }
      return { ...q, filters: [...q.filters, { id: newId(), field, op: 'is', values: [v] }] };
    });
  }, []);
  const addRangeFilter = useCallback((field: string, from?: string, to?: string) => {
    setQuery((q) => ({
      ...q,
      filters: [...q.filters.filter((f) => !(f.field === field && f.op === 'range')), { id: newId(), field, op: 'range', values: [], from, to }],
    }));
  }, []);
  const addMutation = useCallback((organism: string, kind: 'nuc' | 'aa', code: string) => {
    setQuery((q) =>
      q.mutations.some((m) => m.organism === organism && m.code === code)
        ? q
        : { ...q, mutations: [...q.mutations, { id: newId(), organism, kind, code }] },
    );
  }, []);
  const focusOrganism = useCallback((key: string) => setQuery((q) => ({ ...q, organisms: [key] })), []);

  if (!instance) {
    return (
      <InstancePicker
        initialUrl={instanceUrl ?? ''}
        loading={loading}
        error={loadError}
        onSubmit={(u) => {
          setInstanceUrl(u);
          setQuery(emptyQuery());
        }}
      />
    );
  }

  const viewProps: ViewProps = { instance, plans: livePlans, counts, runId, addFilter, focusOrganism, addMutation, addRangeFilter };
  const ActiveView = TABS.find((t) => t.id === tab)!.View;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-title">{instance.title}</div>
            <div className="brand-sub mono">{new URL(instance.infoUrl).host} · {instance.organisms.length} organisms</div>
          </div>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setInstance(null);
            setInstanceUrl(null);
          }}
        >
          Switch instance
        </button>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <QueryPanel instance={instance} query={query} onChange={setQuery} plans={allPlans} counts={counts} />
        </aside>
        <main className="main">
          <SummaryStrip instance={instance} plans={allPlans} counts={counts} counting={counting} query={query} onChange={setQuery} />
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <section className="view">
            {doneFor !== allPlans ? (
              <div className="empty"><span className="spinner" /> Counting matches across organisms…</div>
            ) : livePlans.length === 0 ? (
              <div className="empty">No organism has records matching this query.</div>
            ) : (
              <ActiveView key={`${tab}-${runId}`} {...viewProps} />
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
