import { useEffect, useMemo, useRef, useState } from 'react';
import { recordUrl } from '../core/instance';
import { isAbort, lapis, tidyError } from '../core/lapis';
import { quote } from '../core/query';
import type { FieldDef, Instance, Organism } from '../core/types';

type Row = Record<string, unknown>;

function formatValue(def: FieldDef | undefined, value: unknown) {
  if (value === null || value === undefined || value === '') return '';
  if (def?.type === 'timestamp' && typeof value === 'number') {
    return new Date(value * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export default function RecordsDrawer(props: {
  instance: Instance;
  organism: Organism;
  accessionVersion: string;
  addFilter: (field: string, value: string | null) => void;
  onClose: () => void;
}) {
  const { instance, organism, accessionVersion, addFilter, onClose } = props;
  const [record, setRecord] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setRecord(null);
    setError(null);
    lapis<Row>(
      organism.lapisUrl,
      'details',
      { advancedQuery: `accessionVersion=${quote(accessionVersion)}`, limit: 1 },
      { signal: ac.signal, cache: false },
    )
      .then(([r]) => {
        if (r) setRecord(r);
        else setError('This record was not found.');
      })
      .catch((e) => !isAbort(e) && !ac.signal.aborted && setError(tidyError(e)));
    return () => ac.abort();
  }, [organism, accessionVersion]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Group fields by schema header, keeping schema order within each group.
  const groups = useMemo(() => {
    if (!record) return [];
    const map = new Map<string, { def: FieldDef | undefined; name: string; value: string }[]>();
    const seen = new Set<string>();
    const push = (name: string, def: FieldDef | undefined) => {
      seen.add(name);
      const value = formatValue(def, record[name]);
      if (!value && !showEmpty) return;
      const header = def?.header ?? 'Other';
      if (!map.has(header)) map.set(header, []);
      map.get(header)!.push({ def, name, value });
    };
    for (const def of organism.fields.values()) if (def.name in record) push(def.name, def);
    for (const name of Object.keys(record)) if (!seen.has(name)) push(name, undefined);
    return [...map.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : 0));
  }, [record, organism, showEmpty]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(accessionVersion);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused */
    }
  };

  const title = record?.displayName ? String(record.displayName) : accessionVersion;

  return (
    <div className="records-drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="records-drawer" role="dialog" aria-modal="true" aria-label={`Record ${accessionVersion}`}>
        <header className="records-drawer-head">
          <div className="records-drawer-titles">
            <span className="records-org label">
              <span className="dot" style={{ background: organism.color }} />
              {organism.displayName}
            </span>
            <h2 className="records-drawer-title">{title}</h2>
            <div className="mono muted">{accessionVersion}</div>
          </div>
          <button ref={closeRef} className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="records-drawer-actions">
          <a className="btn btn-primary" href={recordUrl(instance, accessionVersion)} target="_blank" rel="noreferrer">
            Open on {instance.title} ↗
          </a>
          <button className="btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy accession'}
          </button>
          <label className="records-drawer-toggle">
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
            Show empty fields
          </label>
        </div>
        <div className="records-drawer-body">
          {error && <div className="err">{error}</div>}
          {!record && !error && (
            <div className="empty">
              <span className="spinner" /> Loading record…
            </div>
          )}
          {groups.map(([header, items]) => (
            <section key={header} className="records-drawer-group">
              <h3 className="label">{header}</h3>
              <dl>
                {items.map(({ def, name, value }) => {
                  const drillable = !!value && def?.type === 'string' && def.autocomplete;
                  const isLink = def?.customDisplay?.type === 'link' && value;
                  const href = isLink ? (def?.customDisplay?.url ?? '__value__').replace('__value__', value) : null;
                  return (
                    <div key={name} className="records-drawer-item">
                      <dt title={def?.definition ?? name}>{def?.displayName ?? name}</dt>
                      <dd>
                        {value ? (
                          href && /^https?:\/\//.test(href) ? (
                            <a href={href} target="_blank" rel="noreferrer">
                              {value}
                            </a>
                          ) : (
                            <span className={def?.type === 'string' ? undefined : 'num'}>{value}</span>
                          )
                        ) : (
                          <span className="muted">–</span>
                        )}
                        {drillable && (
                          <button
                            className="records-drill records-drill-visible"
                            title={`Filter ${def.displayName} = ${value}`}
                            aria-label={`Filter ${def.displayName} = ${value}`}
                            onClick={() => {
                              addFilter(name, String(record![name]));
                              onClose();
                            }}
                          >
                            ⊕
                          </button>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
