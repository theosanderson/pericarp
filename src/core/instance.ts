import type { CatalogField, FieldDef, FieldType, Instance, Organism } from './types';

// Categorical palette, mid-luminance so it reads on light and dark grounds.
const PALETTE = [
  // Validated (dataviz validate_palette.js) on #f3f3f7 and #111019: adjacent protan/deutan ΔE ≥ 14.9
  // (including the 16→1 wrap), all pairs ΔE ≥ 9.6 normal vision, ≥ 3:1 contrast on both grounds.
  '#308cf6', '#a7611b', '#936df8', '#107c5a', '#9448cd', '#0d9b0b', '#226daa', '#d02a39',
  '#0e8fa9', '#e15f0a', '#4a64e7', '#e64887', '#726c0f', '#c259d2', '#a88822', '#bf308f',
];

export function organismColor(index: number) {
  return PALETTE[index % PALETTE.length];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadInstance(infoUrl: string, signal?: AbortSignal): Promise<Instance> {
  const url = normalizeInfoUrl(infoUrl);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}`);
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${url} did not return JSON. Point at the instance's /loculus-info endpoint.`);
  }
  return parseInstance(url, json);
}

/** Accepts "pathoplexus.org", "https://pathoplexus.org" or the full /loculus-info URL. */
export function normalizeInfoUrl(input: string) {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/loculus-info';
  return u.toString();
}

export function parseInstance(infoUrl: string, json: any): Instance {
  const lapisHosts: Record<string, string> = json?.hosts?.lapis ?? {};
  const orgEntries = Object.entries<any>(json?.organisms ?? {});
  if (orgEntries.length === 0) throw new Error('No organisms found in this loculus-info response.');

  const organisms: Organism[] = [];
  const catalog = new Map<string, CatalogField>();
  const identifierFields = new Set<string>();

  orgEntries.forEach(([key, org], i) => {
    const schema = org.schema ?? {};
    const lapisUrl = lapisHosts[key];
    if (!lapisUrl) return;
    const fields = new Map<string, FieldDef>();
    for (const m of schema.metadata ?? []) {
      const def: FieldDef = {
        name: m.name,
        displayName: m.displayName ?? m.name,
        type: (m.type ?? 'string') as FieldType,
        header: m.header,
        definition: m.definition,
        autocomplete: m.autocomplete,
        substringSearch: m.substringSearch,
        rangeSearch: m.rangeSearch,
        notSearchable: m.notSearchable,
        initiallyVisible: m.initiallyVisible,
        hideOnSequenceDetailsPage: m.hideOnSequenceDetailsPage,
        includeInDownloadsByDefault: m.includeInDownloadsByDefault,
        percentage: m.percentage,
        customDisplay: m.customDisplay,
      };
      fields.set(def.name, def);
      const existing = catalog.get(def.name);
      if (existing) existing.organisms.push(key);
      else catalog.set(def.name, { ...def, organisms: [key] });
    }
    for (const s of schema.multiFieldSearches ?? []) {
      if (s.name === 'identifier') for (const f of s.fields ?? []) identifierFields.add(f);
    }

    // Reference genomes: segments + genes. Handles both the newer
    // [{name, references:[{name, genes}]}] shape and the older {nucleotideSequences, genes} shape.
    const segments = new Set<string>();
    const genes = new Set<string>();
    const referenceLengths: Record<string, number> = {};
    const rg = org.referenceGenomes;
    if (Array.isArray(rg)) {
      for (const g of rg) {
        for (const r of g.references ?? []) {
          if (r.name) segments.add(r.name);
          if (r.name && typeof r.sequence === 'string') referenceLengths[r.name] = r.sequence.length;
          for (const gene of r.genes ?? []) {
            const name = typeof gene === 'string' ? gene : gene.name;
            genes.add(name);
            if (typeof gene?.sequence === 'string') referenceLengths[name] = gene.sequence.length;
          }
        }
      }
    } else if (rg && typeof rg === 'object') {
      for (const v of Object.values<any>(rg)) {
        for (const s of v?.nucleotideSequences ?? []) {
          segments.add(s.name);
          if (typeof s.sequence === 'string') referenceLengths[s.name] = s.sequence.length;
        }
        for (const g of v?.genes ?? []) {
          genes.add(g.name);
          if (typeof g.sequence === 'string') referenceLengths[g.name] = g.sequence.length;
        }
      }
    }
    const segList = [...segments];
    organisms.push({
      key,
      displayName: schema.organismName ?? key,
      lapisUrl: lapisUrl.replace(/\/$/, ''),
      image: schema.image,
      color: organismColor(i),
      fields,
      segments: segList,
      genes: [...genes],
      referenceLengths,
      linkOuts: Array.isArray(schema.linkOuts) ? schema.linkOuts : [],
      isSegmented: segList.length > 1,
      tableColumns: schema.tableColumns ?? [],
      defaultOrderBy: schema.defaultOrderBy,
      defaultOrder: schema.defaultOrder,
      primaryKey: schema.primaryKey ?? 'accessionVersion',
    });
  });

  if (identifierFields.size === 0) {
    for (const f of ['accessionVersion', 'accession', 'submissionId', 'insdcAccessionFull']) {
      if (catalog.has(f)) identifierFields.add(f);
    }
  }

  return {
    infoUrl,
    title: json?.title ?? new URL(infoUrl).hostname,
    website: json?.hosts?.website,
    backend: json?.hosts?.backend,
    organisms,
    catalog,
    identifierFields: [...identifierFields],
  };
}

/** Link to a record's page on the instance website. */
export function recordUrl(instance: Instance, accessionVersion: string) {
  const base = instance.website ?? new URL(instance.infoUrl).origin;
  return `${base.replace(/\/$/, '')}/seq/${encodeURIComponent(accessionVersion)}`;
}

export function organismByKey(instance: Instance, key: string) {
  return instance.organisms.find((o) => o.key === key);
}

/** Fields shared by at least `min` of the given organisms, sorted by coverage then name. */
export function sharedFields(instance: Instance, orgKeys: string[], min = 1) {
  const set = new Set(orgKeys);
  return [...instance.catalog.values()]
    .map((f) => ({ field: f, n: f.organisms.filter((o) => set.has(o)).length }))
    .filter((x) => x.n >= min)
    .sort((a, b) => b.n - a.n || a.field.displayName.localeCompare(b.field.displayName))
    .map((x) => x.field);
}
