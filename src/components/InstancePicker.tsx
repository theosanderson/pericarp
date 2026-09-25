import { useState } from 'react';

const EXAMPLES = [
  { label: 'Pathoplexus', url: 'https://pathoplexus.org/loculus-info' },
  { label: 'Loculus main (dev)', url: 'https://main.loculus.org/loculus-info' },
];

export default function InstancePicker(props: {
  initialUrl: string;
  loading: boolean;
  error: string | null;
  onSubmit: (url: string) => void;
}) {
  const [url, setUrl] = useState(props.initialUrl || EXAMPLES[0].url);

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="56" height="56">
            <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
            <circle cx="24" cy="26" r="5" fill="currentColor" />
            <circle cx="40" cy="36" r="6.5" fill="currentColor" opacity="0.75" />
            <circle cx="28" cy="43" r="3" fill="currentColor" opacity="0.5" />
            <circle cx="42" cy="21" r="2.5" fill="currentColor" opacity="0.6" />
          </svg>
        </div>
        <h1 className="landing-title">Query every organism in a Loculus database at once</h1>
        <p className="landing-lede">
          Point at an instance's <span className="mono">/loculus-info</span> endpoint. Cross-Query reads each organism's
          schema and LAPIS server, then runs one search across all of them: shared metadata filters, identifier
          lookups, mutations and raw advanced queries.
        </p>
        <form
          className="landing-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) props.onSubmit(url.trim());
          }}
        >
          <label htmlFor="instance-url" className="label">
            Instance info URL
          </label>
          <div className="landing-row">
            <input
              id="instance-url"
              className="input landing-input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://pathoplexus.org/loculus-info"
              spellCheck={false}
              autoFocus
            />
            <button className="btn btn-primary landing-go" disabled={props.loading}>
              {props.loading ? <span className="spinner" /> : null}
              {props.loading ? 'Reading schema…' : 'Connect'}
            </button>
          </div>
          <div className="landing-examples">
            <span className="muted">Try</span>
            {EXAMPLES.map((ex) => (
              <button
                type="button"
                key={ex.url}
                className="chip"
                onClick={() => {
                  setUrl(ex.url);
                  props.onSubmit(ex.url);
                }}
              >
                {ex.label}
              </button>
            ))}
          </div>
          {props.error && (
            <div className="err" role="alert">
              Could not load the instance: {props.error}. Check the address, or that the host allows cross-origin
              requests.
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
