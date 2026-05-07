import { Fragment, useState, useMemo, useEffect } from 'react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase.js';
import { tryClaimTableLock } from '../../src/tableLockFirestore.js';

function formatPriceLine(item) {
  const p = Number(item.price) || 0;
  const l = item.priceLarge != null && item.priceLarge > 0 ? Number(item.priceLarge) : null;
  if (l != null) return `₹${p} (M) · ₹${l} (L)`;
  return `₹${p % 1 === 0 ? p : p.toFixed(2)}`;
}

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.category?.trim() || 'Menu';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** One row in the manual ticket: from menu (menuId set) or typed (no menuId). */
function normalizeLineForSubmit(line) {
  const name = String(line.name || '').trim();
  const qty = Math.max(1, Number(line.qty) || 1);
  const price = typeof line.price === 'number' ? line.price : Math.max(0, Number(line.price) || 0);
  return { name, qty, price };
}

export default function ManualOrderModal({ open, onClose, tableNumbers, menuItems, openTableNameByNumber, onPlaced }) {
  const [table, setTable] = useState('');
  const [customerName, setCustomerName] = useState('Walk-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  /** Lines picked from menu or custom; menu lines carry `menuId`. */
  const [lines, setLines] = useState([]);

  const sortedTables = useMemo(() => [...tableNumbers].sort((a, b) => a - b), [tableNumbers]);

  const availableMenu = useMemo(() => menuItems.filter((m) => m.available), [menuItems]);

  const menuGroups = useMemo(() => groupByCategory(availableMenu), [availableMenu]);

  useEffect(() => {
    if (!open) return;
    setLines([]);
    setError(null);
  }, [open]);

  const existingTableCustomerName = useMemo(() => {
    const tNum = Number(table);
    if (!Number.isFinite(tNum)) return '';
    const map = openTableNameByNumber instanceof Map ? openTableNameByNumber : null;
    const name = map?.get(tNum);
    if (!name) return '';
    return String(name).trim();
  }, [table, openTableNameByNumber]);

  useEffect(() => {
    if (!open) return;
    if (!table) {
      setCustomerName('Walk-in');
      return;
    }
    if (existingTableCustomerName) {
      setCustomerName(existingTableCustomerName);
      return;
    }
    setCustomerName('Walk-in');
  }, [open, table, existingTableCustomerName]);

  const addFromMenu = (item) => {
    const price = Number(item.price) || 0;
    setLines((prev) => {
      const i = prev.findIndex((l) => l.menuId === item.id);
      if (i === -1) return [...prev, { menuId: item.id, name: item.name, qty: 1, price }];
      const next = [...prev];
      next[i] = { ...next[i], qty: next[i].qty + 1 };
      return next;
    });
  };

  const bumpLineQty = (index, delta) => {
    setLines((prev) => {
      const next = [...prev];
      const nq = next[index].qty + delta;
      if (nq <= 0) return prev.filter((_, j) => j !== index);
      next[index] = { ...next[index], qty: nq };
      return next;
    });
  };

  const removeLine = (index) => {
    setLines((prev) => prev.filter((_, j) => j !== index));
  };

  const addCustomRow = () => {
    setLines((prev) => [...prev, { menuId: undefined, name: '', qty: 1, price: '' }]);
  };

  const updateCustomLine = (index, field, value) => {
    setLines((prev) => {
      const next = [...prev];
      if (!next[index] || next[index].menuId != null) return prev;
      next[index] = {
        ...next[index],
        [field]: field === 'qty' ? Math.max(1, Number(value) || 1) : value,
      };
      return next;
    });
  };

  const totals = useMemo(() => {
    let t = 0;
    for (const ln of lines) {
      const q = Number(ln.qty) || 0;
      const p = typeof ln.price === 'number' ? ln.price : Number(ln.price) || 0;
      if (String(ln.name || '').trim() !== '') t += q * p;
    }
    return t;
  }, [lines]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const tNum = Number(table);
    if (!Number.isFinite(tNum) || tNum < 1) {
      setError('Choose a table number.');
      return;
    }
    const items = lines
      .map((ln) => normalizeLineForSubmit(ln))
      .filter((ln) => ln.name !== '' && ln.price > 0);
    if (items.length === 0) {
      setError('Add at least one menu item, or a custom line with name and price greater than 0.');
      return;
    }
    setBusy(true);
    try {
      // Ensure table QR is blocked for new phones once staff starts a tab.
      // If the table is already locked by a guest session, this will simply be "not claimed" and scanning remains blocked anyway.
      try {
        await tryClaimTableLock(db, tNum, 'admin');
      } catch {
        // Non-fatal: order can still be placed even if lock can't be claimed.
      }
      await addDoc(collection(db, 'orders'), {
        table: tNum,
        customerName: String(customerName || '').trim() || 'Walk-in',
        items,
        total: items.reduce((s, i) => s + i.price * i.qty, 0),
        status: 'pending',
        billingStatus: 'unbilled',
        source: 'admin',
        createdAt: serverTimestamp(),
      });
      onPlaced?.();
      onClose();
      setLines([]);
      setTable('');
      setCustomerName('Walk-in');
    } catch (err) {
      setError(err?.message || 'Could not save order');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="manual-order-overlay" role="presentation">
      <button type="button" className="manual-order-overlay__backdrop" aria-label="Close" onClick={onClose} />
      <div className="manual-order-panel manual-order-panel--wide" role="dialog" aria-modal="true" aria-labelledby="manual-order-title">
        <header className="manual-order-panel__head">
          <h2 id="manual-order-title">Manual order</h2>
          <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
            Close
          </button>
        </header>
        <form className="manual-order-form" onSubmit={handleSubmit}>
          {error ? (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="manual-order-row">
            <label>
              Table
              <select value={table} onChange={(e) => setTable(e.target.value)} required disabled={busy}>
                <option value="">Select…</option>
                {sortedTables.map((n) => (
                  <option key={n} value={n}>
                    Table {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name on ticket
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                disabled={busy}
              />
              {existingTableCustomerName ? (
                <span className="manual-order-field-hint">
                  Auto-filled from current table guest: <strong>{existingTableCustomerName}</strong>
                </span>
              ) : null}
            </label>
          </div>

          <div className="manual-order-menu-block">
            <span className="manual-order-label">Same menu as guests</span>
            {availableMenu.length === 0 ? (
              <p className="muted manual-order-menu-empty">No dishes marked available in Food list.</p>
            ) : (
              <div className="manual-order-menu-scroll">
                {menuGroups.map(([category, list]) => (
                  <Fragment key={category}>
                    <h3 className="manual-order-menu-category">{category}</h3>
                    <ul className="manual-order-menu-list">
                      {list.map((item) => (
                        <li key={item.id} className="manual-order-menu-row">
                          {item.imageUrl ? (
                            <img className="manual-order-menu-thumb" src={item.imageUrl} alt="" loading="lazy" />
                          ) : (
                            <span className="manual-order-menu-thumb manual-order-menu-thumb--ph" aria-hidden="true" />
                          )}
                          <div className="manual-order-menu-info">
                            <span className="manual-order-menu-name">{item.name}</span>
                            {item.description ? (
                              <span className="manual-order-menu-desc">{item.description}</span>
                            ) : null}
                            <span className="manual-order-menu-price">{formatPriceLine(item)}</span>
                          </div>
                          <button type="button" className="btn btn--primary btn--small" disabled={busy} onClick={() => addFromMenu(item)}>
                            Add
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Fragment>
                ))}
              </div>
            )}
          </div>

          <div className="manual-order-summary">
            <span className="manual-order-label">This order</span>
            {lines.length === 0 ? (
              <p className="muted manual-order-summary-empty">Tap Add on menu items above.</p>
            ) : (
              <ul className="manual-order-summary-list">
                {lines.map((ln, i) => (
                  <li key={`${ln.menuId ?? 'c'}-${i}`} className="manual-order-summary-row">
                    <div className="manual-order-summary-main">
                      <span className="manual-order-summary-name">{ln.name || '(unnamed)'}</span>
                      <span className="manual-order-summary-sub">
                        ₹{(typeof ln.price === 'number' ? ln.price : Number(ln.price) || 0).toFixed(2)} each
                      </span>
                    </div>
                    {ln.menuId != null ? (
                      <div className="manual-order-qty" role="group" aria-label={`Quantity for ${ln.name}`}>
                        <button type="button" className="manual-order-qty__btn" disabled={busy} onClick={() => bumpLineQty(i, -1)}>
                          −
                        </button>
                        <span className="manual-order-qty__val">{ln.qty}</span>
                        <button type="button" className="manual-order-qty__btn manual-order-qty__btn--plus" disabled={busy} onClick={() => bumpLineQty(i, 1)}>
                          +
                        </button>
                      </div>
                    ) : (
                      <div className="manual-order-custom-inline">
                        <input
                          type="text"
                          placeholder="Item name"
                          value={ln.name}
                          onChange={(e) => updateCustomLine(i, 'name', e.target.value)}
                          disabled={busy}
                        />
                        <input
                          type="number"
                          min={1}
                          className="manual-order-custom-qty"
                          value={ln.qty}
                          onChange={(e) => updateCustomLine(i, 'qty', e.target.value)}
                          disabled={busy}
                        />
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="manual-order-custom-price"
                          placeholder="₹"
                          value={ln.price}
                          onChange={(e) => updateCustomLine(i, 'price', e.target.value)}
                          disabled={busy}
                        />
                      </div>
                    )}
                    <button type="button" className="btn btn--ghost btn--small" disabled={busy} onClick={() => removeLine(i)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn btn--ghost btn--small manual-order-add-custom" disabled={busy} onClick={addCustomRow}>
              + Item not on menu
            </button>
          </div>

          <p className="manual-order-total">
            <strong>Total ₹{totals.toFixed(2)}</strong>
          </p>
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Saving…' : 'Place kitchen order'}
          </button>
        </form>
      </div>
    </div>
  );
}
