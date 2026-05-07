import { Fragment } from 'react';
import { useState } from 'react';

function formatPriceLine(item) {
  const p = Number(item.price) || 0;
  const l = item.priceLarge != null && item.priceLarge > 0 ? Number(item.priceLarge) : null;
  if (l != null) return `₹${p} (M) · ₹${l} (L)`;
  return `₹${p % 1 === 0 ? p : p.toFixed(2)}`;
}

/** Group by category; empty category → "Menu" */
function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    const raw = item.category?.trim() || 'Menu';
    const key = raw.toLowerCase();
    if (!map.has(key)) map.set(key, { label: raw, list: [] });
    map.get(key).list.push(item);
  }
  return [...map.values()]
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    .map((g) => [g.label, g.list]);
}

/**
 * Lists menu items from Firestore (already filtered to available in App).
 * Supports category sections, optional description, optional M/L prices (Add uses main price).
 */
export default function Menu({ items, loading, error, cart, onAdd, onChangeQty }) {
  const [portionPick, setPortionPick] = useState(null);
  if (loading) {
    return (
      <section className="menu" aria-busy="true">
        <h2>Menu</h2>
        <p className="muted">Loading menu…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="menu">
        <h2>Menu</h2>
        <p className="error-text">{error}</p>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section className="menu">
        <h2>Menu</h2>
        <p className="muted">No dishes available right now.</p>
      </section>
    );
  }

  const groups = groupByCategory(items);

  return (
    <section className="menu">
      <h2>Menu</h2>
      {groups.map(([category, list]) => (
        <Fragment key={category}>
          <h3 className="menu-category">{category}</h3>
          <ul className="menu-list">
            {list.map((item) => {
              const qty = cart.reduce((sum, line) => {
                const lineMenuId = line.menuId ?? line.id;
                if (lineMenuId !== item.id) return sum;
                return sum + Number(line.qty || 0);
              }, 0);
              return (
                <li key={item.id} className="menu-row">
                  {item.imageUrl ? (
                    <img className="menu-row__thumb" src={item.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="menu-row__thumb menu-row__thumb--placeholder" aria-hidden="true" />
                  )}
                  <div className="menu-row__info">
                    <span className="menu-row__name">{item.name}</span>
                    {item.description ? <span className="menu-row__desc">{item.description}</span> : null}
                    <span className="menu-row__price">{formatPriceLine(item)}</span>
                  </div>
                  {qty === 0 ? (
                    <button
                      type="button"
                      className="btn btn--primary menu-add-single"
                      onClick={() => {
                        if (item.priceLarge != null && item.priceLarge > 0) {
                          setPortionPick(item);
                          return;
                        }
                        onAdd(item, 'regular');
                      }}
                    >
                      Add
                    </button>
                  ) : (
                    <div className="menu-qty" role="group" aria-label={`Quantity for ${item.name}`}>
                      <button
                        type="button"
                        className="menu-qty__btn"
                        onClick={() => {
                          const candidate = cart
                            .filter((line) => (line.menuId ?? line.id) === item.id)
                            .sort((a, b) => {
                              const aq = Number(a.qty || 0);
                              const bq = Number(b.qty || 0);
                              if (aq !== bq) return bq - aq;
                              const aPortion = String(a.portion || '');
                              const bPortion = String(b.portion || '');
                              return aPortion.localeCompare(bPortion);
                            })[0];
                          if (candidate) onChangeQty(candidate.id, -1);
                        }}
                        aria-label="Decrease quantity"
                      >
                        <span aria-hidden="true">−</span>
                      </button>
                      <span className="menu-qty__value" aria-live="polite">
                        {qty}
                      </span>
                      <button
                        type="button"
                        className="menu-qty__btn menu-qty__btn--plus"
                        onClick={() => {
                          if (item.priceLarge != null && item.priceLarge > 0) {
                            setPortionPick(item);
                            return;
                          }
                          onAdd(item, 'regular');
                        }}
                        aria-label="Increase quantity"
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Fragment>
      ))}
      {portionPick ? (
        <div className="cart-preview-modal" role="dialog" aria-modal="true" aria-labelledby="portion-picker-title">
          <button type="button" className="cart-preview-modal__backdrop" aria-label="Close" onClick={() => setPortionPick(null)} />
          <div className="cart-preview-modal__panel" role="document">
            <header className="cart-preview-modal__head">
              <div className="cart-preview-modal__head-text">
                <h3 id="portion-picker-title">Choose portion</h3>
                <p className="cart-preview-modal__sub">{portionPick.name}</p>
              </div>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setPortionPick(null)}>
                Close
              </button>
            </header>
            <div className="menu-portion-picker">
              <button
                type="button"
                className="btn btn--ghost btn--block"
                onClick={() => {
                  onAdd(portionPick, 'regular');
                  setPortionPick(null);
                }}
              >
                Small / Regular - ₹{Number(portionPick.price || 0).toFixed(2)}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => {
                  onAdd(portionPick, 'large');
                  setPortionPick(null);
                }}
              >
                Large - ₹{Number(portionPick.priceLarge || 0).toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
