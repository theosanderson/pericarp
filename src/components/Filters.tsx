import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt } from '../core/aggregate';
import { isRangeType, NULL_VALUE } from '../core/query';
import type { CatalogField, Filter, FilterOp, Instance } from '../core/types';
import { useFieldValues } from './useFieldValues';

const OP_LABELS: Record<FilterOp, string> = {
  is: 'is any of',
  isNot: 'is none of',
  contains: 'contains',
  notContains: 'does not contain',
  regex: 'matches regex',
  range: 'between',
  isNull: 'is empty',
  notNull: 'is not empty',
};

export function opsFor(f: Pick<CatalogField, 'type'>): FilterOp[] {
  if (isRangeType(f)) return ['range', 'is', 'isNot', 'isNull', 'notNull'];
  if (f.type === 'boolean') return ['is', 'isNull', 'notNull'];
  return ['is', 'isNot', 'contains', 'notContains', 'regex', 'isNull', 'notNull'];
}

export function defaultOp(f: CatalogField): FilterOp {
  if (isRangeType(f)) return 'range';
  if (f.type === 'boolean' || f.autocomplete) return 'is';
  if (f.substringSearch || f.type === 'authors') return 'contains';
  return 'is';
}

export const displayValue = (v: string | null) => (v === null || v === NULL_VALUE ? '(empty)' : v);

// ---------------------------------------------------------------------------

export function FieldPicker(props: {
  instance: Instance;
  orgKeys: string[];
  onPick: (f: CatalogField) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const selected = props.orgKeys.length ? props.orgKeys : props.instance.organisms.map((o) => o.key);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [props]);

  const groups = useMemo(() => {
    const needle = q.toLowerCase();
    const rows = [...props.instance.catalog.values()]
      .filter((f) => !f.notSearchable || ['accessionVersion', 'accession'].includes(f.name))
      .map((f) => ({ f, n: f.organisms.filter((o) => selected.includes(o)).length }))
      .filter(({ f, n }) => n > 0 && (!needle || f.displayName.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle)));
    const byHeader = new Map<string, typeof rows>();
    for (const r of rows) {
      const h = r.f.header ?? 'Other';
      if (!byHeader.has(h)) byHeader.set(h, []);
      byHeader.get(h)!.push(r);
    }
    for (const list of byHeader.values()) list.sort((a, b) => a.f.displayName.localeCompare(b.f.displayName));
    return [...byHeader.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [props.instance, q, selected]);

  return (
    <div className="popover field-picker" ref={ref}>
      <input
        className="input"
        autoFocus
        placeholder="Search 150+ fields…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
        id="field-picker-search"
      />
      <div className="field-picker-list">
        {groups.length === 0 && <div className="muted pad">No field matches "{q}".</div>}
        {groups.map(([header, rows]) => (
          <div key={header}>
            <div className="label field-group">{header}</div>
            {rows.map(({ f, n }) => (
              <button key={f.name} className="field-option" onClick={() => props.onPick(f)} title={f.definition}>
                <span>{f.displayName}</span>
                <span className="field-meta">
                  <span className="type-tag">{f.type}</span>
                  <span className={n === selected.length ? 'coverage full' : 'coverage'}>
                    {n}/{selected.length}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ValueTokens(props: {
  instance: Instance;
  field: CatalogField;
  orgKeys: string[];
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { values: suggestions, loading } = useFieldValues(props.instance, props.field.name, props.orgKeys, open);

  const matches = useMemo(() => {
    if (!suggestions) return [];
    const needle = text.toLowerCase();
    return suggestions
      .filter((s) => !props.values.includes(s.value ?? NULL_VALUE))
      .filter((s) => !needle || (s.value ?? '').toLowerCase().includes(needle))
      .slice(0, 60);
  }, [suggestions, text, props.values]);

  const add = (v: string) => {
    if (!v || props.values.includes(v)) return;
    props.onChange([...props.values, v]);
    setText('');
    setActive(0);
  };

  const listId = `ac-${props.field.name}`;
  return (
    <div className="tokens" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      {props.values.map((v) => (
        <span className="token" key={v}>
          {displayValue(v)}
          <button
            aria-label={`Remove ${displayValue(v)}`}
            onClick={() => props.onChange(props.values.filter((x) => x !== v))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="token-input"
        id={`value-${props.field.name}`}
        value={text}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        placeholder={props.values.length ? '' : props.field.type === 'boolean' ? 'true / false' : 'Type or pick values…'}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const m = matches[active];
            if (m && (text === '' || (m.value ?? '').toLowerCase().includes(text.toLowerCase()))) add(m.value ?? NULL_VALUE);
            else add(text.trim());
          } else if (e.key === 'Backspace' && !text && props.values.length) {
            props.onChange(props.values.slice(0, -1));
          } else if (e.key === 'Escape') setOpen(false);
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (/[\n\t]/.test(t)) {
            e.preventDefault();
            const vals = t.split(/[\n\t]+/).map((s) => s.trim()).filter(Boolean);
            props.onChange([...new Set([...props.values, ...vals])]);
          }
        }}
      />
      {open && (
        <div className="popover ac-list" id={listId} role="listbox">
          {loading && !suggestions && (
            <div className="muted pad">
              <span className="spinner" /> Collecting values across organisms…
            </div>
          )}
          {suggestions && matches.length === 0 && (
            <div className="muted pad">{text ? `Press Enter to use "${text}"` : 'No more values'}</div>
          )}
          {matches.map((m, i) => (
            <button
              key={m.value ?? NULL_VALUE}
              role="option"
              aria-selected={i === active}
              className="ac-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(m.value ?? NULL_VALUE)}
              onMouseEnter={() => setActive(i)}
            >
              <span className={m.value === null ? 'muted' : ''}>{displayValue(m.value)}</span>
              <span className="ac-count num">
                <span className="ac-orgs">
                  {Object.keys(m.byOrg).slice(0, 6).map((o) => (
                    <span key={o} className="dot" style={{ background: props.instance.organisms.find((x) => x.key === o)?.color }} title={o} />
                  ))}
                </span>
                {fmt(m.total)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RangeInputs(props: { field: CatalogField; filter: Filter; onChange: (f: Filter) => void }) {
  const t = props.field.type;
  const inputType = t === 'date' || t === 'timestamp' ? 'date' : 'number';
  const toDate = (v?: string) => (v && t === 'timestamp' && /^\d+$/.test(v) ? new Date(Number(v) * 1000).toISOString().slice(0, 10) : (v ?? ''));
  return (
    <div className="range">
      <input
        className="input"
        type={inputType}
        step="any"
        aria-label="From"
        id={`from-${props.filter.id}`}
        value={toDate(props.filter.from)}
        onChange={(e) => props.onChange({ ...props.filter, from: e.target.value })}
      />
      <span className="muted">to</span>
      <input
        className="input"
        type={inputType}
        step="any"
        aria-label="To"
        id={`to-${props.filter.id}`}
        value={toDate(props.filter.to)}
        onChange={(e) => props.onChange({ ...props.filter, to: e.target.value })}
      />
    </div>
  );
}

export function FilterRow(props: {
  instance: Instance;
  filter: Filter;
  orgKeys: string[];
  onChange: (f: Filter) => void;
  onRemove: () => void;
}) {
  const { filter: f, instance } = props;
  const field = instance.catalog.get(f.field);
  const selected = props.orgKeys.length ? props.orgKeys : instance.organisms.map((o) => o.key);
  if (!field) {
    return (
      <div className="filter-row">
        <div className="warn">Unknown field {f.field} on this instance.</div>
        <button className="btn btn-ghost" onClick={props.onRemove}>Remove</button>
      </div>
    );
  }
  const coverage = field.organisms.filter((o) => selected.includes(o)).length;

  return (
    <div className="filter-row">
      <div className="filter-head">
        <span className="filter-field" title={field.definition}>
          {field.displayName}
        </span>
        {coverage < selected.length && (
          <span className="coverage" title={`Only ${coverage} of ${selected.length} selected organisms have this field`}>
            {coverage}/{selected.length}
          </span>
        )}
        <select
          className="select op-select"
          aria-label="Operator"
          id={`op-${f.id}`}
          value={f.op}
          onChange={(e) => props.onChange({ ...f, op: e.target.value as FilterOp })}
        >
          {opsFor(field).map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost" aria-label={`Remove ${field.displayName} filter`} onClick={props.onRemove}>
          ×
        </button>
      </div>
      {(f.op === 'is' || f.op === 'isNot') && (
        <ValueTokens instance={instance} field={field} orgKeys={props.orgKeys} values={f.values} onChange={(values) => props.onChange({ ...f, values })} />
      )}
      {(f.op === 'contains' || f.op === 'notContains' || f.op === 'regex') && (
        <div className="text-op">
          <input
            className={f.op === 'regex' ? 'input mono' : 'input'}
            id={`text-${f.id}`}
            value={f.values[0] ?? ''}
            placeholder={f.op === 'regex' ? '^PP_00|Smith' : 'text…'}
            onChange={(e) => props.onChange({ ...f, values: [e.target.value] })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={f.caseInsensitive !== false}
              onChange={(e) => props.onChange({ ...f, caseInsensitive: e.target.checked })}
            />
            Aa ignore case
          </label>
        </div>
      )}
      {f.op === 'range' && <RangeInputs field={field} filter={f} onChange={props.onChange} />}
    </div>
  );
}
