// Minimal LAPIS client: POST JSON, bounded concurrency, response cache for GET-like calls.

const MAX_CONCURRENT = 6;
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export class LapisError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const cache = new Map<string, Promise<unknown>>();

export type LapisBody = Record<string, unknown>;

/** POST `body` to `${lapisUrl}/sample/${endpoint}` and return the `data` array. */
export function lapis<T = Record<string, unknown>>(
  lapisUrl: string,
  endpoint: string,
  body: LapisBody,
  opts: { signal?: AbortSignal; cache?: boolean } = {},
): Promise<T[]> {
  const key = `${lapisUrl}|${endpoint}|${JSON.stringify(body)}`;
  const run = (signal?: AbortSignal) =>
    slot(async () => {
      signal?.throwIfAborted();
      const res = await fetch(`${lapisUrl}/sample/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = json?.error?.detail ?? json?.detail ?? res.statusText;
        throw new LapisError(String(detail), res.status);
      }
      return (json?.data ?? []) as T[];
    });
  if (opts.cache === false) return run(opts.signal);

  // Cached requests are shared between callers, so they run without any one caller's
  // signal; each caller races its own signal instead.
  let p = cache.get(key) as Promise<T[]> | undefined;
  if (!p) {
    p = run();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return withSignal(p, opts.signal);
}

function withSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Plain-text endpoints (TSV/CSV/FASTA). */
export async function lapisText(
  lapisUrl: string,
  endpoint: string,
  body: LapisBody,
  signal?: AbortSignal,
): Promise<string> {
  return slot(async () => {
    const res = await fetch(`${lapisUrl}/sample/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new LapisError(String(json?.error?.detail ?? res.statusText), res.status);
    }
    return res.text();
  });
}

/** A GET URL for the same request, usable as a direct download link. */
export function lapisGetUrl(lapisUrl: string, endpoint: string, params: Record<string, unknown>) {
  const u = new URL(`${lapisUrl}/sample/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return u.toString();
}

/** Shortens LAPIS error messages that list every valid key. */
export function tidyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/Valid keys are:.*$/s, '').replace(/Known fields:.*$/s, '').trim();
}

export function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError';
}
