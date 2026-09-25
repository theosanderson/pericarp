import { useState } from 'react';
import { encodeQuery } from '../core/query';
import type { Instance, Query } from '../core/types';

interface Saved {
  name: string;
  query: Query;
  savedAt: number;
}

const storeKey = (instance: Instance) => `lcq:saved:${instance.infoUrl}`;

function read(instance: Instance): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(storeKey(instance)) ?? '[]');
  } catch {
    return [];
  }
}
function write(instance: Instance, list: Saved[]) {
  try {
    localStorage.setItem(storeKey(instance), JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

export default function SavedQueries(props: { instance: Instance; query: Query; onLoad: (q: Query) => void }) {
  const [list, setList] = useState<Saved[]>(() => read(props.instance));
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);

  const save = () => {
    const n = name.trim() || `Query ${list.length + 1}`;
    const next = [{ name: n, query: props.query, savedAt: Date.now() }, ...list.filter((s) => s.name !== n)];
    setList(next);
    write(props.instance, next);
    setName('');
  };

  const copyLink = async () => {
    const url = new URL(location.href);
    url.searchParams.set('q', encodeQuery(props.query));
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt('Copy this link', url.toString());
    }
  };

  return (
    <section className="qsection">
      <div className="qsection-head">
        <h2 className="label">Saved queries</h2>
        <button className="btn btn-ghost btn-sm" onClick={copyLink}>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>
      <form
        className="save-row"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input id="save-name" className="input" placeholder="Name this query" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn">Save</button>
      </form>
      {list.length > 0 && (
        <ul className="saved-list">
          {list.map((s) => (
            <li key={s.name}>
              <button className="saved-load" onClick={() => props.onLoad(s.query)}>
                {s.name}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                aria-label={`Delete ${s.name}`}
                onClick={() => {
                  const next = list.filter((x) => x !== s);
                  setList(next);
                  write(props.instance, next);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
