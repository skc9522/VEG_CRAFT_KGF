import { useEffect, useState } from 'react';

function formatPlacedAt(ts) {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
}

/**
 * Corner chip + sheet: full order history for this browser tab (newest first).
 * Tap an order to see ID, items, and amount; Back returns to the list.
 * @param {number | null | undefined} liveOpenTabTotal — Firestore unpaid total for this table; `null` = loading; `undefined` = hide.
 */
export default function FloatingOrderReceipt({ orders, open, onToggle, liveOpenTabTotal }) {
  const [detailOrderId, setDetailOrderId] = useState(null);
  const list = orders && orders.length > 0 ? orders : [];
  const hasLocalOrders = list.length > 0;
  const showWidget = hasLocalOrders || liveOpenTabTotal !== undefined;

  useEffect(() => {
    if (!open) setDetailOrderId(null);
  }, [open]);

  if (!showWidget) return null;

  const latest = hasLocalOrders ? list[0] : null;
  const detailOrder = detailOrderId ? list.find((o) => o.orderId === detailOrderId) : null;

  const tabSub =
    liveOpenTabTotal === undefined
      ? null
      : liveOpenTabTotal === null
        ? 'Open tab: updating…'
        : `Open tab ₹${Number(liveOpenTabTotal).toFixed(2)} (pay at counter)`;

  return (
    <>
      <button
        type="button"
        className="order-chip"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        aria-controls="order-receipt-sheet"
      >
        <span className="order-chip__icon" aria-hidden="true">
          ✓
        </span>
        <span className="order-chip__text">
          <span className="order-chip__title">
            {hasLocalOrders ? `Order history (${list.length})` : 'Table bill'}
          </span>
          <span className="order-chip__sub">
            {tabSub ? <>{tabSub}</> : null}
            {tabSub && hasLocalOrders ? <span aria-hidden="true"> · </span> : null}
            {hasLocalOrders ? <>Latest ₹{latest.total.toFixed(2)} · tap to view</> : 'Tap to view details'}
          </span>
        </span>
      </button>

      {open && (
        <div
          className="order-sheet-backdrop"
          role="presentation"
          onClick={() => onToggle(false)}
        >
          <div
            className="order-sheet order-sheet--history"
            id="order-receipt-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-sheet-title"
            onClick={(e) => e.stopPropagation()}
          >
            {detailOrder ? (
              <>
                <div className="order-sheet__head">
                  <button type="button" className="btn btn--link order-sheet__back" onClick={() => setDetailOrderId(null)}>
                    ← Order history
                  </button>
                  <button type="button" className="btn btn--icon order-sheet__close" onClick={() => onToggle(false)} aria-label="Close">
                    ×
                  </button>
                </div>
                <h2 id="order-sheet-title" className="order-sheet__detail-title">
                  Order details
                </h2>
                <p className={`order-sheet__wait ${detailOrder.kitchenRejected ? 'order-sheet__wait--rejected' : ''}`}>
                  {detailOrder.kitchenRejected
                    ? 'This order was not accepted by the kitchen. Speak to staff if you still need these items.'
                    : 'Please wait — we’re preparing your order.'}
                </p>
                <p className="order-sheet__id">
                  Order ID: <code>{detailOrder.orderId}</code>
                </p>
                <p className="order-sheet__meta muted">
                  Table {detailOrder.table}
                  {detailOrder.placedAt ? <> · {formatPlacedAt(detailOrder.placedAt)}</> : null}
                </p>
                <ul className="order-sheet__lines">
                  {detailOrder.items.map((line, idx) => (
                    <li key={`${detailOrder.orderId}-${line.name}-${idx}`} className="order-sheet__line">
                      <span>
                        {line.name} × {line.qty}
                      </span>
                      <span>₹{(line.price * line.qty).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
                <div className="order-sheet__total">
                  <span>Amount</span>
                  <strong>₹{detailOrder.total.toFixed(2)}</strong>
                </div>
              </>
            ) : (
              <>
                <div className="order-sheet__head">
                  <h2 id="order-sheet-title">Your order history</h2>
                  <button type="button" className="btn btn--icon order-sheet__close" onClick={() => onToggle(false)} aria-label="Close">
                    ×
                  </button>
                </div>
                {liveOpenTabTotal !== undefined ? (
                  <p className="order-sheet__open-tab-live">
                    <strong>Total due for this table</strong>{' '}
                    {liveOpenTabTotal === null ? (
                      <span className="muted">Updating…</span>
                    ) : (
                      <strong className="order-sheet__open-tab-live-amt">₹{Number(liveOpenTabTotal).toFixed(2)}</strong>
                    )}
                    <span className="muted"> — includes every unpaid order on this table (you + staff).</span>
                  </p>
                ) : null}
                <p className="order-sheet__intro muted">
                  {hasLocalOrders
                    ? 'Orders placed from this phone (this tab). Tap one for line items.'
                    : 'No orders from this phone yet — your running total still includes anything staff added for this table.'}
                </p>
                <ul className="order-history-list">
                  {list.length === 0 ? (
                    <li className="order-history-empty muted">No orders from this phone in this session.</li>
                  ) : null}
                  {list.map((o) => (
                    <li key={o.orderId}>
                      <button type="button" className="order-history-row" onClick={() => setDetailOrderId(o.orderId)}>
                        <span className="order-history-row__main">
                          <span className="order-history-row__total">
                            ₹{o.total.toFixed(2)}
                            {o.kitchenRejected ? (
                              <span className="order-history-row__badge-rejected" title="Not accepted by kitchen">
                                {' '}
                                Not accepted
                              </span>
                            ) : null}
                          </span>
                          <span className="order-history-row__meta">
                            {formatPlacedAt(o.placedAt) || '—'} · Table {o.table}
                          </span>
                          <span className="order-history-row__id">{o.orderId}</span>
                        </span>
                        <span className="order-history-row__chev" aria-hidden="true">
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
