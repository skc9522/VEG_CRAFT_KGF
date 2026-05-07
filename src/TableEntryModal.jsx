import { useState } from 'react';

function parseTableNumber(raw) {
  const t = String(raw ?? '').trim();
  if (t === '') return { ok: false, error: 'Enter your table number.' };
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 9999) {
    return { ok: false, error: 'Use a whole number between 1 and 9999.' };
  }
  return { ok: true, value: n };
}

/**
 * Shown when the page was opened without a table QR (?table= or /table/n).
 * Guest can scan the code on the table or type the number printed there.
 */
export default function TableEntryModal({ onSubmitTable }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    const parsed = parseTableNumber(input);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onSubmitTable(parsed.value);
  };

  return (
    <div className="welcome-backdrop" role="presentation">
      <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="table-entry-title">
        <p className="welcome-hi" id="table-entry-title">
          Your table<span className="welcome-wave" aria-hidden="true"> 🪑</span>
        </p>
        <h2 className="welcome-brand">Scan or enter your table</h2>
        <p className="welcome-tagline">
          Scan the <strong>QR code</strong> on your table for the quickest start — or type the <strong>table number</strong>{' '}
          shown on your table stand.
        </p>

        <form className="welcome-form" onSubmit={handleSubmit}>
          <label htmlFor="table-number" className="welcome-label">
            Table number <span className="welcome-optional">(if you didn’t scan)</span>
          </label>
          <input
            id="table-number"
            type="number"
            inputMode="numeric"
            min={1}
            max={9999}
            step={1}
            className="welcome-input"
            placeholder="e.g. 12"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoFocus
          />
          {error ? (
            <p className="table-entry-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn--primary btn--block welcome-cta">
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
