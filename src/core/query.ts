import type { FieldDef, Filter, Instance, MutationFilter, Organism, OrganismPlan, Query } from './types';

/** Sentinel value meaning "field is empty" in is/isNot filters and drill-downs. */
export const NULL_VALUE = '\u0000null';

export const emptyQuery = (): Query => ({
  organisms: [],
  text: '',
  filters: [],
  combinator: 'and',
  mutations: [],
  advanced: '',
  includeRevisions: false,
  includeRevocations: false,
});

let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// ---------- literal formatting ----------

export function quote(s: string) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literal(def: FieldDef, raw: string): string {
  // String values are matched verbatim: stored values can carry leading/trailing whitespace.
  const v = def.type === 'string' || def.type === 'authors' ? raw : raw.trim();
  switch (def.type) {
    case 'int':
    case 'float':
      if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`"${v}" is not a number (${def.displayName})`);
      return def.type === 'int' ? String(Math.trunc(Number(v))) : v;
    case 'boolean':
      if (!/^(true|false)$/i.test(v)) throw new Error(`${def.displayName} must be true or false`);
      return v.toLowerCase();
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`"${v}" is not a date (YYYY-MM-DD)`);
      return v;
    case 'timestamp': {
      if (/^\d+$/.test(v)) return v;
      const t = Date.parse(v);
      if (Number.isNaN(t)) throw new Error(`"${v}" is not a date or timestamp`);
      return String(Math.floor(t / 1000));
    }
    default:
      return quote(v);
  }
}

export function isRangeType(def: Pick<FieldDef, 'type'>) {
  return ['int', 'float', 'date', 'timestamp'].includes(def.type);
}

// ---------- compilation ----------

function or(terms: string[]) {
  return terms.length === 1 ? terms[0] : `(${terms.join(' | ')})`;
}

export function compileFilter(f: Filter, def: FieldDef): string | null {
  const n = f.field;
  const vals = f.values.filter((v) => v !== '');
  const ci = f.caseInsensitive !== false ? '(?i)' : '';
  switch (f.op) {
    case 'is':
    case 'isNot': {
      if (vals.length === 0) return null;
      const t = or(vals.map((v) => (v === NULL_VALUE ? `isNull(${n})` : `${n}=${literal(def, v)}`)));
      return f.op === 'is' ? t : `!${t.startsWith('(') ? t : `(${t})`}`;
    }
    case 'contains':
    case 'notContains': {
      if (!vals[0]) return null;
      const t = `${n}.regex=${quote(ci + escapeRegex(vals[0]))}`;
      return f.op === 'contains' ? t : `!(${t})`;
    }
    case 'regex':
      if (!vals[0]) return null;
      return `${n}.regex=${quote(ci + vals[0])}`;
    case 'range': {
      const parts: string[] = [];
      if (f.from) parts.push(`${n}>=${literal(def, f.from)}`);
      if (f.to) {
        // A date typed into a timestamp range means "through the end of that day".
        const to = literal(def, f.to);
        const inclusive = def.type === 'timestamp' && !/^\d+$/.test(f.to.trim()) ? String(Number(to) + 86399) : to;
        parts.push(`${n}<=${inclusive}`);
      }
      if (parts.length === 0) return null;
      return parts.length === 1 ? parts[0] : `(${parts.join(' & ')})`;
    }
    case 'isNull':
      return `isNull(${n})`;
    case 'notNull':
      return `!isNull(${n})`;
  }
}

/** Splits pasted text into identifier tokens. */
export function tokenize(text: string) {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function compileText(text: string, org: Organism, identifierFields: string[]): string | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const fields = identifierFields.filter((f) => org.fields.has(f));
  if (org.fields.has('displayName') && !fields.includes('displayName')) fields.push('displayName');
  if (fields.length === 0) return null;
  let pattern: string;
  if (tokens.length === 1) {
    pattern = '(?i)' + escapeRegex(tokens[0]);
  } else {
    // A list: match any token exactly, tolerating a missing ".version" suffix.
    pattern = `(?i)^(?:${tokens.map(escapeRegex).join('|')})(?:\\.\\d+)?$`;
  }
  return or(fields.map((f) => `${f}.regex=${quote(pattern)}`));
}

function compileMutation(m: MutationFilter): string {
  const code = m.code.trim();
  return m.negate ? `!${code}` : code;
}

export interface CompileOptions {
  /** Drop the text/filter part for this field (e.g. when faceting on it). */
  ignoreField?: string;
}

/**
 * Compiles the query into one LAPIS advanced query per organism. Organisms that cannot
 * satisfy the query (missing fields, mutation filters scoped elsewhere) are skipped with a reason.
 */
export function compile(q: Query, instance: Instance, opts: CompileOptions = {}): OrganismPlan[] {
  const selected = q.organisms.length
    ? instance.organisms.filter((o) => q.organisms.includes(o.key))
    : instance.organisms;

  return selected.map((org): OrganismPlan => {
    try {
      const terms: string[] = [];
      if (!q.includeRevisions && org.fields.has('versionStatus')) terms.push(`versionStatus='LATEST_VERSION'`);
      if (!q.includeRevocations && org.fields.has('isRevocation')) terms.push('isRevocation=false');

      const text = compileText(q.text, org, instance.identifierFields);
      if (text) terms.push(text);

      const filters = q.filters.filter((f) => f.field !== opts.ignoreField);
      const filterTerms: string[] = [];
      const missing: string[] = [];
      for (const f of filters) {
        const def = org.fields.get(f.field);
        if (!def) {
          missing.push(instance.catalog.get(f.field)?.displayName ?? f.field);
          continue;
        }
        const t = compileFilter(f, def);
        if (t) filterTerms.push(t);
      }
      if (q.combinator === 'and') {
        if (missing.length) return { organism: org, advancedQuery: null, skippedReason: `No field ${missing.join(', ')}` };
        terms.push(...filterTerms);
      } else if (filterTerms.length) {
        terms.push(or(filterTerms));
      } else if (missing.length) {
        return { organism: org, advancedQuery: null, skippedReason: `None of the OR-ed fields exist` };
      }

      if (q.mutations.length) {
        const mine = q.mutations.filter((m) => m.organism === org.key && m.code.trim());
        if (mine.length === 0) {
          return { organism: org, advancedQuery: null, skippedReason: 'Mutation filters target other organisms' };
        }
        terms.push(...mine.map(compileMutation));
      }

      if (q.advanced.trim()) terms.push(`(${q.advanced.trim()})`);
      return { organism: org, advancedQuery: terms.join(' & ') };
    } catch (e) {
      return { organism: org, advancedQuery: null, skippedReason: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** Request body fragment carrying the organism's filter. */
export function planFilter(plan: OrganismPlan): Record<string, unknown> {
  return plan.advancedQuery ? { advancedQuery: plan.advancedQuery } : {};
}

// ---------- URL state ----------

function b64encode(s: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function b64decode(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeQuery(q: Query) {
  return b64encode(JSON.stringify(q));
}

export function decodeQuery(s: string | null): Query | null {
  if (!s) return null;
  try {
    return { ...emptyQuery(), ...JSON.parse(b64decode(s)) };
  } catch {
    return null;
  }
}

export function isEmptyQuery(q: Query) {
  return !q.text.trim() && q.filters.length === 0 && q.mutations.length === 0 && !q.advanced.trim();
}
