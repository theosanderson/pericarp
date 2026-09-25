// Shared domain types for the cross-organism query UI.

export type FieldType = 'string' | 'int' | 'float' | 'date' | 'timestamp' | 'boolean' | 'authors';

/** A metadata field as declared by one organism's schema. */
export interface FieldDef {
  name: string;
  displayName: string;
  type: FieldType;
  header?: string;
  definition?: string;
  autocomplete?: boolean;
  substringSearch?: boolean;
  rangeSearch?: boolean;
  notSearchable?: boolean;
  initiallyVisible?: boolean;
  hideOnSequenceDetailsPage?: boolean;
  includeInDownloadsByDefault?: boolean;
  /** Values are fractions to be shown as percentages. */
  percentage?: boolean;
  customDisplay?: { type: string; url?: string };
}

/** A field merged across every organism that has it. */
export interface CatalogField extends FieldDef {
  /** Organism keys that define this field. */
  organisms: string[];
}

export interface Organism {
  key: string;
  displayName: string;
  lapisUrl: string;
  image?: string;
  color: string;
  fields: Map<string, FieldDef>;
  /** Nucleotide segment names (e.g. ["L","M","S"]; one entry for unsegmented). */
  segments: string[];
  genes: string[];
  /** Reference length per segment and per gene (amino acids), when the schema carries sequences. */
  referenceLengths: Record<string, number>;
  linkOuts: { name: string; url: string; maxNumberOfRecommendedEntries?: number }[];
  isSegmented: boolean;
  tableColumns: string[];
  defaultOrderBy?: string;
  defaultOrder?: 'ascending' | 'descending';
  primaryKey: string;
}

export interface Instance {
  infoUrl: string;
  title: string;
  website?: string;
  backend?: string;
  organisms: Organism[];
  catalog: Map<string, CatalogField>;
  /** Fields whose values identify a record (from multiFieldSearches 'identifier'). */
  identifierFields: string[];
}

export type FilterOp =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'regex'
  | 'range'
  | 'isNull'
  | 'notNull';

export interface Filter {
  id: string;
  field: string;
  op: FilterOp;
  /** For is/isNot: OR-ed values. For contains/regex: first value. */
  values: string[];
  from?: string;
  to?: string;
  /** Case-insensitive for contains/regex. */
  caseInsensitive?: boolean;
}

export interface MutationFilter {
  id: string;
  organism: string;
  kind: 'nuc' | 'aa';
  /** e.g. "C3000T", "L:G23T", "GPC:Y7C", or "3000" for any change at a position. */
  code: string;
  negate?: boolean;
}

export interface Query {
  /** Organism keys to search; empty = all organisms on the instance. */
  organisms: string[];
  /** Free text / pasted list of identifiers. */
  text: string;
  filters: Filter[];
  /** 'and' requires all filters to match, 'or' any of them. */
  combinator: 'and' | 'or';
  mutations: MutationFilter[];
  /** Raw LAPIS advanced query, AND-ed onto everything else. */
  advanced: string;
  includeRevisions: boolean;
  includeRevocations: boolean;
}

/** Per-organism compiled plan. */
export interface OrganismPlan {
  organism: Organism;
  /** null when the organism was skipped. */
  advancedQuery: string | null;
  skippedReason?: string;
}

export interface CountResult {
  organism: string;
  count: number | null;
  error?: string;
  skippedReason?: string;
}

/** Props every result view receives. */
export interface ViewProps {
  instance: Instance;
  /** Only organisms that are part of the current search and not skipped. */
  plans: OrganismPlan[];
  counts: Map<string, CountResult>;
  /** Changes whenever the query is re-run; use as a React key / effect dep. */
  runId: number;
  /** Adds an `is` filter for field=value (drill-down from charts/tables). */
  addFilter: (field: string, value: string | null) => void;
  /** Restrict search to a single organism. */
  focusOrganism: (key: string) => void;
  /** Adds (or replaces) a range filter on a numeric/date field; either bound may be omitted. */
  addRangeFilter: (field: string, from?: string, to?: string) => void;
  /** Adds a mutation filter for one organism. */
  addMutation: (organism: string, kind: 'nuc' | 'aa', code: string) => void;
}
