import { useEffect, useMemo, useState } from 'react';

function formatPlacedAt(ts) {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

/**
 * Full-page Orders tab: order history + current unpaid table total.
 * Uses the same data as FloatingOrderReceipt, but without the floating chip UI.
 * @param {{orders: any[], liveOpenTabTotal: number|null|undefined}} props
 */
export default function OrdersTab({ orders, liveOpenTabTotal }) {
  const [detailOrderId, setDetailOrderId] = useState(null);

  const list = useMemo(() => (orders && orders.length > 0 ? orders : []), [orders]);
  const hasLocalOrders = list.length > 0;

  useEffect(() => {
    // If orders disappear (session cleared), exit detail view.
    if (detailOrderId && !list.some((o) => o.orderId === detailOrderId)) {
      setDetailOrderId(null);
    }
  }, [detailOrderId, list]);

  const detailOrder = detailOrderId ? list.find((o) => o.orderId === detailOrderId) : null;
  const placeLabel = (o) => (String(o?.orderType || '').toLowerCase() === 'parcel' ? 'Parcel' : `Table ${o?.table ?? '—'}`);

  return (
    <section className="orders-tab" aria-label="Your orders">
      <div className="orders-tab__card">
        {detailOrder ? (
          <>
            <div className="order-sheet__head">
              <button type="button" className="btn btn--link order-sheet__back" onClick={() => setDetailOrderId(null)}>
                ← Back
              </button>
            </div>
            <h2 className="order-sheet__detail-title">Order details</h2>
            <p className={`order-sheet__wait ${detailOrder.kitchenRejected ? 'order-sheet__wait--rejected' : ''}`}>
              {detailOrder.kitchenRejected
                ? 'This order was not accepted by the kitchen. Speak to staff if you still need these items.'
                : 'Please wait — we’re preparing your order.'}
            </p>
            <p className="order-sheet__id">
              Order ID: <code>{detailOrder.orderId}</code>
            </p>
            <p className="order-sheet__meta muted">
              {placeLabel(detailOrder)}
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
            <div className="orders-tab__head">
              <h2 className="orders-tab__title">Your orders</h2>
              <span className="orders-tab__count">{list.length}</span>
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
              {list.length === 0 ? <li className="order-history-empty muted">No orders from this phone in this session.</li> : null}
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
                        {formatPlacedAt(o.placedAt) || '—'} · {placeLabel(o)}
                        {o.status ? <> · {String(o.status).toUpperCase()}</> : null}
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
    </section>
  );
}

