import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, query, limit, updateDoc, doc, serverTimestamp, where } from 'firebase/firestore';
import { db } from './firebase.js';

function formatTime(ts) {
  if (!ts) return '';
  try {
    if (typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
    if (ts.seconds != null) return new Date(ts.seconds * 1000).toLocaleString();
  } catch {
    /* ignore */
  }
  return '';
}

function timeMs(ts) {
  if (!ts) return 0;
  try {
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts.seconds != null) return ts.seconds * 1000;
  } catch {
    /* ignore */
  }
  return 0;
}

function safeName(v) {
  const s = String(v ?? '').trim();
  return s ? s : 'Guest';
}

function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();

    const beepOnce = (freq, ms, gain = 0.09) =>
      new Promise((resolve) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.value = gain;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        window.setTimeout(() => {
          try {
            o.stop();
          } catch {
            /* ignore */
          }
          resolve();
        }, ms);
      });

    const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));

    // One pattern: double-beep (~1.1s). Caller can repeat as needed.
    (async () => {
      await beepOnce(880, 320);
      await sleep(140);
      await beepOnce(988, 320);
    })()
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        try {
          ctx.close?.();
        } catch {
          /* ignore */
        }
      });
    return true;
  } catch {
    return false;
  }
}

export default function ServiceRequestsBar() {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState(null);
  const lastSeenIdRef = useRef(null);
  const buzzerIntervalRef = useRef(null);

  const stopBuzzer = () => {
    if (buzzerIntervalRef.current != null) {
      window.clearInterval(buzzerIntervalRef.current);
      buzzerIntervalRef.current = null;
    }
  };

  const startBuzzer = () => {
    if (buzzerIntervalRef.current != null) return;
    // Repeat beep pattern until handled.
    playBeep();
    buzzerIntervalRef.current = window.setInterval(() => {
      playBeep();
    }, 1300);
  };

  useEffect(() => {
    const q = query(
      collection(db, 'serviceRequests'),
      where('status', '==', 'open'),
      // No orderBy here to avoid needing a composite index.
      limit(25),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setError(null);
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt));
        setRequests(list.slice(0, 15));
      },
      (e) => {
        setError(e?.message || 'Could not load service requests');
        setRequests([]);
      },
    );
    return () => unsub();
  }, []);

  const newest = requests[0] || null;

  useEffect(() => {
    if (!newest) {
      stopBuzzer();
      lastSeenIdRef.current = null;
      return;
    }
    if (lastSeenIdRef.current == null) {
      lastSeenIdRef.current = newest.id;
      startBuzzer();
      return;
    }
    if (newest.id !== lastSeenIdRef.current) {
      lastSeenIdRef.current = newest.id;
      // New request arrived: ensure buzzer is running.
      startBuzzer();
    }
  }, [newest?.id]);

  useEffect(() => {
    // If there are any open requests, keep buzzing until handled.
    if (requests.length > 0) startBuzzer();
    else stopBuzzer();
  }, [requests.length]);

  useEffect(() => {
    return () => stopBuzzer();
  }, []);

  const title = useMemo(() => {
    if (!newest) return '';
    return `${safeName(newest.guestName || newest.customerName)} needs help at Table ${newest.table}`;
  }, [newest]);

  const markHandled = async (id) => {
    try {
      await updateDoc(doc(db, 'serviceRequests', id), { status: 'handled', handledAt: serverTimestamp() });
    } catch {
      /* ignore */
    }
  };

  if (error) {
    return (
      <div className="alert alert--error" role="alert">
        {error}
      </div>
    );
  }

  if (!newest) return null;

  return (
    <section className="svc-strip" aria-label="Service requests">
      <div className="svc-strip__head">
        <span className="svc-strip__icon" aria-hidden="true">
          🔔
        </span>
        <div className="svc-strip__text">
          <strong className="svc-strip__title">{title}</strong>
          <span className="svc-strip__sub muted">
            {formatTime(newest.createdAt)} {requests.length > 1 ? `· +${requests.length - 1} more` : ''}
          </span>
        </div>
        <button type="button" className="btn btn--done btn--small" onClick={() => markHandled(newest.id)}>
          Mark handled
        </button>
      </div>

      {requests.length > 1 ? (
        <details className="svc-strip__more">
          <summary className="svc-strip__summary">Show all requests</summary>
          <ul className="svc-strip__list">
            {requests.map((r) => (
              <li key={r.id} className="svc-strip__row">
                <span>
                  <strong>{safeName(r.guestName || r.customerName)}</strong> · Table <strong>{r.table}</strong>
                  <span className="muted"> · {formatTime(r.createdAt)}</span>
                </span>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => markHandled(r.id)}>
                  Done
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

