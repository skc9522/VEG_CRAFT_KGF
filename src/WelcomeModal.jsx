import { useState } from 'react';

/** Turn typed name into a friendly display (empty → Buddy). */
export function formatGuestName(raw) {
  const t = raw.trim();
  if (!t) return 'Buddy';
  return t
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * First screen: hi + optional name, then continue into the menu.
 */
export default function WelcomeModal({ onContinue }) {
  const [nameInput, setNameInput] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onContinue(formatGuestName(nameInput));
  };

  return (
    <div className="welcome-backdrop" role="presentation">
      <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <p className="welcome-hi" id="welcome-title">
          Hi<span className="welcome-wave" aria-hidden="true"> 👋</span>
        </p>
        <h2 className="welcome-brand">Welcome to VEG CRAFT</h2>
        <p className="welcome-tagline">Fresh veg flavours, straight from our kitchen to your table.</p>

        <form className="welcome-form" onSubmit={handleSubmit}>
          <label htmlFor="guest-name" className="welcome-label">
            What should we call you? <span className="welcome-optional">(optional)</span>
          </label>
          <input
            id="guest-name"
            type="text"
            className="welcome-input"
            placeholder="Your name — or skip"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            maxLength={60}
            autoComplete="given-name"
          />
          <button type="submit" className="btn btn--primary btn--block welcome-cta">
            See the menu
          </button>
        </form>
      </div>
    </div>
  );
}
