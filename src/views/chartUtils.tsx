// Shared helpers for the chart views: sizing, tooltip, legend, field picker, ticks, clipboard.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CatalogField, OrganismPlan } from '../core/types';
import { fmt } from '../core/aggregate';
import './chart.css';

/** Tracks an element's content width. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** Fixed-position tooltip that stays inside the viewport. */
export function Tooltip({ tip }: { tip: TipState | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let left = tip.x + 14;
    let top = tip.y + 14;
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  if (!tip) return null;
  return (
    <div ref={ref} className="tooltip" style={pos} role="status">
      {tip.content}
    </div>
  );
}

/** One tooltip row: line-key in the series color, value first, then name. */
export function TipRow({ color, value, label, muted }: { color?: string; value: string; label: string; muted?: boolean }) {
  return (
    <div className={`tip-row${muted ? ' tip-row-muted' : ''}`}>
      {color ? <span className="tip-key" style={{ background: color }} /> : <span className="tip-key" />}
      <strong className="num">{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Legend({
  plans,
  totals,
  hidden,
  onToggle,
  onFocus,
}: {
  plans: OrganismPlan[];
  totals: Record<string, number>;
  hidden?: Set<string>;
  onToggle?: (key: string) => void;
  onFocus?: (key: string) => void;
}) {
  return (
    <div className="legend" role="list">
      {plans.map((p) => {
        const off = hidden?.has(p.organism.key);
        return (
          <span key={p.organism.key} role="listitem" className={`legend-item${off ? ' legend-off' : ''}`}>
            <button
              className="legend-btn"
              onClick={() => (onToggle ? onToggle(p.organism.key) : onFocus?.(p.organism.key))}
              title={onToggle ? (off ? 'Show' : 'Hide') + ' this organism' : 'Search only this organism'}
              aria-pressed={onToggle ? !off : undefined}
            >
              <span className="legend-swatch" style={{ background: p.organism.color }} />
              <span>{p.organism.displayName}</span>
              <span className="muted num">{fmt(totals[p.organism.key] ?? 0)}</span>
            </button>
            {onToggle && onFocus && (
              <button className="btn-ghost legend-only" onClick={() => onFocus(p.organism.key)} title="Search only this organism">
                only
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Searchable field picker listing how many of the live organisms have each field. */
export function FieldSelect({
  id,
  fields,
  value,
  onChange,
  totalOrgs,
  orgKeys,
  allowNone,
  placeholder = 'Choose a field',
}: {
  id: string;
  fields: CatalogField[];
  value: string | null;
  onChange: (name: string | null) => void;
  totalOrgs: number;
  orgKeys: string[];
  allowNone?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => new Set(orgKeys), [orgKeys]);
  const current = fields.find((f) => f.name === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return fields.filter(
      (f) => !needle || f.displayName.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle),
    );
  }, [fields, q]);

  const pick = (name: string | null) => {
    onChange(name);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="fsel" ref={box}>
      <button id={id} className="btn fsel-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={current ? '' : 'muted'}>{current?.displayName ?? placeholder}</span>
        <span aria-hidden="true" className="muted">▾</span>
      </button>
      {open && (
        <div className="fsel-pop panel">
          <input
            autoFocus
            id={`${id}-search`}
            className="input"
            placeholder="Search fields…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, list.length - 1));
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
              else if (e.key === 'Enter' && list[active]) pick(list[active].name);
              else if (e.key === 'Escape') setOpen(false);
            }}
          />
          <ul className="fsel-list" role="listbox">
            {allowNone && (
              <li role="option" aria-selected={value === null} className="fsel-opt" onMouseDown={() => pick(null)}>
                <span className="muted">None</span>
              </li>
            )}
            {list.map((f, i) => {
              const n = f.organisms.filter((o) => keys.has(o)).length;
              return (
                <li
                  key={f.name}
                  role="option"
                  aria-selected={f.name === value}
                  className={`fsel-opt${i === active ? ' fsel-active' : ''}`}
                  onMouseDown={() => pick(f.name)}
                  onMouseEnter={() => setActive(i)}
                  title={f.definition}
                >
                  <span>{f.displayName}</span>
                  <span className={`num fsel-cov${n < totalOrgs ? ' fsel-partial' : ''}`}>
                    {n}/{totalOrgs}
                  </span>
                </li>
              );
            })}
            {list.length === 0 && <li className="fsel-opt muted">No field matches “{q}”</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Nice" tick values from 0 to max. */
export function niceTicks(max: number, count = 5): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function niceStep(span: number, bins: number) {
  if (span <= 0) return 1;
  const raw = span / bins;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

export async function copyText(text: string, fallbackEl?: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = fallbackEl ?? document.createElement('textarea');
    ta.value = text;
    if (!fallbackEl) document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    if (!fallbackEl) ta.remove();
    return ok;
  }
}

/** Button that copies text and briefly confirms. */
export function CopyButton({ getText, label = 'Copy TSV' }: { getText: () => string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button className="btn btn-sm" onClick={async () => setState((await copyText(getText())) ? 'ok' : 'fail')}>
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

export function Toggle({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rect path with only the top corners rounded (data end), square at the baseline. */
export function topRoundedRect(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export const NULL_LABEL = '(empty)';
