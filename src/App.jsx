import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { collection, getDocs, addDoc, serverTimestamp, doc, onSnapshot, query, where, limit } from 'firebase/firestore';
import { db } from './firebase.js';
import { tableLockDocRef, tryClaimTableLock, tableLockSnapshotMode } from './tableLockFirestore.js';
import { DUMMY_MENU_ITEMS } from './dummyMenuData.js';
import { menuItemFromFirestore } from './menuNormalize.js';
import Menu from './Menu.jsx';
import Cart from './Cart.jsx';
import WelcomeModal from './WelcomeModal.jsx';
import TableEntryModal from './TableEntryModal.jsx';
import ScanQrScreen from './ScanQrScreen.jsx';
import KitchenStatusCard from './KitchenStatusCard.jsx';
import OrdersTab from './OrdersTab.jsx';
import { normalizeKitchenStatus } from './kitchenStatus.js';
import { openTabTotalForTable } from './customerOpenTab.js';

/** false → Firestore `menus` + real `orders` writes. true → dummyMenuData.js + DEMO order ids. */
const useDummyMenu = import.meta.env.VITE_USE_DUMMY_MENU === 'true';
/** If true, guest can type a table number when URL has no ?table=. Default: QR-only (table from scan). */
const allowManualTableEntry = import.meta.env.VITE_ALLOW_MANUAL_TABLE === 'true';
const GUEST_STORAGE_KEY = 'vegCafe_guestName';
const WATCHED_ORDER_KEY = 'vegCafe_watchedOrderId';
const AUTO_DISMISS_MS = 5000;
const LAST_BUZZ_KEY = 'vegCafe_lastBuzzerAt';

function readWatchedOrderId() {
  try {
    return sessionStorage.getItem(WATCHED_ORDER_KEY) || null;
  } catch {
    return null;
  }
}
const ORDER_HISTORY_KEY = 'vegCafe_orderHistory';
const MAX_STORED_ORDERS = 50;
const CUSTOMER_TABLE_KEY = 'vegCafe_customerTable';
const VACANT_POLL_LIMIT = 200;

function readStoredCustomerTable() {
  try {
    const v = sessionStorage.getItem(CUSTOMER_TABLE_KEY);
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 9999) return null;
    return n;
  } catch {
    return null;
  }
}

function persistCustomerTable(n) {
  try {
    sessionStorage.setItem(CUSTOMER_TABLE_KEY, String(n));
  } catch {
    /* ignore */
  }
}

function clearStoredCustomerTable() {
  try {
    sessionStorage.removeItem(CUSTOMER_TABLE_KEY);
  } catch {
    /* ignore */
  }
}

function tableSessionStorageKey(tableNumber) {
  return `vegCafe_tableSession_${tableNumber}`;
}

/** Stable id per browser tab so one party keeps the table until staff releases the lock. */
function getOrCreateTableSessionId(tableNumber) {
  const key = tableSessionStorageKey(tableNumber);
  try {
    const existing = sessionStorage.getItem(key);
    if (existing != null && existing !== '') return existing;
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `sess-${tableNumber}-${Date.now()}`;
  }
}

function loadOrderHistory() {
  try {
    const raw = sessionStorage.getItem(ORDER_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((o) => o && typeof o.orderId === 'string' && Array.isArray(o.items) && typeof o.total === 'number')
      .slice(0, MAX_STORED_ORDERS);
  } catch {
    return [];
  }
}

function persistOrderHistory(next) {
  const trimmed = next.slice(0, MAX_STORED_ORDERS);
  try {
    sessionStorage.setItem(ORDER_HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
  return trimmed;
}

/** URL (QR) wins, then optional dev default, then typed table only if `VITE_ALLOW_MANUAL_TABLE=true`. */
function resolveEffectiveTable(fromUrl, fromCustomer, allowManual) {
  if (fromUrl != null) return fromUrl;
  const raw = import.meta.env.VITE_DEFAULT_TABLE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  if (allowManual && fromCustomer != null) return fromCustomer;
  return null;
}

/** Read table number from ?table=N or /table/N */
function readTableFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('table');
  if (fromQuery != null && fromQuery !== '') {
    const n = Number(fromQuery);
    return Number.isFinite(n) ? n : null;
  }
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const match = path.match(/\/table\/(\d+)$/);
  if (match) return parseInt(match[1], 10);
  return null;
}

/** Strip `?table=` or `/table/N` so the next guest must scan again (same tab after bill paid). */
function replaceHistoryClearingTableFromUrl() {
  try {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    if (/\/table\/\d+$/i.test(path)) {
      window.history.replaceState({}, '', '/');
      return;
    }
    const u = new URL(window.location.href);
    u.searchParams.delete('table');
    const qs = u.searchParams.toString();
    window.history.replaceState({}, '', `${u.pathname}${qs ? `?${qs}` : ''}${u.hash}`);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [tableFromUrl, setTableFromUrl] = useState(null);
  const [tableFromCustomer, setTableFromCustomer] = useState(() =>
    allowManualTableEntry ? readStoredCustomerTable() : null,
  );
  const [menuItems, setMenuItems] = useState([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState(null);
  const [cart, setCart] = useState([]);
  const [orderSuccess, setOrderSuccess] = useState(false);
  const [orderError, setOrderError] = useState(null);
  const [placingOrder, setPlacingOrder] = useState(false);
  /** Orders placed in this tab (newest first), restored from sessionStorage */
  const [orderHistory, setOrderHistory] = useState(loadOrderHistory);
  /** Live Firestore snapshots for orders in local orderHistory (keyed by orderId). */
  const [liveOrderById, setLiveOrderById] = useState({});
  /** Latest order id we show kitchen progress for (admin updates `status` on this doc). */
  const [watchedOrderId, setWatchedOrderId] = useState(() => readWatchedOrderId());
  /** pending | preparing | ready | rejected | idle — drives chef card + rejection banner */
  const [kitchenBucket, setKitchenBucket] = useState(() => {
    const id = readWatchedOrderId();
    return id ? 'pending' : 'idle';
  });
  const kitchenPrevBucketRef = useRef(null);
  /** How we greet: real name or "Buddy" (restore from this tab’s session if they already said hi) */
  const [guestCallName, setGuestCallName] = useState(() => {
    try {
      const saved = sessionStorage.getItem(GUEST_STORAGE_KEY);
      if (saved != null && saved !== '') return saved;
    } catch {
      /* ignore */
    }
    return 'Buddy';
  });
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      const saved = sessionStorage.getItem(GUEST_STORAGE_KEY);
      return !(saved != null && saved !== '');
    } catch {
      return true;
    }
  });

  const [tableLockStatus, setTableLockStatus] = useState(() => (useDummyMenu ? 'ok' : 'loading'));
  const [tableLockError, setTableLockError] = useState(null);
  const tableLockClaimingRef = useRef(false);
  /** True once this tab holds the table lock (ok) — used to detect staff `releaseTableLock` after bill paid. */
  const heldTableLockOkRef = useRef(false);
  const lockSubscribedTableRef = useRef(null);
  /** After bill settle we stop processing lock snapshots until the table context changes (avoids re-claim race). */
  const ignoreLockClaimsRef = useRef(false);
  const [visitEndedMessage, setVisitEndedMessage] = useState(null);
  const [customerTab, setCustomerTab] = useState('menu'); // menu | orders

  // For "table in use" popup: show other vacant tables live.
  const [allTables, setAllTables] = useState([]);
  const [tableLocksByNumber, setTableLocksByNumber] = useState(() => new Map());
  const [newlyVacantTable, setNewlyVacantTable] = useState(null);

  useEffect(() => {
    setTableFromUrl(readTableFromUrl());
  }, []);

  const effectiveTable = resolveEffectiveTable(tableFromUrl, tableFromCustomer, allowManualTableEntry);

  /** Typed table fallback (staff/testing only when env is set). */
  const needsTablePrompt = !useDummyMenu && allowManualTableEntry && effectiveTable == null;

  /** Production: no table in URL and no dev default — must scan the table QR from admin printout. */
  const needsScanQrScreen = !useDummyMenu && !allowManualTableEntry && effectiveTable == null;

  const noTableForOrdering = needsTablePrompt || needsScanQrScreen;

  const showBlockedPopup = !useDummyMenu && effectiveTable != null && tableLockStatus === 'blocked';

  const vacantTables = useMemo(() => {
    if (useDummyMenu) return [];
    const nums = allTables
      .map((t) => Number(t.number))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const isFree = (lockDoc) => {
      if (!lockDoc) return true;
      const released = lockDoc.released === true;
      const occ = lockDoc.occupantSessionId;
      return released || occ == null || occ === '';
    };
    return nums.filter((n) => isFree(tableLocksByNumber.get(n)));
  }, [allTables, tableLocksByNumber]);

  // Subscribe to tables + tableLocks only when we need to suggest vacant tables.
  useEffect(() => {
    if (!showBlockedPopup) return undefined;
    let cancelled = false;
    const unsubTables = onSnapshot(
      query(collection(db, 'tables'), limit(VACANT_POLL_LIMIT)),
      (snap) => {
        if (cancelled) return;
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || (Number(a.number) || 0) - (Number(b.number) || 0));
        setAllTables(list);
      },
      () => {
        if (!cancelled) setAllTables([]);
      },
    );

    const unsubLocks = onSnapshot(
      query(collection(db, 'tableLocks'), limit(VACANT_POLL_LIMIT)),
      (snap) => {
        if (cancelled) return;
        const next = new Map();
        snap.forEach((d) => {
          const n = Number(d.id);
          if (!Number.isFinite(n)) return;
          next.set(n, d.data() || {});
        });
        setTableLocksByNumber(next);
      },
      () => {
        if (!cancelled) setTableLocksByNumber(new Map());
      },
    );

    return () => {
      cancelled = true;
      unsubTables();
      unsubLocks();
    };
  }, [showBlockedPopup]);

  // When any table becomes vacant, surface it to the user (inside popup).
  const prevVacantRef = useRef([]);
  useEffect(() => {
    if (!showBlockedPopup) {
      prevVacantRef.current = [];
      setNewlyVacantTable(null);
      return;
    }
    const prev = prevVacantRef.current || [];
    prevVacantRef.current = vacantTables;
    if (vacantTables.length === 0) return;
    const newly = vacantTables.find((n) => !prev.includes(n));
    if (newly != null) {
      setNewlyVacantTable(newly);
      const t = window.setTimeout(() => setNewlyVacantTable(null), 7000);
      return () => window.clearTimeout(t);
    }
  }, [vacantTables, showBlockedPopup]);

  const tableLockIssue = useMemo(
    () =>
      effectiveTable != null &&
      !useDummyMenu &&
      (tableLockStatus === 'loading' || tableLockStatus === 'blocked' || tableLockStatus === 'error'),
    [effectiveTable, tableLockStatus],
  );

  const canShowTableBill = useMemo(
    () =>
      !noTableForOrdering &&
      effectiveTable != null &&
      !tableLockIssue &&
      (useDummyMenu || tableLockStatus === 'ok'),
    [noTableForOrdering, effectiveTable, tableLockIssue, useDummyMenu, tableLockStatus],
  );

  const [firestoreOpenTabTotal, setFirestoreOpenTabTotal] = useState(null);

  const dummyOpenTabTotal = useMemo(
    () => orderHistory.reduce((s, o) => s + Number(o.total || 0), 0),
    [orderHistory],
  );

  useEffect(() => {
    if (useDummyMenu || !canShowTableBill) {
      setFirestoreOpenTabTotal(null);
      return undefined;
    }
    const t = effectiveTable;
    const q = query(collection(db, 'orders'), where('table', '==', t), limit(250));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        setFirestoreOpenTabTotal(openTabTotalForTable(rows, t));
      },
      () => {
        setFirestoreOpenTabTotal(0);
      },
    );
    return () => unsub();
  }, [useDummyMenu, canShowTableBill, effectiveTable]);

  const liveOpenTabTotal = useDummyMenu ? dummyOpenTabTotal : firestoreOpenTabTotal;

  const showBillButton = useMemo(() => {
    if (!canShowTableBill) return false;
    // While loading (null), keep it visible; once resolved, hide if total is zero.
    if (!useDummyMenu && liveOpenTabTotal === null) return true;
    return Number(liveOpenTabTotal ?? 0) > 0;
  }, [canShowTableBill, useDummyMenu, liveOpenTabTotal]);

  const handleSubmitCustomerTable = useCallback((n) => {
    persistCustomerTable(n);
    setTableFromCustomer(n);
  }, []);

  const clearCustomerTableChoice = useCallback(() => {
    clearStoredCustomerTable();
    setTableFromCustomer(null);
  }, []);

  const dismissVisitEndedMessage = useCallback(() => setVisitEndedMessage(null), []);
  const dismissSuccess = useCallback(() => setOrderSuccess(false), []);

  /** Staff marked bill paid → table lock released. Clear this tab’s guest session so the next party can scan the QR. */
  const endGuestSessionAfterBillSettled = useCallback(
    (endedTable) => {
      try {
        if (endedTable != null) sessionStorage.removeItem(tableSessionStorageKey(endedTable));
      } catch {
        /* ignore */
      }
      replaceHistoryClearingTableFromUrl();
      setTableFromUrl(readTableFromUrl());
      clearCustomerTableChoice();
      try {
        sessionStorage.removeItem(GUEST_STORAGE_KEY);
        sessionStorage.removeItem(WATCHED_ORDER_KEY);
        sessionStorage.removeItem(ORDER_HISTORY_KEY);
      } catch {
        /* ignore */
      }
      setGuestCallName('Buddy');
      setShowWelcome(true);
      setCart([]);
      setOrderHistory([]);
      setWatchedOrderId(null);
      setKitchenBucket('idle');
      setOrderSuccess(false);
      setOrderError(null);
      setVisitEndedMessage('Thank you for visiting Veg Craft. Please visit again!');
    },
    [clearCustomerTableChoice],
  );

  /** One active guest session per table (Firestore `tableLocks`) until staff settles the bill. */
  useEffect(() => {
    if (useDummyMenu) {
      setTableLockStatus('ok');
      setTableLockError(null);
      return undefined;
    }
    if (effectiveTable == null) {
      setTableLockStatus('skipped');
      setTableLockError(null);
      tableLockClaimingRef.current = false;
      lockSubscribedTableRef.current = null;
      ignoreLockClaimsRef.current = false;
      heldTableLockOkRef.current = false;
      return undefined;
    }

    if (lockSubscribedTableRef.current !== effectiveTable) {
      lockSubscribedTableRef.current = effectiveTable;
      heldTableLockOkRef.current = false;
      ignoreLockClaimsRef.current = false;
    }

    const sessionId = getOrCreateTableSessionId(effectiveTable);
    const lockRef = tableLockDocRef(db, effectiveTable);
    let cancelled = false;

    const attemptClaim = async () => {
      if (tableLockClaimingRef.current) return;
      tableLockClaimingRef.current = true;
      setTableLockStatus('loading');
      setTableLockError(null);
      try {
        const { claimed } = await tryClaimTableLock(db, effectiveTable, sessionId);
        if (cancelled) return;
        if (!claimed) {
          heldTableLockOkRef.current = false;
          setTableLockStatus('blocked');
          return;
        }
        heldTableLockOkRef.current = true;
        setTableLockStatus('ok');
      } catch (e) {
        if (!cancelled) {
          setTableLockError(e?.message || 'Could not claim table');
          setTableLockStatus('error');
        }
      } finally {
        tableLockClaimingRef.current = false;
      }
    };

    const unsub = onSnapshot(
      lockRef,
      (snap) => {
        if (cancelled) return;
        const mode = tableLockSnapshotMode(snap, sessionId);
        if (mode.mode === 'blocked') {
          heldTableLockOkRef.current = false;
          setTableLockStatus('blocked');
          setTableLockError(null);
          return;
        }
        if (mode.mode === 'ours') {
          heldTableLockOkRef.current = true;
          setTableLockStatus('ok');
          setTableLockError(null);
          return;
        }
        if (mode.mode === 'free') {
          if (ignoreLockClaimsRef.current) return;
          if (heldTableLockOkRef.current) {
            ignoreLockClaimsRef.current = true;
            heldTableLockOkRef.current = false;
            endGuestSessionAfterBillSettled(effectiveTable);
            return;
          }
          attemptClaim();
          return;
        }
      },
      (err) => {
        if (!cancelled) {
          setTableLockError(err?.message || 'Table lock failed');
          setTableLockStatus('error');
        }
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [effectiveTable, endGuestSessionAfterBillSettled]);

  /** Live `orders/{id}.status` from Firestore, or demo timer for DEMO-* ids. */
  useEffect(() => {
    if (!watchedOrderId) {
      setKitchenBucket('idle');
      return undefined;
    }

    setKitchenBucket('pending');

    if (watchedOrderId.startsWith('DEMO-')) {
      const raw = import.meta.env.VITE_DEMO_PREPARING_MS;
      const ms = raw !== undefined && raw !== '' ? Number(raw) : 3500;
      const delay = Number.isFinite(ms) && ms > 0 ? ms : 3500;
      const t = setTimeout(() => setKitchenBucket('preparing'), delay);
      return () => clearTimeout(t);
    }

    const orderRef = doc(db, 'orders', watchedOrderId);
    const unsub = onSnapshot(
      orderRef,
      (snap) => {
        if (!snap.exists()) {
          setKitchenBucket('pending');
          return;
        }
        setKitchenBucket(normalizeKitchenStatus(snap.data()?.status));
      },
      () => {
        setKitchenBucket('pending');
      },
    );
    return () => unsub();
  }, [watchedOrderId]);

  /** Mark the matching receipt when staff rejects this order (for order history sheet). */
  useEffect(() => {
    if (kitchenBucket !== 'rejected' || !watchedOrderId) return;
    setOrderHistory((prev) => {
      const i = prev.findIndex((o) => o.orderId === watchedOrderId);
      if (i === -1) return prev;
      if (prev[i].kitchenRejected) return prev;
      const next = [...prev];
      next[i] = { ...next[i], kitchenRejected: true };
      return persistOrderHistory(next);
    });
  }, [kitchenBucket, watchedOrderId]);

  // Keep local order history in sync with live Firestore edits by admin.
  useEffect(() => {
    if (useDummyMenu) {
      setLiveOrderById({});
      return undefined;
    }
    const ids = [...new Set(orderHistory.map((o) => o.orderId).filter((id) => !String(id).startsWith('DEMO-')))];
    if (ids.length === 0) {
      setLiveOrderById({});
      return undefined;
    }

    const unsubscribers = ids.map((id) =>
      onSnapshot(
        doc(db, 'orders', id),
        (snap) => {
          setLiveOrderById((prev) => {
            const next = { ...prev };
            if (snap.exists()) next[id] = { id, ...snap.data() };
            else delete next[id];
            return next;
          });
        },
        () => {
          /* ignore per-order errors; keep last known values */
        },
      ),
    );

    return () => {
      unsubscribers.forEach((u) => u());
    };
  }, [orderHistory, useDummyMenu]);

  const customerOrdersView = useMemo(() => {
    if (Object.keys(liveOrderById).length === 0) return orderHistory;
    return orderHistory.map((o) => {
      const live = liveOrderById[o.orderId];
      if (!live) return o;
      const st = String(live.status || '').toLowerCase();
      return {
        ...o,
        customerName: live.customerName ?? o.customerName,
        items: Array.isArray(live.items) ? live.items : o.items,
        total: Number.isFinite(Number(live.total)) ? Number(live.total) : o.total,
        kitchenRejected: st === 'rejected' ? true : o.kitchenRejected,
        status: st || o.status,
      };
    });
  }, [orderHistory, liveOrderById]);

  /** Desktop / PWA: one system notification when status flips to rejected (only if permission already granted). */
  useEffect(() => {
    const prev = kitchenPrevBucketRef.current;
    kitchenPrevBucketRef.current = kitchenBucket;
    if (kitchenBucket !== 'rejected' || prev === 'rejected' || prev === null) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification('VEG CRAFT', {
        body: 'Your order was not accepted. Please check with staff or place a new order.',
        tag: `order-rejected-${watchedOrderId || 'unknown'}`,
      });
    } catch {
      /* ignore */
    }
  }, [kitchenBucket, watchedOrderId]);

  const dismissRejectedNotice = useCallback(() => {
    try {
      sessionStorage.removeItem(WATCHED_ORDER_KEY);
    } catch {
      /* ignore */
    }
    setWatchedOrderId(null);
    setKitchenBucket('idle');
  }, []);

  useEffect(() => {
    if (!visitEndedMessage) return undefined;
    const t = window.setTimeout(() => dismissVisitEndedMessage(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [visitEndedMessage, dismissVisitEndedMessage]);

  useEffect(() => {
    if (!orderSuccess) return undefined;
    const t = window.setTimeout(() => dismissSuccess(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [orderSuccess, dismissSuccess]);

  useEffect(() => {
    if (!orderError) return undefined;
    const t = window.setTimeout(() => setOrderError(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [orderError]);

  useEffect(() => {
    if (noTableForOrdering || kitchenBucket !== 'rejected') return undefined;
    const t = window.setTimeout(() => dismissRejectedNotice(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [kitchenBucket, noTableForOrdering, dismissRejectedNotice]);

  const handleWelcomeContinue = useCallback((displayName) => {
    setGuestCallName(displayName);
    setShowWelcome(false);
    try {
      sessionStorage.setItem(GUEST_STORAGE_KEY, displayName);
    } catch {
      /* ignore */
    }
  }, []);

  const sendServiceRequest = useCallback(async () => {
    if (useDummyMenu) return;
    if (effectiveTable == null || noTableForOrdering || tableLockIssue) return;
    try {
      const last = Number(sessionStorage.getItem(LAST_BUZZ_KEY) || 0);
      if (Number.isFinite(last) && Date.now() - last < 15_000) {
        setOrderError('Please wait a few seconds before calling again.');
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      await addDoc(collection(db, 'serviceRequests'), {
        table: effectiveTable,
        guestName: guestCallName,
        status: 'open',
        createdAt: serverTimestamp(),
      });
      try {
        sessionStorage.setItem(LAST_BUZZ_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
      setOrderSuccess(true);
    } catch (e) {
      setOrderError(e?.message || 'Could not call staff');
    }
  }, [effectiveTable, guestCallName, noTableForOrdering, tableLockIssue]);

  const clearTableSessionForCurrentTable = useCallback(() => {
    if (effectiveTable == null) return;
    try {
      sessionStorage.removeItem(tableSessionStorageKey(effectiveTable));
    } catch {
      /* ignore */
    }
  }, [effectiveTable]);

  useEffect(() => {
    let cancelled = false;

    async function loadMenu() {
      setMenuLoading(true);
      setMenuError(null);
      if (useDummyMenu) {
        if (cancelled) return;
        setMenuItems(DUMMY_MENU_ITEMS.filter((item) => item.available));
        setMenuLoading(false);
        return;
      }
      try {
        const snap = await getDocs(collection(db, 'menus'));
        if (cancelled) return;
        const list = [];
        snap.forEach((docSnap) => {
          list.push(menuItemFromFirestore(docSnap));
        });
        setMenuItems(list.filter((item) => item.available));
      } catch (e) {
        if (!cancelled) setMenuError(e.message || 'Failed to load menu');
      } finally {
        if (!cancelled) setMenuLoading(false);
      }
    }

    loadMenu();
    return () => {
      cancelled = true;
    };
  }, []);

  const addToCart = useCallback((item, portion = 'regular') => {
    const hasLarge = item.priceLarge != null && Number(item.priceLarge) > 0;
    const chosenPortion = hasLarge && portion === 'large' ? 'large' : 'regular';
    const chosenPrice = chosenPortion === 'large' ? Number(item.priceLarge || 0) : Number(item.price || 0);
    const lineName = hasLarge ? `${item.name} (${chosenPortion === 'large' ? 'Large' : 'Small'})` : item.name;
    const lineId = hasLarge ? `${item.id}::${chosenPortion}` : item.id;
    setCart((prev) => {
      const i = prev.findIndex((line) => line.id === lineId);
      if (i === -1) {
        return [
          ...prev,
          { id: lineId, menuId: item.id, name: lineName, price: chosenPrice, qty: 1, portion: chosenPortion },
        ];
      }
      const next = [...prev];
      next[i] = { ...next[i], name: lineName, price: chosenPrice, portion: chosenPortion, qty: next[i].qty + 1 };
      return next;
    });
  }, []);

  const changeQty = useCallback((id, delta) => {
    setCart((prev) => {
      const i = prev.findIndex((line) => line.id === id);
      if (i === -1) return prev;
      const nextQty = prev[i].qty + delta;
      if (nextQty <= 0) {
        return prev.filter((line) => line.id !== id);
      }
      const next = [...prev];
      next[i] = { ...next[i], qty: nextQty };
      return next;
    });
  }, []);

  const cartTotal = cart.reduce((sum, line) => sum + line.price * line.qty, 0);

  const placeOrder = async () => {
    if (tableLockIssue || effectiveTable == null || cart.length === 0) return;
    setOrderError(null);
    setPlacingOrder(true);

    const itemsPayload = cart.map((line) => ({
      name: line.name,
      qty: line.qty,
      price: line.price,
    }));
    const totalSnapshot = cartTotal;

    try {
      let orderId;

      // Dummy mode: fake order id only (no Firestore write). Off when VITE_USE_DUMMY_MENU=false.
      if (useDummyMenu) {
        orderId = `DEMO-${Date.now().toString(36).toUpperCase()}`;
      } else {
        const docRef = await addDoc(collection(db, 'orders'), {
          table: effectiveTable,
          customerName: guestCallName,
          items: itemsPayload,
          total: totalSnapshot,
          status: 'pending',
          billingStatus: 'unbilled',
          source: 'customer',
          createdAt: serverTimestamp(),
        });
        orderId = docRef.id;
      }

      const receipt = {
        orderId,
        table: effectiveTable,
        customerName: guestCallName,
        items: itemsPayload.map((i) => ({ ...i })),
        total: totalSnapshot,
        placedAt: Date.now(),
      };
      setOrderHistory((prev) => persistOrderHistory([receipt, ...prev]));
      try {
        sessionStorage.setItem(WATCHED_ORDER_KEY, orderId);
      } catch {
        /* ignore */
      }
      setWatchedOrderId(orderId);
      setOrderSuccess(true);
      setCart([]);
    } catch (e) {
      const code = e?.code ? `${e.code}: ` : '';
      setOrderError(`${code}${e.message || 'Could not place order'}`);
    } finally {
      setPlacingOrder(false);
    }
  };

  return (
    <div className="app">
      {needsScanQrScreen ? <ScanQrScreen /> : null}
      {visitEndedMessage ? (
        <div className="visit-ended-modal" role="dialog" aria-modal="true" aria-labelledby="visit-ended-title">
          <button type="button" className="visit-ended-modal__backdrop" aria-label="Close" onClick={dismissVisitEndedMessage} />
          <div className="visit-ended-modal__panel">
            <h2 id="visit-ended-title">Thank you</h2>
            <p>{visitEndedMessage}</p>
            <button type="button" className="btn btn--primary visit-ended-modal__btn" onClick={dismissVisitEndedMessage}>
              OK
            </button>
          </div>
        </div>
      ) : null}
      {needsTablePrompt ? <TableEntryModal onSubmitTable={handleSubmitCustomerTable} /> : null}
      {showWelcome && !noTableForOrdering && !tableLockIssue && <WelcomeModal onContinue={handleWelcomeContinue} />}

      <header className="header">
        <p className="header-greet">
          Hi, <strong>{guestCallName}</strong>!
        </p>
        <h1>Welcome to VEG CRAFT</h1>
        <p className="header-sub">Order fresh veg favourites — we’re glad you’re here.</p>
        <p className="table-badge">
          {effectiveTable != null ? (
            <>
              Table <strong>{effectiveTable}</strong>
              {tableFromUrl == null && tableFromCustomer != null ? (
                <span className="table-badge__hint"> (you entered)</span>
              ) : null}
              {tableFromUrl == null && tableFromCustomer == null && import.meta.env.VITE_DEFAULT_TABLE ? (
                <span className="table-badge__hint"> (default for this link)</span>
              ) : null}
              {allowManualTableEntry && tableFromUrl == null && tableFromCustomer != null ? (
                <button
                  type="button"
                  className="table-badge__change"
                  onClick={() => {
                    clearTableSessionForCurrentTable();
                    clearCustomerTableChoice();
                  }}
                >
                  Change table
                </button>
              ) : null}
            </>
          ) : useDummyMenu ? (
            <>
              No table — add <code>?table=1</code> or set <code>VITE_DEFAULT_TABLE</code> for local testing
            </>
          ) : needsScanQrScreen ? (
            <>Scan the <strong>QR on your table</strong> to open ordering (table number comes from that code).</>
          ) : (
            <>Choose your table to start ordering.</>
          )}
        </p>
        {/* Call staff button moved to floating action for mobile */}
        {effectiveTable != null && !useDummyMenu && tableLockStatus === 'loading' ? (
          <p className="table-lock-hint" role="status">
            Checking table availability…
          </p>
        ) : null}
      </header>

      {!noTableForOrdering && !tableLockIssue ? (
        <nav className="customer-tabs" aria-label="Customer sections">
          <button
            type="button"
            className={`customer-tab ${customerTab === 'menu' ? 'customer-tab--active' : ''}`}
            onClick={() => setCustomerTab('menu')}
          >
            Menu
          </button>
          <button
            type="button"
            className={`customer-tab ${customerTab === 'orders' ? 'customer-tab--active' : ''}`}
            onClick={() => setCustomerTab('orders')}
          >
            Orders
            {orderHistory.length > 0 ? <span className="customer-tab__badge">{orderHistory.length}</span> : null}
          </button>
        </nav>
      ) : null}

      {showBillButton && customerTab === 'menu' ? (
        <button
          type="button"
          className="open-tab-btn"
          aria-label="Open table bill details"
          onClick={() => {
            setCustomerTab('orders');
          }}
        >
          <span className="open-tab-btn__label">Your table bill (unpaid)</span>
          {!useDummyMenu && liveOpenTabTotal === null ? (
            <span className="open-tab-btn__amount open-tab-btn__amount--pending">Updating…</span>
          ) : (
            <strong className="open-tab-btn__amount">₹{Number(liveOpenTabTotal ?? 0).toFixed(2)}</strong>
          )}
          <span className="open-tab-btn__hint">Tap to view order history and full bill details</span>
        </button>
      ) : null}

      {tableLockStatus === 'blocked' && effectiveTable != null && !useDummyMenu ? (
        <div className="table-lock-modal" role="dialog" aria-modal="true" aria-labelledby="table-lock-title">
          <button type="button" className="table-lock-modal__backdrop" aria-label="Close" />
          <div className="table-lock-modal__panel" role="document">
            <h2 id="table-lock-title">This table is already in use</h2>
            <p>
              Another guest has already opened ordering for table <strong>{effectiveTable}</strong>.
            </p>

            {newlyVacantTable != null ? (
              <div className="table-lock-modal__toast" role="status">
                Table <strong>{newlyVacantTable}</strong> is now vacant.
              </div>
            ) : null}

            {vacantTables.length > 0 ? (
              <>
                <p className="table-lock-modal__sub">
                  Vacant tables right now (ask staff for that table QR):
                </p>
                <div className="table-lock-modal__vacant-grid" role="list">
                  {vacantTables.map((n) => (
                    <span key={n} className="table-lock-modal__vacant-pill" role="listitem">
                      Table {n}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="table-lock-modal__sub">
                All tables are currently full. Please wait — we’ll show the table number as soon as one becomes vacant.
              </p>
            )}

            <p className="table-lock-modal__hint">
              This table unlocks only after staff tap <strong>Bill paid</strong> at the counter.
            </p>

            {allowManualTableEntry && tableFromCustomer != null && tableFromUrl == null ? (
              <button
                type="button"
                className="btn btn--small table-lock-modal__btn"
                onClick={() => {
                  clearTableSessionForCurrentTable();
                  clearCustomerTableChoice();
                }}
              >
                Wrong table number — try again
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {tableLockStatus === 'error' && effectiveTable != null && !useDummyMenu ? (
        <div className="table-lock-screen table-lock-screen--error" role="alert">
          <h2>Could not verify table</h2>
          <p>{tableLockError || 'Something went wrong.'}</p>
          <p className="table-lock-hint">Refresh the page to try again.</p>
        </div>
      ) : null}

      {orderSuccess && (
        <div className="banner banner--success" role="status">
          <div className="banner__text">
            <strong>Your order was placed successfully — please wait!</strong>
            <span className="banner__sub">
              Thanks, {guestCallName}. Tap <strong>Order history</strong> in the corner to see this and past orders for this visit.
            </span>
          </div>
        </div>
      )}

      {orderError && (
        <div className="banner banner--error" role="alert">
          {orderError}
        </div>
      )}

      {!noTableForOrdering && kitchenBucket === 'rejected' ? (
        <div className="banner banner--error banner--reject-notice" role="alert" aria-live="assertive">
          <div className="banner__text">
            <strong>Your order was not accepted</strong>
            <span className="banner__sub">
              The kitchen cannot take this order right now. Please speak to staff at the counter, or dismiss here and
              try ordering again.
              {watchedOrderId ? (
                <>
                  {' '}
                  (Order <code>{watchedOrderId}</code>)
                </>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}

      {!noTableForOrdering && (kitchenBucket === 'preparing' || kitchenBucket === 'ready') ? (
        <div className="kitchen-card-wrap">
          <KitchenStatusCard status={kitchenBucket} orderId={watchedOrderId} />
        </div>
      ) : null}

      <main className="main">
        {!noTableForOrdering && !tableLockIssue ? (
          customerTab === 'menu' ? (
            <Menu
              items={menuItems}
              loading={menuLoading}
              error={menuError}
              cart={cart}
              onAdd={addToCart}
              onChangeQty={changeQty}
            />
          ) : (
            <OrdersTab
              orders={customerOrdersView}
              liveOpenTabTotal={canShowTableBill ? (useDummyMenu ? dummyOpenTabTotal : firestoreOpenTabTotal) : undefined}
            />
          )
        ) : null}
      </main>

      {!noTableForOrdering && customerTab === 'menu' && cart.length > 0 ? (
        <Cart
          cart={cart}
          total={cartTotal}
          onPlaceOrder={placeOrder}
          placeOrderDisabled={
            tableLockIssue || effectiveTable == null || cart.length === 0 || placingOrder
          }
          placingOrder={placingOrder}
        />
      ) : null}

      {!noTableForOrdering && !tableLockIssue ? (
        <button type="button" className="call-staff-fab" onClick={sendServiceRequest} aria-label="Call staff">
          <span className="call-staff-fab__icon" aria-hidden="true">
            🔔
          </span>
          <span className="call-staff-fab__text">Call staff</span>
        </button>
      ) : null}
    </div>
  );
}
