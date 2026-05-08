import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { collection, onSnapshot, setDoc, deleteDoc, doc, writeBatch, serverTimestamp, getDoc } from 'firebase/firestore';
import { db } from './firebase.js';
/** Must use the browser build — the package `main` points at Node/canvas and fails in Vite. */
import * as QRBrowser from 'qrcode/lib/browser.js';

/**
 * Base URL encoded in table QRs (no trailing slash). Links look like: `${base}/?table=3`
 * 1) VITE_CUSTOMER_APP_URL when set (custom domain or explicit URL)
 * 2) https://<VITE_FIREBASE_PROJECT_ID>.web.app — default Firebase Hosting URL (e.g. veg-cafe → veg-cafe.web.app)
 * 3) window.location.origin — last resort (often localhost; bad for phone scans)
 */
function resolveCustomerQrBaseUrl() {
  const fromEnv = import.meta.env.VITE_CUSTOMER_APP_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { baseUrl: fromEnv.trim().replace(/\/$/, ''), source: 'env' };
  }
  const projectId =
    typeof import.meta.env.VITE_FIREBASE_PROJECT_ID === 'string' ? import.meta.env.VITE_FIREBASE_PROJECT_ID.trim() : '';
  if (projectId) {
    return { baseUrl: `https://${projectId}.web.app`, source: 'firebase-default' };
  }
  if (typeof window !== 'undefined') {
    return { baseUrl: window.location.origin.replace(/\/$/, ''), source: 'origin' };
  }
  return { baseUrl: '', source: 'origin' };
}

function displayTableNumberForCopy(t) {
  const n = Number(t?.number);
  return Number.isFinite(n) ? n : t?.id ?? '—';
}

function fileSafePart(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Localhost in a QR cannot work on a real phone — the phone's "localhost" is not your PC. */
function qrBaseHostIsLocalhost(base) {
  if (!base) return false;
  try {
    const { hostname } = new URL(base);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/** PNG data URL via canvas, or SVG data URL fallback (no canvas quirks). */
async function qrToDisplayableDataUrl(text) {
  const toDataURL = QRBrowser.toDataURL;
  const toString = QRBrowser.toString;
  if (typeof toDataURL === 'function') {
    try {
      return await toDataURL(text, {
        width: 200,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#14532dff', light: '#ffffffff' },
      });
    } catch {
      /* try SVG */
    }
  }
  if (typeof toString === 'function') {
    const svg = await toString(text, { width: 200, margin: 2 });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  throw new Error('QR library did not expose toDataURL/toString');
}

function downloadDataUrl(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function buildQrCardDataUrl(qrDataUrl, labelText) {
  if (typeof window === 'undefined') return qrDataUrl;
  const img = new window.Image();
  img.decoding = 'async';
  const loaded = new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  img.src = qrDataUrl;
  try {
    await loaded;
  } catch {
    return qrDataUrl;
  }

  const pad = 32;
  const w = 720;
  const qrSize = 460;
  const h = 860;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return qrDataUrl;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  ctx.fillStyle = '#14532d';
  ctx.textAlign = 'center';
  ctx.font = '700 36px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText(String(labelText || 'Table QR'), w / 2, 72);

  ctx.fillStyle = '#334155';
  ctx.font = '600 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText('Hey buddy 👋 Scan the QR to place your order 🍽️', w / 2, 122);

  const x = (w - qrSize) / 2;
  const y = 160;
  ctx.drawImage(img, x, y, qrSize, qrSize);

  ctx.fillStyle = '#64748b';
  ctx.font = '500 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText('VEG CRAFT', w / 2, y + qrSize + 56);

  return canvas.toDataURL('image/png');
}

function openPrintWindow(html) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return null;
  try {
    w.opener = null;
  } catch {
    /* ignore */
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  return w;
}

export default function TablesBoard() {
  const [tables, setTables] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qrById, setQrById] = useState({});
  const [parcelQr, setParcelQr] = useState('');
  const [qrGenMessage, setQrGenMessage] = useState(null);
  const [newNum, setNewNum] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addTableModalOpen, setAddTableModalOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const autoSeedStartedRef = useRef(false);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'tables'),
      (snap) => {
        setLoadError(null);
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        list.sort(
          (a, b) =>
            (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || (Number(a.number) || 0) - (Number(b.number) || 0),
        );
        if (list.length === 0 && !autoSeedStartedRef.current) {
          autoSeedStartedRef.current = true;
          queueMicrotask(async () => {
            try {
              const batch = writeBatch(db);
              for (let i = 1; i <= 6; i += 1) {
                batch.set(doc(db, 'tables', String(i)), {
                  number: i,
                  label: `Table ${i}`,
                  sortOrder: i,
                  createdAt: serverTimestamp(),
                });
              }
              await batch.commit();
            } catch {
              autoSeedStartedRef.current = false;
            }
          });
        }
        setTables(list);
      },
      (err) => {
        setLoadError(err.message || 'Could not load tables');
        setTables([]);
      },
    );
    return () => unsub();
  }, []);

  const { baseUrl, qrBaseSource } = useMemo(() => resolveCustomerQrBaseUrl(), []);
  const qrUsesLocalhost = useMemo(() => qrBaseHostIsLocalhost(baseUrl), [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!baseUrl) {
        setQrById({});
        setParcelQr('');
        setQrGenMessage(null);
        return;
      }
      setQrGenMessage(null);
      const next = {};
      let hadError = false;
      for (const t of tables) {
        const n = Number(t.number);
        if (!Number.isFinite(n)) continue;
        const url = `${baseUrl}/?table=${n}`;
        try {
          next[t.id] = await qrToDisplayableDataUrl(url);
        } catch (e) {
          hadError = true;
          next[t.id] = '';
        }
      }
      if (!cancelled) {
        setQrById(next);
        try {
          setParcelQr(await qrToDisplayableDataUrl(`${baseUrl}/?mode=parcel`));
        } catch {
          hadError = true;
          setParcelQr('');
        }
        if (hadError) {
          setQrGenMessage('Some QR codes could not be generated. Try setting VITE_CUSTOMER_APP_URL and refresh.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tables, baseUrl]);

  useEffect(() => {
    if (!addTableModalOpen && !pendingDelete) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (pendingDelete) {
          setPendingDelete(null);
          setActionError(null);
        } else {
          setAddTableModalOpen(false);
          setNewNum('');
          setNewLabel('');
          setActionError(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTableModalOpen, pendingDelete]);

  const openAddTableModal = useCallback(() => {
    setActionError(null);
    setNewNum('');
    setNewLabel('');
    setAddTableModalOpen(true);
  }, []);

  const closeAddTableModal = useCallback(() => {
    setAddTableModalOpen(false);
    setNewNum('');
    setNewLabel('');
    setActionError(null);
  }, []);

  const seedDefaultSix = useCallback(async () => {
    setActionError(null);
    setBusy(true);
    try {
      const batch = writeBatch(db);
      for (let i = 1; i <= 6; i += 1) {
        const ref = doc(db, 'tables', String(i));
        batch.set(ref, {
          number: i,
          label: `Table ${i}`,
          sortOrder: i,
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch (e) {
      setActionError(e?.message || 'Could not create tables');
    } finally {
      setBusy(false);
    }
  }, []);

  const addTable = async (e) => {
    e.preventDefault();
    const raw = String(newNum ?? '').trim();
    if (raw === '') {
      setActionError('Enter a table number (e.g. 7).');
      return;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 9999 || String(n) !== raw.replace(/^0+/, '')) {
      setActionError('Enter a whole table number between 1 and 9999.');
      return;
    }
    const dupOtherId = tables.find((t) => Number(t.number) === n && String(t.id) !== String(n));
    if (dupOtherId) {
      setActionError(
        `Table number ${n} is already used by another row (id “${dupOtherId.id}”). Remove that row first, or pick a different number.`,
      );
      return;
    }
    const label = String(newLabel || '').trim() || `Table ${n}`;
    setActionError(null);
    setBusy(true);
    try {
      let maxSort = tables.reduce((m, t) => Math.max(m, Number(t.sortOrder) || 0), 0);
      if (!Number.isFinite(maxSort) || maxSort < 0) maxSort = 0;
      if (maxSort > 1_000_000) maxSort = 1_000_000;

      const ref = doc(db, 'tables', String(n));
      const existingSnap = await getDoc(ref);
      const payload = {
        number: n,
        label,
        sortOrder: maxSort + 1,
      };
      if (!existingSnap.exists()) {
        payload.createdAt = serverTimestamp();
      }
      await setDoc(ref, payload, { merge: true });
      setNewNum('');
      setNewLabel('');
      setAddTableModalOpen(false);
    } catch (err) {
      const code = err?.code ? `${err.code}: ` : '';
      setActionError(`${code}${err?.message || 'Could not add table'}`);
    } finally {
      setBusy(false);
    }
  };

  const requestRemoveTable = useCallback((t) => {
    setActionError(null);
    setPendingDelete(t);
  }, []);

  const confirmRemoveTable = async () => {
    if (!pendingDelete) return;
    const t = pendingDelete;
    setActionError(null);
    setBusy(true);
    try {
      await deleteDoc(doc(db, 'tables', t.id));
      setPendingDelete(null);
    } catch (e) {
      setActionError(e?.message || 'Could not delete table');
    } finally {
      setBusy(false);
    }
  };

  const cancelRemoveTable = useCallback(() => {
    setPendingDelete(null);
    setActionError(null);
  }, []);

  const downloadQrForTable = useCallback(
    async (t) => {
      const src = qrById[t.id];
      if (!src) {
        setActionError('QR is still generating. Please try again in a moment.');
        return;
      }
      const n = Number(t.number);
      const tablePart = Number.isFinite(n) ? `table-${n}` : fileSafePart(t.id || 'table');
      const label = t.label || (Number.isFinite(n) ? `Table ${n}` : 'Table');
      const cardSrc = await buildQrCardDataUrl(src, label);
      downloadDataUrl(cardSrc, `veg-cafe-${tablePart}-qr.png`);
      setActionError(null);
    },
    [qrById],
  );

  const printQrForTable = useCallback(
    (t) => {
      const src = qrById[t.id];
      if (!src) {
        setActionError('QR is still generating. Please try again in a moment.');
        return;
      }
      const n = Number(t.number);
      const label = t.label || (Number.isFinite(n) ? `Table ${n}` : 'Table');
      const safeLabel = escapeHtml(label);
      const encoded = Number.isFinite(n) && baseUrl ? `${baseUrl}/?table=${n}` : '';
      const printWindow = openPrintWindow(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Print QR - ${label}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; color: #111827; }
      .card { max-width: 420px; margin: 0 auto; border: 1px solid #d1d5db; border-radius: 12px; padding: 18px; text-align: center; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { margin: 4px 0; }
      img { width: 280px; height: 280px; margin: 12px auto; display: block; }
      .muted { color: #6b7280; font-size: 12px; word-break: break-all; }
      @media print { body { padding: 0; } .card { border: none; } }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>${safeLabel}</h1>
      <p><strong>Hey buddy 👋 Scan the QR to place your order 🍽️</strong></p>
      <p>#${Number.isFinite(n) ? n : escapeHtml(displayTableNumberForCopy(t))}</p>
      <img src="${src}" alt="QR code for ${safeLabel}" />
      ${encoded ? `<p class="muted">${escapeHtml(encoded)}</p>` : ''}
    </section>
    <script>
      const imgs = Array.from(document.images);
      Promise.all(imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })).then(() => {
        window.print();
      });
    </script>
  </body>
</html>`);
      if (!printWindow) {
        setActionError('Popup blocked by browser. Allow popups to print QR.');
        return;
      }
      setActionError(null);
    },
    [qrById, baseUrl],
  );

  const downloadParcelQr = useCallback(async () => {
    if (!parcelQr) {
      setActionError('Parcel QR is still generating. Please try again in a moment.');
      return;
    }
    const cardSrc = await buildQrCardDataUrl(parcelQr, 'Parcel Pickup');
    downloadDataUrl(cardSrc, 'veg-cafe-parcel-qr.png');
    setActionError(null);
  }, [parcelQr]);

  const printParcelQr = useCallback(() => {
    if (!parcelQr) {
      setActionError('Parcel QR is still generating. Please try again in a moment.');
      return;
    }
    const encoded = baseUrl ? `${baseUrl}/?mode=parcel` : '';
    const printWindow = openPrintWindow(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Print QR - Parcel Pickup</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; color: #111827; }
      .card { max-width: 420px; margin: 0 auto; border: 1px solid #d1d5db; border-radius: 12px; padding: 18px; text-align: center; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { margin: 4px 0; }
      img { width: 280px; height: 280px; margin: 12px auto; display: block; }
      .muted { color: #6b7280; font-size: 12px; word-break: break-all; }
      @media print { body { padding: 0; } .card { border: none; } }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Parcel Pickup</h1>
      <p><strong>Hey buddy 👋 Scan the QR to place your order 🍽️</strong></p>
      <p>#PARCEL</p>
      <img src="${parcelQr}" alt="QR code for parcel pickup" />
      ${encoded ? `<p class="muted">${escapeHtml(encoded)}</p>` : ''}
    </section>
    <script>
      const imgs = Array.from(document.images);
      Promise.all(imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })).then(() => {
        window.print();
      });
    </script>
  </body>
</html>`);
    if (!printWindow) {
      setActionError('Popup blocked by browser. Allow popups to print QR.');
      return;
    }
    setActionError(null);
  }, [parcelQr, baseUrl]);

  const downloadAllQrs = useCallback(async () => {
    if (tables.length === 0 && !parcelQr) return;
    const downloads = tables
      .map((t) => {
        const src = qrById[t.id];
        if (!src) return null;
        const n = Number(t.number);
        const tablePart = Number.isFinite(n) ? `table-${n}` : fileSafePart(t.id || 'table');
        const label = t.label || (Number.isFinite(n) ? `Table ${n}` : 'Table');
        return { src, label, fileName: `veg-cafe-${tablePart}-qr.png` };
      })
      .filter(Boolean);
    if (parcelQr) {
      downloads.push({ src: parcelQr, label: 'Parcel Pickup', fileName: 'veg-cafe-parcel-qr.png' });
    }
    if (downloads.length === 0) {
      setActionError('QRs are still generating. Please try again in a moment.');
      return;
    }
    for (const item of downloads) {
      const cardSrc = await buildQrCardDataUrl(item.src, item.label);
      downloadDataUrl(cardSrc, item.fileName);
      await sleep(180);
    }
    setActionError(null);
  }, [tables, qrById, parcelQr]);

  const printAllQrs = useCallback(() => {
    if (tables.length === 0 && !parcelQr) return;
    const cards = tables
      .map((t) => {
        const src = qrById[t.id];
        if (!src) return '';
        const n = Number(t.number);
        const label = t.label || (Number.isFinite(n) ? `Table ${n}` : 'Table');
        const safeLabel = escapeHtml(label);
        const encoded = Number.isFinite(n) && baseUrl ? `${baseUrl}/?table=${n}` : '';
        return `
          <article class="card">
            <h2>${safeLabel}</h2>
            <p><strong>Hey buddy 👋 Scan the QR to place your order 🍽️</strong></p>
            <p>#${Number.isFinite(n) ? n : escapeHtml(displayTableNumberForCopy(t))}</p>
            <img src="${src}" alt="QR code for ${safeLabel}" />
            ${encoded ? `<p class="muted">${escapeHtml(encoded)}</p>` : ''}
          </article>
        `;
      })
      .filter(Boolean)
      .join('');
    const parcelCard = parcelQr
      ? `
          <article class="card">
            <h2>Parcel Pickup</h2>
            <p><strong>Hey buddy 👋 Scan the QR to place your order 🍽️</strong></p>
            <p>#PARCEL</p>
            <img src="${parcelQr}" alt="QR code for parcel pickup" />
            ${baseUrl ? `<p class="muted">${escapeHtml(`${baseUrl}/?mode=parcel`)}</p>` : ''}
          </article>
        `
      : '';
    const allCards = `${cards}${parcelCard}`;
    if (!allCards) {
      setActionError('QRs are still generating. Please try again in a moment.');
      return;
    }
    const printWindow = openPrintWindow(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Print all table QRs</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 18px; color: #111827; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap: 14px; }
      .card { border: 1px solid #d1d5db; border-radius: 10px; padding: 10px; text-align: center; break-inside: avoid; }
      h2 { margin: 0 0 4px; font-size: 18px; }
      p { margin: 2px 0; }
      img { width: 180px; height: 180px; margin: 8px auto; display: block; }
      .muted { color: #6b7280; font-size: 10px; word-break: break-all; }
      @media print {
        body { padding: 8px; }
        .grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      }
    </style>
  </head>
  <body>
    <section class="grid">${allCards}</section>
    <script>
      const imgs = Array.from(document.images);
      Promise.all(imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })).then(() => {
        window.print();
      });
    </script>
  </body>
</html>`);
    if (!printWindow) {
      setActionError('Popup blocked by browser. Allow popups to print QR.');
      return;
    }
    setActionError(null);
  }, [tables, qrById, baseUrl, parcelQr]);

  const rulesDeployHint = (
    <span className="tables-board__err-follow">
      Deploy rules from the repo root: <code>firebase deploy --only firestore:rules</code>, and ensure{' '}
      <code>admin/.env.local</code> uses the same <code>VITE_FIREBASE_PROJECT_ID</code> as that project.
    </span>
  );

  return (
    <div className="board tables-board">
      <h2 className="board-section__title board-section__title--lg">Tables &amp; QR codes</h2>
      <p className="board__hint board__hint--modern">
        <strong>Hey buddy 👋 Scan the QR to place your order 🍽️</strong>{' '}
        The café uses <strong>six fixed tables</strong>: if Firestore has no tables yet, this screen creates tables{' '}
        <strong>1–6</strong> automatically so you get six QR codes. Each QR opens your guest site with{' '}
        <code>?table=1</code> … <code>?table=6</code>. Guests <strong>must scan</strong> that QR (they cannot type a
        table unless you set <code>VITE_ALLOW_MANUAL_TABLE=true</code> on the customer app). By default, QRs use{' '}
        <code>https://YOUR_PROJECT_ID.web.app</code> from <code>VITE_FIREBASE_PROJECT_ID</code>. Set{' '}
        <code>VITE_CUSTOMER_APP_URL</code> only if your live menu URL differs (e.g. a custom domain).
      </p>

      {qrUsesLocalhost ? (
        <div className="alert alert--warning" role="status">
          <strong>Phone scans will not open your menu</strong> while QR links use <code>{baseUrl}</code>. Add{' '}
          <code>VITE_FIREBASE_PROJECT_ID</code> to <code>admin/.env.local</code> (same as your Firebase project) so QRs
          default to <code>https://…web.app</code>, or set <code>VITE_CUSTOMER_APP_URL</code> to your live guest URL.
          Then restart <code>npm run dev</code> and refresh.
        </div>
      ) : null}
      {!qrUsesLocalhost && qrBaseSource === 'firebase-default' && baseUrl ? (
        <div className="alert alert--info" role="status">
          QR codes point to <code>{baseUrl}/?table=…</code> (from <code>VITE_FIREBASE_PROJECT_ID</code>). Set{' '}
          <code>VITE_CUSTOMER_APP_URL</code> if your menu uses a custom domain instead of{' '}
          <code>.web.app</code>.
        </div>
      ) : null}
      {!qrUsesLocalhost && qrBaseSource === 'origin' && baseUrl ? (
        <div className="alert alert--info" role="status">
          QR codes use this page&apos;s origin: <code>{baseUrl}</code>. Add <code>VITE_FIREBASE_PROJECT_ID</code> in{' '}
          <code>admin/.env.local</code> so QRs use <code>https://YOUR-ID.web.app/?table=…</code>, or set{' '}
          <code>VITE_CUSTOMER_APP_URL</code>.
        </div>
      ) : null}

      {loadError && (
        <div className="alert alert--error" role="alert">
          {loadError}
          {/permission/i.test(loadError) ? rulesDeployHint : null}
        </div>
      )}
      {actionError && actionError !== loadError && !addTableModalOpen && !pendingDelete ? (
        <div className="alert alert--error" role="alert">
          {actionError}
          {/permission/i.test(actionError) ? rulesDeployHint : null}
        </div>
      ) : null}
      {qrGenMessage && (
        <div className="alert alert--error" role="status">
          {qrGenMessage}
        </div>
      )}

      <div className="tables-board__actions tables-board__actions--row">
        {tables.length === 0 ? (
          <button type="button" className="btn btn--primary" disabled={busy} onClick={seedDefaultSix}>
            {busy ? '…' : 'Create / restore 6 tables'}
          </button>
        ) : null}
        <button type="button" className="btn btn--primary" disabled={busy} onClick={openAddTableModal}>
          Add table
        </button>
        {tables.length > 0 ? (
          <>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={downloadAllQrs}>
              Download all QRs
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={printAllQrs}>
              Print all QRs
            </button>
          </>
        ) : null}
      </div>

      {addTableModalOpen ? (
        <div className="tables-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-table-modal-title">
          <button
            type="button"
            className="tables-modal-overlay__backdrop"
            aria-label="Close"
            onClick={closeAddTableModal}
          />
          <div className="tables-modal-panel">
            <header className="tables-modal-panel__head">
              <h2 id="add-table-modal-title">Add a table</h2>
              <button type="button" className="btn btn--danger btn--small" onClick={closeAddTableModal}>
                Close
              </button>
            </header>
            <form className="tables-modal-panel__body" onSubmit={addTable} noValidate>
              {actionError ? (
                <div className="alert alert--error" role="alert">
                  {actionError}
                  {/permission/i.test(actionError) ? rulesDeployHint : null}
                </div>
              ) : null}
              <div className="tables-board__add-row">
                <label className="tables-board__field">
                  <span>Number</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    pattern="[0-9]*"
                    value={newNum}
                    onChange={(e) => setNewNum(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="7"
                    disabled={busy}
                    autoFocus
                  />
                </label>
                <label className="tables-board__field tables-board__field--grow">
                  <span>Label (optional)</span>
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Garden 7"
                    disabled={busy}
                  />
                </label>
              </div>
              <div className="tables-modal-panel__footer">
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={closeAddTableModal}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save table'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="tables-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-table-modal-title">
          <button
            type="button"
            className="tables-modal-overlay__backdrop"
            aria-label="Close"
            onClick={cancelRemoveTable}
          />
          <div className="tables-modal-panel tables-modal-panel--confirm">
            <header className="tables-modal-panel__head">
              <h2 id="delete-table-modal-title">Remove table?</h2>
              <button type="button" className="btn btn--danger btn--small" onClick={cancelRemoveTable}>
                Close
              </button>
            </header>
            <div className="tables-modal-panel__body">
              {actionError ? (
                <div className="alert alert--error" role="alert">
                  {actionError}
                  {/permission/i.test(actionError) ? rulesDeployHint : null}
                </div>
              ) : null}
              <p className="tables-modal-panel__lead">
                Are you sure you want to remove{' '}
                <strong>{pendingDelete.label ?? `Table ${pendingDelete.number}`}</strong> (table #
                {displayTableNumberForCopy(pendingDelete)}) from this list?
              </p>
              <p className="muted tables-modal-panel__note">
                Printed QR links use <code>?table=</code> with that number — old printouts still work; this only removes
                the row from Admin.
              </p>
            </div>
            <div className="tables-modal-panel__footer">
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={cancelRemoveTable}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={confirmRemoveTable}>
                {busy ? 'Removing…' : 'Yes, remove'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!loadError ? (
        <>
          {tables.length === 0 ? <p className="muted board__empty">No tables yet — create the default six or add your own.</p> : null}
        <ul className="tables-grid">
          <li className="tables-card">
            <div className="tables-card__head">
              <strong className="tables-card__title">Parcel Pickup</strong>
              <span className="tables-card__num">#PARCEL</span>
            </div>
            <div className="tables-card__qr">
              {parcelQr ? (
                <img src={parcelQr} alt="QR for parcel pickup" width={200} height={200} />
              ) : (
                <div className="tables-card__qr-placeholder">{baseUrl ? 'Generating…' : 'Set base URL below — cannot build link.'}</div>
              )}
            </div>
            {baseUrl ? (
              <>
                <p className="tables-card__link">
                  <a href={`${baseUrl}/?mode=parcel`} target="_blank" rel="noreferrer">
                    Open parcel guest link
                  </a>
                </p>
                <p className="tables-card__encoded" title="Exact string inside the QR">
                  <span className="tables-card__encoded-label">In QR:</span>{' '}
                  <code className="tables-card__encoded-url">{`${baseUrl}/?mode=parcel`}</code>
                </p>
              </>
            ) : null}
            <div className="tables-card__row-actions">
              <button type="button" className="btn btn--ghost btn--small" disabled={busy || !parcelQr} onClick={downloadParcelQr}>
                Download QR
              </button>
              <button type="button" className="btn btn--ghost btn--small" disabled={busy || !parcelQr} onClick={printParcelQr}>
                Print QR
              </button>
            </div>
          </li>
          {tables.map((t) => {
            const n = Number(t.number);
            const link = Number.isFinite(n) && baseUrl ? `${baseUrl}/?table=${n}` : '';
            return (
              <li key={t.id} className="tables-card">
                <div className="tables-card__head">
                  <strong className="tables-card__title">{t.label || `Table ${n}`}</strong>
                  <span className="tables-card__num">#{n}</span>
                </div>
                <div className="tables-card__qr">
                  {qrById[t.id] ? (
                    <img src={qrById[t.id]} alt={`QR for table ${n}`} width={200} height={200} />
                  ) : (
                    <div className="tables-card__qr-placeholder">
                      {baseUrl ? 'Generating…' : 'Set base URL below — cannot build link.'}
                    </div>
                  )}
                </div>
                {link ? (
                  <>
                    <p className="tables-card__link">
                      <a href={link} target="_blank" rel="noreferrer">
                        Open guest link
                      </a>
                    </p>
                    <p className="tables-card__encoded" title="Exact string inside the QR">
                      <span className="tables-card__encoded-label">In QR:</span>{' '}
                      <code className="tables-card__encoded-url">{link}</code>
                    </p>
                  </>
                ) : null}
                <button type="button" className="btn btn--danger btn--small" disabled={busy} onClick={() => requestRemoveTable(t)}>
                  Remove table
                </button>
                <div className="tables-card__row-actions">
                  <button type="button" className="btn btn--ghost btn--small" disabled={busy || !qrById[t.id]} onClick={() => downloadQrForTable(t)}>
                    Download QR
                  </button>
                  <button type="button" className="btn btn--ghost btn--small" disabled={busy || !qrById[t.id]} onClick={() => printQrForTable(t)}>
                    Print QR
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        </>
      ) : null}
    </div>
  );
}
