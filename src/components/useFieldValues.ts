import { useEffect, useState } from 'react';
import { aggregateAcross, mergeByValue, type MergedValue } from '../core/aggregate';
import type { Instance, OrganismPlan } from '../core/types';

/**
 * Distinct values of `field` across the given organisms (unfiltered, latest versions),
 * merged with counts. Results are cached by the LAPIS client.
 */
export function useFieldValues(instance: Instance, field: string | null, orgKeys: string[], enabled: boolean) {
  const [values, setValues] = useState<MergedValue[] | null>(null);
  const [loading, setLoading] = useState(false);
  const key = orgKeys.join(',');

  useEffect(() => {
    if (!enabled || !field) return;
    const ac = new AbortController();
    const plans: OrganismPlan[] = instance.organisms
      .filter((o) => (key ? key.split(',').includes(o.key) : true) && o.fields.has(field))
      .map((o) => ({
        organism: o,
        advancedQuery: o.fields.has('versionStatus') ? "versionStatus='LATEST_VERSION'" : '',
      }));
    setLoading(true);
    aggregateAcross(plans, [field], ac.signal)
      .then((r) => setValues(mergeByValue(r, field)))
      .catch(() => {})
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [instance, field, key, enabled]);

  return { values, loading };
}
