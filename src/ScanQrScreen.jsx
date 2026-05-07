/**
 * Shown when the guest opens the menu without ?table= in the URL (production QR-only flow).
 * Table number must come from the sticker printed from Admin → Tables & QR.
 */
export default function ScanQrScreen() {
  return (
    <div className="welcome-backdrop" role="presentation">
      <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="scan-qr-title">
        <p className="welcome-hi" id="scan-qr-title">
          Almost there<span className="welcome-wave" aria-hidden="true"> 📱</span>
        </p>
        <h2 className="welcome-brand">Scan your table QR</h2>
        <p className="welcome-tagline">
          Each table has its own code from the café. Open your phone camera, scan the <strong>QR on your table</strong>,
          then order here. Your bill stays on that table until it&apos;s paid at the counter — then the next guest can
          use this table.
        </p>
        <p className="scan-qr-hint muted">
          If you opened a link without <code>?table=</code>, go back and use the QR on your table stand.
        </p>
      </div>
    </div>
  );
}
