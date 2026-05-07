/**
 * Shown when the kitchen / admin has moved the order past "pending"
 * (status: preparing, ready, etc.). Chef art is inline SVG — no image file.
 */
export default function KitchenStatusCard({ status, orderId }) {
  if (status !== 'preparing' && status !== 'ready') return null;

  const isReady = status === 'ready';

  return (
    <section className="kitchen-card" aria-live="polite">
      <div className={`kitchen-card__art ${isReady ? 'kitchen-card__art--ready' : ''}`} aria-hidden="true">
        <svg className="kitchen-card__chef" viewBox="0 0 120 120" width="96" height="96">
          <title>Chef</title>
          <ellipse cx="60" cy="102" rx="28" ry="8" fill="rgba(22,101,52,0.12)" />
          <path
            d="M60 28c-12 0-22 8-24 20l-8 4 2 8 8-2c2 14 12 24 24 24s22-10 24-24l8 2 2-8-8-4c-2-12-12-20-24-20z"
            fill="#fef3c7"
          />
          <ellipse cx="60" cy="58" rx="22" ry="20" fill="#fde68a" />
          <path d="M38 52c4-6 12-10 22-10s18 4 22 10" fill="none" stroke="#ca8a04" strokeWidth="2" strokeLinecap="round" />
          <circle cx="48" cy="54" r="3" fill="#422006" />
          <circle cx="72" cy="54" r="3" fill="#422006" />
          <path d="M52 68c4 4 12 4 16 0" fill="none" stroke="#a16207" strokeWidth="2" strokeLinecap="round" />
          <path d="M28 32c8-18 24-28 32-28s24 10 32 28" fill="#fff" stroke="#166534" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M34 30c6-4 14-6 26-6s20 2 26 6" fill="#fff" />
          {isReady && <circle cx="92" cy="24" r="12" fill="#22c55e" stroke="#fff" strokeWidth="2" />}
          {isReady && (
            <path
              d="M87 24l3 3 7-7"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
        {!isReady && (
          <>
            <span className="kitchen-card__steam kitchen-card__steam--1" />
            <span className="kitchen-card__steam kitchen-card__steam--2" />
            <span className="kitchen-card__steam kitchen-card__steam--3" />
          </>
        )}
      </div>
      <div className="kitchen-card__copy">
        {isReady ? (
          <>
            <h2 className="kitchen-card__title">Almost there!</h2>
            <p className="kitchen-card__msg">Your order is <strong>ready</strong> — we’ll bring it to your table shortly.</p>
          </>
        ) : (
          <>
            <h2 className="kitchen-card__title">Preparing your order</h2>
            <p className="kitchen-card__msg">Our chef is cooking your meal — fresh veg, made with care. Please wait a moment.</p>
          </>
        )}
        {orderId ? (
          <p className="kitchen-card__idline">
            Order <code>{orderId}</code>
          </p>
        ) : null}
      </div>
    </section>
  );
}
