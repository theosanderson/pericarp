import { useState } from 'react';
import { fmt } from '../core/aggregate';
import { emptyQuery, isEmptyQuery, newId, tokenize } from '../core/query';
import type { CountResult, Instance, MutationFilter, OrganismPlan, Query } from '../core/types';
import { defaultOp, FieldPicker, FilterRow } from './Filters';
import SavedQueries from './SavedQueries';

function Section(props: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="qsection">
      <div className="qsection-head">
        <h2 className="label">{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

function mutationPlaceholder(instance: Instance, m: MutationFilter) {
  const org = instance.organisms.find((o) => o.key === m.organism);
  if (!org) return 'C3000T';
  if (m.kind === 'aa') return `${org.genes[0] ?? 'GENE'}:A123T`;
  return org.isSegmented ? `${org.segments[0]}:C300T` : 'C3000T';
}

export default function QueryPanel(props: {
  instance: Instance;
  query: Query;
  onChange: (q: Query) => void;
  plans: OrganismPlan[];
  counts: Map<string, CountResult>;
}) {
  const { instance, query: q, onChange } = props;
  const [picking, setPicking] = useState(false);
  const [showAdvHelp, setShowAdvHelp] = useState(false);
  const all = instance.organisms.map((o) => o.key);
  const isSelected = (k: string) => q.organisms.length === 0 || q.organisms.includes(k);
  const set = (patch: Partial<Query>) => onChange({ ...q, ...patch });

  const toggleOrg = (k: string) => {
    const cur = q.organisms.length ? q.organisms : all;
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    set({ organisms: next.length === all.length ? [] : next });
  };

  const tokens = tokenize(q.text);

  return (
    <div className="qpanel">
      <Section
        title="Organisms"
        aside={
          <div className="qsection-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => set({ organisms: [] })}>All</button>
            <button className="btn btn-ghost btn-sm" onClick={() => set({ organisms: [all[0]] })}>Clear</button>
          </div>
        }
      >
        <ul className="org-list">
          {instance.organisms.map((o) => {
            const c = props.counts.get(o.key);
            const sel = isSelected(o.key);
            return (
              <li key={o.key} className={sel ? 'org-item' : 'org-item off'}>
                <label className="org-label">
                  <input type="checkbox" checked={sel} onChange={() => toggleOrg(o.key)} />
                  <span className="dot" style={{ background: o.color }} />
                  <span className="org-name">{o.displayName}</span>
                </label>
                <button className="org-only btn-ghost btn btn-sm" onClick={() => set({ organisms: [o.key] })} title={`Search only ${o.displayName}`}>
                  only
                </button>
                <span className="org-count num" title={c?.error ?? c?.skippedReason}>
                  {!sel ? '' : c?.error ? <span className="bad">error</span> : c?.skippedReason ? <span className="muted">skipped</span> : c ? fmt(c.count) : '…'}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Identifiers & names">
        <textarea
          id="q-text"
          className="textarea"
          rows={tokens.length > 1 ? 4 : 2}
          placeholder="PP_000SPJP, OQ123456, a submission ID… or paste a list"
          value={q.text}
          onChange={(e) => set({ text: e.target.value })}
          spellCheck={false}
        />
        {tokens.length > 1 && (
          <div className="hint">Matching {tokens.length} identifiers exactly across {instance.identifierFields.length} ID fields.</div>
        )}
        {tokens.length === 1 && <div className="hint">Substring match on accession, INSDC, BioSample, submission ID and display name.</div>}
      </Section>

      <Section
        title="Metadata filters"
        aside={
          q.filters.length > 1 ? (
            <div className="seg" role="group" aria-label="Combine filters">
              <button aria-pressed={q.combinator === 'and'} onClick={() => set({ combinator: 'and' })}>Match all</button>
              <button aria-pressed={q.combinator === 'or'} onClick={() => set({ combinator: 'or' })}>Match any</button>
            </div>
          ) : null
        }
      >
        <div className="filters">
          {q.filters.map((f) => (
            <FilterRow
              key={f.id}
              instance={instance}
              filter={f}
              orgKeys={q.organisms}
              onChange={(nf) => set({ filters: q.filters.map((x) => (x.id === f.id ? nf : x)) })}
              onRemove={() => set({ filters: q.filters.filter((x) => x.id !== f.id) })}
            />
          ))}
        </div>
        <div className="picker-anchor">
          <button className="btn add-btn" onClick={() => setPicking((p) => !p)}>
            + Add filter
          </button>
          {picking && (
            <FieldPicker
              instance={instance}
              orgKeys={q.organisms}
              onClose={() => setPicking(false)}
              onPick={(field) => {
                setPicking(false);
                set({ filters: [...q.filters, { id: newId(), field: field.name, op: defaultOp(field), values: [] }] });
              }}
            />
          )}
        </div>
        {q.combinator === 'and' && q.filters.length > 0 && (
          <div className="hint">Organisms without a filtered field are left out.</div>
        )}
      </Section>

      <Section title="Mutations">
        {q.mutations.map((m) => {
          const upd = (patch: Partial<MutationFilter>) =>
            set({ mutations: q.mutations.map((x) => (x.id === m.id ? { ...x, ...patch } : x)) });
          return (
            <div className="mut-row" key={m.id}>
              <select className="select" aria-label="Organism" id={`mut-org-${m.id}`} value={m.organism} onChange={(e) => upd({ organism: e.target.value })}>
                {instance.organisms.map((o) => (
                  <option key={o.key} value={o.key}>{o.displayName}</option>
                ))}
              </select>
              <div className="mut-line">
                <div className="seg">
                  <button aria-pressed={m.kind === 'nuc'} onClick={() => upd({ kind: 'nuc' })}>nt</button>
                  <button aria-pressed={m.kind === 'aa'} onClick={() => upd({ kind: 'aa' })}>aa</button>
                </div>
                <input
                  className="input mono"
                  id={`mut-code-${m.id}`}
                  value={m.code}
                  placeholder={mutationPlaceholder(instance, m)}
                  onChange={(e) => upd({ code: e.target.value.toUpperCase().replace(/\s/g, '') })}
                />
                <label className="check" title="Exclude sequences carrying this mutation">
                  <input type="checkbox" checked={!!m.negate} onChange={(e) => upd({ negate: e.target.checked })} />
                  not
                </label>
                <button className="btn btn-ghost" aria-label="Remove mutation" onClick={() => set({ mutations: q.mutations.filter((x) => x.id !== m.id) })}>
                  ×
                </button>
              </div>
            </div>
          );
        })}
        <button
          className="btn add-btn"
          onClick={() =>
            set({
              mutations: [
                ...q.mutations,
                { id: newId(), organism: q.organisms[0] ?? instance.organisms[0].key, kind: 'nuc', code: '' },
              ],
            })
          }
        >
          + Add mutation
        </button>
        {q.mutations.length > 0 && <div className="hint">Coordinates are organism-specific, so results narrow to the organisms named here.</div>}
      </Section>

      <Section
        title="Advanced query"
        aside={
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAdvHelp((s) => !s)}>
            {showAdvHelp ? 'Hide syntax' : 'Syntax'}
          </button>
        }
      >
        <textarea
          id="q-advanced"
          className="textarea"
          rows={2}
          spellCheck={false}
          placeholder="hostNameScientific='Homo sapiens' & !isNull(clade)"
          value={q.advanced}
          onChange={(e) => set({ advanced: e.target.value })}
        />
        {showAdvHelp && (
          <div className="adv-help">
            <p>LAPIS advanced query, applied to every selected organism and combined with the filters above.</p>
            <ul className="mono">
              <li>geoLocCountry='Brazil' | geoLocCountry='Peru'</li>
              <li>earliestReleaseDate&gt;=2024-01-01</li>
              <li>length&gt;=10000 &amp; completeness&gt;=0.9</li>
              <li>authors.regex='(?i)silva'</li>
              <li>!isNull(hostAge) &amp; hostAge&lt;5</li>
              <li>NOT versionStatus='REVISED'</li>
            </ul>
          </div>
        )}
      </Section>

      <Section title="Options">
        <label className="check">
          <input type="checkbox" checked={q.includeRevisions} onChange={(e) => set({ includeRevisions: e.target.checked })} />
          Include earlier versions of revised records
        </label>
        <label className="check">
          <input type="checkbox" checked={q.includeRevocations} onChange={(e) => set({ includeRevocations: e.target.checked })} />
          Include revocation entries
        </label>
      </Section>

      <SavedQueries instance={instance} query={q} onLoad={onChange} />

      {!isEmptyQuery(q) && (
        <button className="btn reset-btn" onClick={() => onChange({ ...emptyQuery(), organisms: q.organisms })}>
          Clear all filters
        </button>
      )}
    </div>
  );
}
