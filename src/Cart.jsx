/**
 * Cart summary + place order (sticky at bottom). Quantities are edited on the menu.
 */
import { useState } from 'react';

export default function Cart({ cart, total, onPlaceOrder, placeOrderDisabled, placingOrder }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <footer className="cart-footer">
      <div className="cart-inner">
        <div className="cart-total-row">
          <span className="cart-total-row__label">Total</span>
          <strong className="cart-total-row__amount">₹{total.toFixed(2)}</strong>
        </div>
        <button
          type="button"
          className="btn btn--primary btn--block cart-view-btn"
          onClick={() => setPreviewOpen(true)}
          disabled={placeOrderDisabled}
        >
          <span className="cart-view-btn__text">View order</span>
          <span className="cart-view-btn__chev" aria-hidden="true">
            →
          </span>
        </button>
      </div>

      {previewOpen ? (
        <div className="cart-preview-modal" role="dialog" aria-modal="true" aria-labelledby="cart-preview-title">
          <button type="button" className="cart-preview-modal__backdrop" aria-label="Close" onClick={() => setPreviewOpen(false)} />
          <div className="cart-preview-modal__panel" role="document">
            <header className="cart-preview-modal__head">
              <div className="cart-preview-modal__head-text">
                <h3 id="cart-preview-title">Review your order</h3>
                <p className="cart-preview-modal__sub">Check items once before placing.</p>
              </div>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setPreviewOpen(false)} disabled={placingOrder}>
                Close
              </button>
            </header>

            <ul id="cart-preview-list" className="cart-lines">
              {cart.map((line) => (
                <li key={line.id} className="cart-line cart-line--readonly">
                  <span className="cart-line__name">
                    {line.name} <span className="cart-line__qty-label">× {line.qty}</span>
                  </span>
                  <span className="cart-line__sub">₹{(line.price * line.qty).toFixed(2)}</span>
                </li>
              ))}
            </ul>

            <div className="cart-total-row">
              <span className="cart-total-row__label">Total</span>
              <strong className="cart-total-row__amount">₹{total.toFixed(2)}</strong>
            </div>

            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={onPlaceOrder}
              disabled={placeOrderDisabled}
            >
              {placingOrder ? 'Placing…' : 'Place Order'}
            </button>
          </div>
        </div>
      ) : null}
    </footer>
  );
}
