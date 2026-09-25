import { useMemo, useRef, useState } from 'react';
import { fmt } from '../core/aggregate';
import { isAbort, lapis, lapisGetUrl, tidyError } from '../core/lapis';
import { planFilter } from '../core/query';
import type { OrganismPlan, ViewProps } from '../core/types';
import './ExportView.css';

const BIG = 200_000;

function downloadLinks(plan: OrganismPlan) {
  const { organism: o } = plan;
  const q = planFilter(plan);
  const links: { label: string; href: string }[] = [
    { label: 'Metadata TSV', href: lapisGetUrl(o.lapisUrl, 'details', { ...q, dataFormat: 'tsv', downloadAsFile: true }) },
    { label: 'Metadata CSV', href: lapisGetUrl(o.lapisUrl, 'details', { ...q, dataFormat: 'csv', downloadAsFile: true }) },
  ];
  if (o.isSegmented) {
    links.push({ label: 'Unaligned FASTA (all)', href: lapisGetUrl(o.lapisUrl, 'unalignedNucleotideSequences', { ...q, downloadAsFile: true }) });
    for (const s of o.segments) {
      links.push({ label: `Unaligned ${s}`, href: lapisGetUrl(o.lapisUrl, `unalignedNucleotideSequences/${encodeURIComponent(s)}`, { ...q, downloadAsFile: true }) });
    }
    for (const s of o.segments) {
      links.push({ label: `Aligned ${s}`, href: lapisGetUrl(o.lapisUrl, `alignedNucleotideSequences/${encodeURIComponent(s)}`, { ...q, downloadAsFile: true }) });
    }
  } else {
    links.push({ label: 'Unaligned FASTA', href: lapisGetUrl(o.lapisUrl, 'unalignedNucleotideSequences', { ...q, downloadAsFile: true }) });
    links.push({ label: 'Aligned FASTA', href: lapisGetUrl(o.lapisUrl, 'alignedNucleotideSequences', { ...q, downloadAsFile: true }) });
  }
  return links;
}

/**
 * Expands a Loculus link-out template. `{{[dataType(:segment)(+rich)(|format)]}}` becomes an
 * encoded LAPIS GET URL for that data with the current filter; `{{literal}}` becomes the encoded literal.
 */
export function expandLinkOut(template: string, plan: OrganismPlan) {
  const o = plan.organism;
  return template.replace(/\{\{(.*?)\}\}/g, (_, inner: string) => {
    const m = /^\[([A-Za-z]+)(?::([^+|\]]+))?(\+rich)?(?:\|([a-z]+))?\]$/.exec(inner.trim());
    if (!m) return encodeURIComponent(inner);
    const [, type, segment, rich, format] = m;
    const endpoint = type === 'metadata' ? 'details' : segment ? `${type}/${encodeURIComponent(segment)}` : type;
    const params: Record<string, unknown> = { ...planFilter(plan) };
    if (type === 'metadata') params.dataFormat = format ?? 'tsv';
    else if (format && format !== 'fasta') params.dataFormat = format;
    if (rich && o.fields.has('displayName')) params.fastaHeaderTemplate = '{accessionVersion}|{displayName}';
    return encodeURIComponent(lapisGetUrl(o.lapisUrl, endpoint, params));
  });
}

function cell(v: unknown, format: 'tsv' | 'csv') {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (format === 'tsv') return s.replace(/[\t\r\n]+/g, ' ');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function saveFile(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const ref = useRef<HTMLPreElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      const sel = window.getSelection();
      if (ref.current && sel) {
        const r = document.createRange();
        r.selectNodeContents(ref.current);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      setState('fail');
    }
    window.setTimeout(() => setState('idle'), 2000);
  };
  return (
    <div className="exp-code">
      <div className="exp-code-head">
        <span className="label">{label}</span>
        <button className="btn btn-ghost btn-sm" onClick={copy}>
          {state === 'ok' ? 'Copied' : state === 'fail' ? 'Selected, press Ctrl+C' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} className="mono">{text}</pre>
    </div>
  );
}

export default function ExportView({ instance, plans, counts }: ViewProps) {
  const total = plans.reduce((s, p) => s + (counts.get(p.organism.key)?.count ?? 0), 0);

  // ---- combined metadata ----
  const available = useMemo(() => {
    const keys = new Set(plans.map((p) => p.organism.key));
    return [...instance.catalog.values()]
      .map((f) => ({ f, n: f.organisms.filter((o) => keys.has(o)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || a.f.displayName.localeCompare(b.f.displayName));
  }, [instance, plans]);

  const defaults = useMemo(() => {
    const keys = plans.map((p) => p.organism.key);
    const pick = new Set<string>(['accessionVersion']);
    for (const { f } of available) {
      // Default to what Loculus itself downloads, if any live organism flags the field.
      if (keys.some((k) => instance.organisms.find((o) => o.key === k)?.fields.get(f.name)?.includeInDownloadsByDefault)) pick.add(f.name);
    }
    return [...pick].filter((n) => available.some((x) => x.f.name === n));
  }, [available, plans, instance]);

  const [fields, setFields] = useState<string[]>(defaults);
  const [fieldSearch, setFieldSearch] = useState('');
  const [format, setFormat] = useState<'tsv' | 'csv'>('tsv');
  const [confirmBig, setConfirmBig] = useState(false);
  const [progress, setProgress] = useState<Record<string, 'pending' | 'done' | string> | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const toggleField = (name: string) =>
    setFields((fs) => (fs.includes(name) ? fs.filter((f) => f !== name) : [...fs, name]));

  const build = async () => {
    if (total > BIG && !confirmBig) {
      setConfirmBig(true);
      return;
    }
    setConfirmBig(false);
    const ac = new AbortController();
    abort.current = ac;
    setBuilding(true);
    setBuildMsg(null);
    const prog: Record<string, string> = Object.fromEntries(plans.map((p) => [p.organism.key, 'pending']));
    setProgress({ ...prog });
    const cols = ['organism', ...fields];
    const lines: string[] = [cols.map((c) => cell(c, format)).join(format === 'tsv' ? '\t' : ',')];
    const sep = format === 'tsv' ? '\t' : ',';
    let rows = 0;
    try {
      await Promise.all(
        plans.map(async (p) => {
          const own = fields.filter((f) => p.organism.fields.has(f));
          try {
            const data = await lapis<Record<string, unknown>>(
              p.organism.lapisUrl,
              'details',
              { ...planFilter(p), fields: own.length ? own : ['accessionVersion'] },
              { signal: ac.signal, cache: false },
            );
            for (const r of data) {
              lines.push([cell(p.organism.key, format), ...fields.map((f) => cell(r[f], format))].join(sep));
            }
            rows += data.length;
            prog[p.organism.key] = 'done';
          } catch (e) {
            if (isAbort(e)) throw e;
            prog[p.organism.key] = tidyError(e);
          }
          setProgress({ ...prog });
        }),
      );
      const host = new URL(instance.infoUrl).hostname;
      const stamp = new Date().toISOString().slice(0, 10);
      saveFile(`${host}-cross-organism-${stamp}.${format}`, lines.join('\n') + '\n', format === 'tsv' ? 'text/tab-separated-values' : 'text/csv');
      setBuildMsg(`Saved ${fmt(rows)} rows from ${plans.length} organisms.`);
    } catch (e) {
      setBuildMsg(isAbort(e) ? 'Cancelled.' : tidyError(e));
    } finally {
      setBuilding(false);
      abort.current = null;
    }
  };

  // ---- recipes ----
  const python = useMemo(() => {
    const entries = plans
      .map((p) => `    ${JSON.stringify(p.organism.key)}: (${JSON.stringify(p.organism.lapisUrl)}, ${JSON.stringify(p.advancedQuery ?? '')}),`)
      .join('\n');
    return `import requests

# Same query, compiled per organism: key -> (LAPIS URL, advanced query)
ORGANISMS = {
${entries}
}

total = 0
for key, (lapis, query) in ORGANISMS.items():
    body = {"advancedQuery": query} if query else {}
    r = requests.post(f"{lapis}/sample/aggregated", json=body, timeout=60)
    r.raise_for_status()
    n = r.json()["data"][0]["count"]
    total += n
    print(f"{key:20} {n:>10,}")
print(f"{'total':20} {total:>10,}")
`;
  }, [plans]);

  const [recipeOrg, setRecipeOrg] = useState(plans[0]?.organism.key ?? '');
  const recipePlan = plans.find((p) => p.organism.key === recipeOrg) ?? plans[0];
  const recipeBody = recipePlan
    ? { ...planFilter(recipePlan), fields: ['accessionVersion', ...fields.filter((f) => f !== 'accessionVersion' && recipePlan.organism.fields.has(f))], dataFormat: 'tsv' }
    : {};
  const bodyJson = JSON.stringify(recipeBody, null, 2);
  const curl = recipePlan
    ? `curl -X POST '${recipePlan.organism.lapisUrl}/sample/details' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(recipeBody).replace(/'/g, "'\\''")}'`
    : '';

  const shownFields = available.filter(
    ({ f }) => !fieldSearch || f.displayName.toLowerCase().includes(fieldSearch.toLowerCase()) || f.name.toLowerCase().includes(fieldSearch.toLowerCase()),
  );

  return (
    <div className="exp">
      <section className="exp-section">
        <div className="exp-head">
          <h2>Per-organism downloads</h2>
          <span className="muted">Direct LAPIS links and external tools with this query applied. {fmt(total)} records in total. ⚠ marks tools given more records than they recommend.</span>
        </div>
        <div className="panel table-wrap">
          <table className="table exp-dl">
            <thead>
              <tr>
                <th>Organism</th>
                <th className="num">Records</th>
                <th>Files</th>
                <th>Open in</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.organism.key}>
                  <td>
                    <span className="dot" style={{ background: p.organism.color }} /> {p.organism.displayName}
                  </td>
                  <td className="num">{fmt(counts.get(p.organism.key)?.count)}</td>
                  <td className="exp-links">
                    {downloadLinks(p).map((l) => (
                      <a key={l.label} className="btn btn-sm" href={l.href} target="_blank" rel="noreferrer">
                        {l.label}
                      </a>
                    ))}
                  </td>
                  <td className="exp-links">
                    {p.organism.linkOuts.length === 0 && <span className="muted">–</span>}
                    {p.organism.linkOuts.map((l) => {
                      const n = counts.get(p.organism.key)?.count ?? 0;
                      const over = l.maxNumberOfRecommendedEntries !== undefined && n > l.maxNumberOfRecommendedEntries;
                      return (
                        <a
                          key={l.name}
                          className={`btn btn-sm${over ? ' exp-over' : ''}`}
                          href={expandLinkOut(l.url, p)}
                          target="_blank"
                          rel="noreferrer"
                          title={over ? `${fmt(n)} records; ${l.name} is recommended for at most ${fmt(l.maxNumberOfRecommendedEntries)}` : undefined}
                        >
                          {over && <span aria-hidden="true">⚠</span>}
                          {l.name}
                        </a>
                      );
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="exp-section">
        <div className="exp-head">
          <h2>Combined metadata</h2>
          <span className="muted">One file across all organisms, with an organism column. Fields an organism lacks are left empty.</span>
        </div>
        <div className="panel exp-builder">
          <div className="exp-fields">
            <div className="exp-fields-head">
              <input
                id="exp-field-search"
                className="input"
                placeholder="Filter fields"
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => setFields(defaults)}>Defaults</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setFields([])}>None</button>
            </div>
            <ul className="exp-field-list">
              {shownFields.map(({ f, n }) => (
                <li key={f.name}>
                  <label>
                    <input type="checkbox" checked={fields.includes(f.name)} onChange={() => toggleField(f.name)} />
                    <span>{f.displayName}</span>
                    <span className="mono muted exp-fname">{f.name}</span>
                    {n < plans.length && <span className="muted num exp-cov">{n}/{plans.length}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div className="exp-actions">
            <div className="label">Columns ({fields.length + 1})</div>
            <div className="exp-selected mono">organism, {fields.join(', ') || '—'}</div>
            <div className="seg" role="group" aria-label="File format">
              <button aria-pressed={format === 'tsv'} onClick={() => setFormat('tsv')}>TSV</button>
              <button aria-pressed={format === 'csv'} onClick={() => setFormat('csv')}>CSV</button>
            </div>
            {confirmBig && (
              <div className="warn">
                This fetches {fmt(total)} rows into your browser, which can take minutes and a lot of memory. Click again to continue, or use the per-organism links above.
              </div>
            )}
            <div className="exp-btns">
              <button className="btn btn-primary" disabled={building || fields.length === 0} onClick={build}>
                {building ? <><span className="spinner" /> Building…</> : confirmBig ? `Yes, fetch ${fmt(total)} rows` : `Download ${fmt(total)} rows`}
              </button>
              {building && <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button>}
            </div>
            {progress && (
              <ul className="exp-progress">
                {plans.map((p) => {
                  const s = progress[p.organism.key];
                  return (
                    <li key={p.organism.key}>
                      <span className="dot" style={{ background: p.organism.color }} />
                      <span>{p.organism.displayName}</span>
                      <span className={s === 'done' ? 'exp-ok' : s === 'pending' ? 'muted' : 'exp-bad'}>
                        {s === 'done' ? 'done' : s === 'pending' ? (building ? 'fetching…' : 'skipped') : s}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {buildMsg && <div className="muted">{buildMsg}</div>}
          </div>
        </div>
      </section>

      <section className="exp-section">
        <div className="exp-head">
          <h2>API recipes</h2>
          <span className="muted">Reproduce this search in scripts. The request bodies include the selected columns above.</span>
        </div>
        <div className="exp-recipe-org">
          <label className="label" htmlFor="exp-recipe-org">Organism</label>
          <select id="exp-recipe-org" className="select" value={recipePlan?.organism.key ?? ''} onChange={(e) => setRecipeOrg(e.target.value)}>
            {plans.map((p) => (
              <option key={p.organism.key} value={p.organism.key}>{p.organism.displayName}</option>
            ))}
          </select>
        </div>
        <div className="exp-recipes">
          <CopyBlock label={`POST ${recipePlan?.organism.lapisUrl}/sample/details`} text={bodyJson} />
          <CopyBlock label="curl" text={curl} />
        </div>
        <CopyBlock label="Python · counts across every organism" text={python} />
      </section>
    </div>
  );
}
