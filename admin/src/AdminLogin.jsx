import { useState } from 'react';

const AUTH_KEY = 'admin_auth';

/**
 * Simple frontend PIN lock — `VITE_ADMIN_PIN` in `admin/.env.local` (baked in at build time).
 * Persists with `localStorage` until Log out.
 */
export default function AdminLogin({ onSuccess }) {
  const correctPin = import.meta.env.VITE_ADMIN_PIN ?? '';
  const pinConfigured = typeof correctPin === 'string' && correctPin.length > 0;

  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [error, setError] = useState(false);

  if (!pinConfigured) {
    return (
      <div className="gate">
        <div className="gate__card">
          <h1 className="gate__title">PIN not configured</h1>
          <p className="gate__hint">
            Add <code>VITE_ADMIN_PIN=...</code> to <code>admin/.env.local</code>, then restart{' '}
            <code>npm run admin:dev</code> or rebuild with <code>npm run build:firebase</code>.
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    setError(false);
    if (pin === correctPin) {
      try {
        localStorage.setItem(AUTH_KEY, 'true');
      } catch {
        /* private mode */
      }
      setPin('');
      onSuccess();
    } else {
      setError(true);
      setShake(true);
      setTimeout(() => setShake(false), 400);
    }
  };

  return (
    <div className="gate">
      <form className={`gate__card ${shake ? 'gate__card--shake' : ''}`} onSubmit={handleSubmit}>
        <h1 className="gate__title">Admin login</h1>
        <p className="gate__hint">Enter the staff PIN to open the kitchen board.</p>
        <label className="gate__label" htmlFor="admin-pin">
          PIN
        </label>
        <input
          id="admin-pin"
          type="password"
          className="gate__input"
          placeholder="Enter PIN"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value);
            setError(false);
          }}
          autoComplete="current-password"
          autoFocus
        />
        {error ? <p className="gate__err">Wrong PIN. Try again.</p> : null}
        <button type="submit" className="btn btn--primary btn--block">
          Log in
        </button>
      </form>
    </div>
  );
}

export function adminLogout() {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
  window.location.reload();
}
