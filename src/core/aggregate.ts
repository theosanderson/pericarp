import { lapis, tidyError } from './lapis';
import { planFilter } from './query';
import type { OrganismPlan } from './types';

export interface OrgRows<T> {
  organism: string;
  rows: T[];
  error?: string;
}

/**
 * Runs the same aggregated request against every plan in parallel.
 * Organisms lacking one of `fields` are reported with an error instead of being queried.
 */
export async function aggregateAcross(
  plans: OrganismPlan[],
  fields: string[],
  signal?: AbortSignal,
  extra: Record<string, unknown> = {},
): Promise<OrgRows<Record<string, unknown> & { count: number }>[]> {
  return Promise.all(
    plans.map(async (p) => {
      const lacking = fields.filter((f) => !p.organism.fields.has(f));
      if (lacking.length) return { organism: p.organism.key, rows: [], error: `No field ${lacking.join(', ')}` };
      try {
        const rows = await lapis<Record<string, unknown> & { count: number }>(
          p.organism.lapisUrl,
          'aggregated',
          { ...planFilter(p), ...extra, ...(fields.length ? { fields } : {}) },
          { signal },
        );
        return { organism: p.organism.key, rows };
      } catch (e) {
        if (signal?.aborted) throw e;
        return { organism: p.organism.key, rows: [], error: tidyError(e) };
      }
    }),
  );
}

export interface MergedValue {
  value: string | null;
  total: number;
  byOrg: Record<string, number>;
}

/** Merges per-organism groupBy results on one field into value → counts per organism. */
export function mergeByValue(results: OrgRows<Record<string, unknown> & { count: number }>[], field: string) {
  const map = new Map<string, MergedValue>();
  for (const r of results) {
    for (const row of r.rows) {
      const raw = row[field];
      const value = raw === null || raw === undefined ? null : String(raw);
      const k = value ?? '\u0000';
      let m = map.get(k);
      if (!m) map.set(k, (m = { value, total: 0, byOrg: {} }));
      m.total += row.count;
      m.byOrg[r.organism] = (m.byOrg[r.organism] ?? 0) + row.count;
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

const nf = new Intl.NumberFormat('en-US');
export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : nf.format(n));
export const fmtCompact = (n: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
