import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { collection, query, orderBy, limit, onSnapshot, updateDoc, doc, serverTimestamp, getDocs, writeBatch, addDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { releaseTableLock } from '../../src/tableLockFirestore.js';
import {
  isKitchenTerminalStatus,
  partitionOrdersForAdmin,
  openTabTotalForTable,
  isUnbilledOrder,
  orderCountsOnOpenTab,
} from './orderUtils.js';
import { menuItemFromFirestore } from './menuNormalize.js';
import ManualOrderModal from './ManualOrderModal.jsx';
import ServiceRequestsBar from './ServiceRequestsBar.jsx';

function CalendarIcon() {
  return (
    <svg className="orders-icon-calendar" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 2v3M16 2v3M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatTime(createdAt) {
  if (!createdAt) return '—';
  try {
    if (typeof createdAt.toDate === 'function') return createdAt.toDate().toLocaleString();
    if (createdAt.seconds != null) return new Date(createdAt.seconds * 1000).toLocaleString();
  } catch {
    /* ignore */
  }
  return '—';
}

function timeMs(at) {
  if (!at) return 0;
  try {
    if (typeof at.toDate === 'function') return at.toDate().getTime();
    if (at.seconds != null) return at.seconds * 1000;
  } catch {
    /* ignore */
  }
  return 0;
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatHistoryDayLabel(dayKey) {
  const parts = dayKey.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return dayKey;
  const [y, mo, da] = parts;
  const date = new Date(y, mo - 1, da);
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
}

function pastOrderDayKey(o) {
  const ms = timeMs(o.completedAt) || timeMs(o.createdAt);
  if (!ms) return localDayKey(Date.now());
  return localDayKey(ms);
}

function displayCustomerName(o) {
  const raw = o.customerName ?? o.guestName;
  if (raw == null || String(raw).trim() === '') return '—';
  return String(raw).trim();
}

function splitPastByToday(past, todayKey) {
  const pastToday = [];
  const historyByDay = new Map();
  for (const o of past) {
    const k = pastOrderDayKey(o);
    if (k === todayKey) pastToday.push(o);
    else {
      if (!historyByDay.has(k)) historyByDay.set(k, []);
      historyByDay.get(k).push(o);
    }
  }
  const ta = (o) => timeMs(o.completedAt) || timeMs(o.createdAt);
  pastToday.sort((a, b) => ta(a) - ta(b));
  for (const list of historyByDay.values()) {
    list.sort((a, b) => ta(a) - ta(b));
  }
  const dayKeys = [...historyByDay.keys()].sort().reverse();
  const historyGroups = dayKeys.map((key) => ({
    key,
    label: formatHistoryDayLabel(key),
    orders: historyByDay.get(key),
  }));
  return { pastToday, historyGroups };
}

const ORDER_VIEW_STORAGE = 'vegCafe_admin_orderView';

function readStoredOrderView() {
  try {
    const v = sessionStorage.getItem(ORDER_VIEW_STORAGE);
    if (v === 'active' || v === 'past' || v === 'both' || v === 'rejected') return v;
  } catch {
    /* ignore */
  }
  return 'active';
}

function statusLabel(s) {
  const v = String(s || 'pending').toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function statusClass(s) {
  const v = String(s || 'pending').toLowerCase();
  if (v === 'pending') return 'badge badge--pending';
  if (v === 'preparing' || v === 'picked' || v === 'cooking') return 'badge badge--prep';
  if (v === 'ready') return 'badge badge--ready';
  if (v === 'completed' || v === 'delivered' || v === 'closed') return 'badge badge--done';
  if (v === 'rejected') return 'badge badge--reject';
  return 'badge';
}

function OrderCard({ o, updatingId, onPatchStatus, onReject, onEdit }) {
  const name = displayCustomerName(o);
  const st = String(o.status || 'pending').toLowerCase();
  const billed = !isUnbilledOrder(o);
  const src = o.source === 'admin' ? 'Staff' : 'Guest';
  return (
    <li className="order-card order-card--modern">
      <div className="order-card__top">
        <span className={statusClass(o.status)}>{statusLabel(o.status)}</span>
        <span className="order-card__time">{formatTime(o.createdAt)}</span>
      </div>
      <div className="order-card__who">
        <span className="order-card__customer-name">{name}</span>
        <span className="order-card__table-line">
          Table <strong>{o.table ?? '—'}</strong>
          <span className="order-card__source muted"> · {src}</span>
        </span>
      </div>
      <div className="order-card__billing">
        {billed ? (
          <span className="badge badge--done">Bill paid</span>
        ) : st !== 'rejected' ? (
          <button type="button" className="btn btn--ghost btn--small order-card__edit-chip" onClick={() => onEdit?.(o)}>
            ✎ Edit
          </button>
        ) : null}
      </div>
      <div className="order-card__id">
        <code>{o.id}</code>
      </div>
      <ul className="order-card__items">
        {(o.items || []).map((line, i) => (
          <li key={i}>
            {line.name} × {line.qty}{' '}
            <span className="muted">₹{((line.price || 0) * line.qty).toFixed(0)}</span>
          </li>
        ))}
      </ul>
      <div className="order-card__total">Total ₹{Number(o.total || 0).toFixed(2)}</div>
      <div className="order-card__actions">
        {st === 'pending' && (
          <button
            type="button"
            className="btn btn--prep"
            disabled={updatingId === o.id}
            onClick={() => onPatchStatus(o.id, 'preparing')}
          >
            {updatingId === o.id ? '…' : 'Start preparing'}
          </button>
        )}
        {['preparing', 'picked', 'cooking', 'accepted'].includes(st) && (
          <button
            type="button"
            className="btn btn--ready"
            disabled={updatingId === o.id}
            onClick={() => onPatchStatus(o.id, 'ready')}
          >
            {updatingId === o.id ? '…' : 'Mark ready'}
          </button>
        )}
        {st === 'ready' && (
          <button
            type="button"
            className="btn btn--done"
            disabled={updatingId === o.id}
            onClick={() => onPatchStatus(o.id, 'completed')}
          >
            {updatingId === o.id ? '…' : 'Mark completed'}
          </button>
        )}
        {onReject && !billed && st !== 'rejected' ? (
          <button type="button" className="btn btn--danger btn--small" disabled={updatingId === o.id} onClick={() => onReject(o.id)}>
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}

function PastBlock({ title, count, muted, children, emptyText }) {
  return (
    <div className="board-past-block">
      <h3 className={`board-past-block__title ${muted ? 'board-past-block__title--muted' : ''}`}>
        {title}
        <span className={`board-section__count ${muted ? 'board-section__count--muted' : ''}`}>{count}</span>
      </h3>
      {count === 0 ? (
        <p className="muted board-section__empty">{emptyText}</p>
      ) : (
        children
      )}
    </div>
  );
}

function HistoryPanel({
  open,
  onClose,
  historyDateFilter,
  onHistoryDateFilter,
  yesterdayKey,
  oldestDayKey,
  filteredGroups,
  historyOrderCount,
  updatingId,
  onPatchStatus,
}) {
  const panelRef = useRef(null);
  const dateDisabled = historyOrderCount === 0;

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector('[data-history-close]')?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  return (
    <div className="history-overlay" role="presentation">
      <button type="button" className="history-overlay__backdrop" aria-label="Close history" onClick={onClose} />
      <div
        className="history-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-panel-title"
      >
        <header className="history-panel__header">
          <div className="history-panel__head-text">
            <h2 id="history-panel-title" className="history-panel__title">
              Order history
            </h2>
            <p className="history-panel__subtitle">
              {dateDisabled
                ? 'No completed orders from earlier days in the loaded list yet. The calendar is unavailable until there is history.'
                : `${historyOrderCount} completed ${historyOrderCount === 1 ? 'order' : 'orders'} before today. The calendar shows one day at a time — change the date to view that day, or use “Show all days”.`}
            </p>
          </div>
          <button type="button" className="history-panel__close btn btn--ghost" data-history-close onClick={onClose}>
            Close
          </button>
        </header>

        <div className={`history-calendar-card ${dateDisabled ? 'history-calendar-card--disabled' : ''}`}>
          <div className="history-calendar-card__head">
            <CalendarIcon />
            <span className="history-calendar-card__title">Calendar</span>
          </div>
          <div className="history-panel__filters history-panel__filters--calendar">
            <label className="history-date-wrap" htmlFor="history-date-input">
              <span className="history-date-wrap__label">Select date</span>
              <input
                id="history-date-input"
                type="date"
                className="history-date-input"
                value={dateDisabled ? '' : historyDateFilter}
                disabled={dateDisabled}
                min={dateDisabled ? undefined : oldestDayKey ?? undefined}
                max={dateDisabled ? undefined : yesterdayKey}
                onChange={(e) => onHistoryDateFilter(e.target.value)}
                aria-describedby="history-date-hint"
              />
            </label>
            <p id="history-date-hint" className="history-date-hint">
              {dateDisabled
                ? 'Disabled — no past days to browse.'
                : 'Only dates with orders in this list can be picked (between oldest loaded day and yesterday).'}
            </p>
            <button
              type="button"
              className="btn btn--ghost btn--small history-clear-date"
              disabled={dateDisabled || !historyDateFilter}
              onClick={() => onHistoryDateFilter('')}
            >
              Show all days
            </button>
          </div>
        </div>

        <div className="history-panel__body">
          {historyOrderCount === 0 ? (
            <p className="muted history-panel__empty">No orders from earlier days in this list.</p>
          ) : filteredGroups.length === 0 ? (
            <p className="muted history-panel__empty">No orders on that date. Try another day or “Show all days”.</p>
          ) : (
            filteredGroups.map(({ key, label, orders: dayOrders }) => (
              <div key={key} className="board-history-day">
                <h4 className="board-history-day__label">{label}</h4>
                <ul className="order-grid order-grid--past">
                  {dayOrders.map((o) => (
                    <OrderCard key={o.id} o={o} updatingId={updatingId} onPatchStatus={onPatchStatus} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function OrdersBoard({ billingOnly = false }) {
  const [orders, setOrders] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [orderView, setOrderView] = useState(readStoredOrderView);
  const [dayTick, setDayTick] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDateFilter, setHistoryDateFilter] = useState('');
  const [clearAllBusy] = useState(false);
  const [tablesDef, setTablesDef] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [manualOrderOpen, setManualOrderOpen] = useState(false);
  const [settlingTable, setSettlingTable] = useState(null);
  const [lastSettlement, setLastSettlement] = useState(null);
  const [pendingBillPopup, setPendingBillPopup] = useState(null);
  const [billConfirmPopup, setBillConfirmPopup] = useState(null);
  const [billsView, setBillsView] = useState('pending'); // pending | received
  const [settledViewMode, setSettledViewMode] = useState('today'); // today | history
  const [settledFromDate, setSettledFromDate] = useState(() => localDayKey(Date.now())); // default today
  const [settledToDate, setSettledToDate] = useState(() => localDayKey(Date.now())); // default today
  const [selectedSettledDay, setSelectedSettledDay] = useState(() => localDayKey(Date.now()));
  const [editOrder, setEditOrder] = useState(null);
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editItems, setEditItems] = useState([]);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'tables'),
      (snap) => {
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        list.sort(
          (a, b) =>
            (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || (Number(a.number) || 0) - (Number(b.number) || 0),
        );
        setTablesDef(list);
      },
      () => setTablesDef([]),
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'menus'),
      (snap) => {
        const list = [];
        snap.forEach((d) => list.push(menuItemFromFirestore(d)));
        setMenuItems(list);
      },
      () => setMenuItems([]),
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'settlements'), orderBy('settledAt', 'desc'), limit(20));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setSettlements(list);
      },
      () => setSettlements([]),
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(2000));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLoadError(null);
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setOrders(list);
      },
      (err) => {
        setLoadError(err.message || 'Could not load orders');
        setOrders([]);
      },
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setDayTick((t) => t + 1), 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') setDayTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const { active, past, rejected } = useMemo(() => partitionOrdersForAdmin(orders), [orders]);

  const tableNumbersForManual = useMemo(() => {
    const fromDef = tablesDef.map((t) => Number(t.number)).filter((n) => Number.isFinite(n));
    const fromOrders = [...new Set(orders.map((o) => Number(o.table)).filter((n) => Number.isFinite(n) && n > 0))];
    const s = new Set([...fromDef, ...fromOrders]);
    if (s.size === 0) {
      [1, 2, 3, 4, 5, 6].forEach((n) => s.add(n));
    }
    return [...s].sort((a, b) => a - b);
  }, [tablesDef, orders]);

  const billTableNumbers = useMemo(() => {
    const fromDef = tablesDef.map((t) => Number(t.number)).filter((n) => Number.isFinite(n));
    const fromTabs = [
      ...new Set(orders.filter((o) => orderCountsOnOpenTab(o)).map((o) => Number(o.table)).filter((n) => Number.isFinite(n))),
    ];
    const s = new Set([...fromDef, ...fromTabs]);
    return [...s].sort((a, b) => a - b);
  }, [tablesDef, orders]);

  const pendingBillsSummary = useMemo(() => {
    const rows = billTableNumbers.map((n) => ({
      table: n,
      amount: openTabTotalForTable(orders, n),
    }));
    const withDue = rows.filter((r) => r.amount > 0);
    return {
      tableCountWithDue: withDue.length,
      totalPendingAmount: withDue.reduce((s, r) => s + r.amount, 0),
    };
  }, [billTableNumbers, orders]);

  const openTableNameByNumber = useMemo(() => {
    const byTable = new Map();
    const openOrders = orders
      .filter((o) => orderCountsOnOpenTab(o))
      .slice()
      .sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt));
    for (const o of openOrders) {
      const t = Number(o.table);
      if (!Number.isFinite(t) || byTable.has(t)) continue;
      const name = displayCustomerName(o);
      if (name !== '—') byTable.set(t, name);
    }
    return byTable;
  }, [orders]);

  const todayKey = useMemo(() => localDayKey(Date.now()), [orders, dayTick]);

  const yesterdayKey = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return localDayKey(d.getTime());
  }, [dayTick]);

  const { pastToday, historyGroups } = useMemo(
    () => splitPastByToday(past, todayKey),
    [past, todayKey],
  );

  const historyOrderCount = useMemo(
    () => historyGroups.reduce((sum, g) => sum + g.orders.length, 0),
    [historyGroups],
  );

  const oldestDayKey = useMemo(() => {
    if (historyGroups.length === 0) return null;
    return [...historyGroups.map((g) => g.key)].sort()[0];
  }, [historyGroups]);

  const filteredHistoryGroups = useMemo(() => {
    if (!historyDateFilter) return historyGroups;
    return historyGroups.filter((g) => g.key === historyDateFilter);
  }, [historyGroups, historyDateFilter]);

  const settlementsSummary = useMemo(() => {
    const totalSettledAmount = settlements.reduce((s, it) => s + Number(it.amount || 0), 0);
    const totalSettledOrders = settlements.reduce(
      (s, it) => s + Number(it.orderCount ?? (Array.isArray(it.orderIds) ? it.orderIds.length : 0)),
      0,
    );
    return {
      totalSettlements: settlements.length,
      totalSettledAmount,
      totalSettledOrders,
    };
  }, [settlements]);

  const filteredSettlements = useMemo(() => {
    const today = localDayKey(Date.now());
    const from = settledViewMode === 'today' ? today : settledFromDate || '';
    const to = settledViewMode === 'today' ? today : settledToDate || '';
    if (!from && !to) return settlements;
    return settlements.filter((s) => {
      const k = localDayKey(timeMs(s.settledAt) || Date.now());
      if (from && k < from) return false;
      if (to && k > to) return false;
      return true;
    });
  }, [settlements, settledFromDate, settledToDate, settledViewMode]);

  const settlementsByDay = useMemo(() => {
    const map = new Map();
    filteredSettlements.forEach((s) => {
      const k = localDayKey(timeMs(s.settledAt) || Date.now());
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    });
    const keys = [...map.keys()].sort().reverse();
    return keys.map((key) => {
      const rows = map.get(key) || [];
      return {
        key,
        label: formatHistoryDayLabel(key),
        settlements: rows,
        totalAmount: rows.reduce((sum, it) => sum + Number(it.amount || 0), 0),
        totalOrders: rows.reduce(
          (sum, it) => sum + Number(it.orderCount ?? (Array.isArray(it.orderIds) ? it.orderIds.length : 0)),
          0,
        ),
      };
    });
  }, [filteredSettlements]);

  useEffect(() => {
    if (settlementsByDay.length === 0) {
      setSelectedSettledDay('');
      return;
    }
    const exists = settlementsByDay.some((d) => d.key === selectedSettledDay);
    if (!selectedSettledDay || !exists) {
      setSelectedSettledDay(settlementsByDay[0].key);
    }
  }, [settlementsByDay, selectedSettledDay]);

  const selectedSettledRows = useMemo(() => {
    if (!selectedSettledDay) return [];
    const hit = settlementsByDay.find((d) => d.key === selectedSettledDay);
    return hit?.settlements || [];
  }, [settlementsByDay, selectedSettledDay]);

  const filteredSettlementsSummary = useMemo(() => {
    const totalSettledAmount = filteredSettlements.reduce((s, it) => s + Number(it.amount || 0), 0);
    const totalSettledOrders = filteredSettlements.reduce(
      (s, it) => s + Number(it.orderCount ?? (Array.isArray(it.orderIds) ? it.orderIds.length : 0)),
      0,
    );
    return {
      totalSettlements: filteredSettlements.length,
      totalSettledAmount,
      totalSettledOrders,
    };
  }, [filteredSettlements]);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setHistoryDateFilter('');
  }, []);
  const closePendingBillPopup = useCallback(() => setPendingBillPopup(null), []);
  const closeBillConfirmPopup = useCallback(() => setBillConfirmPopup(null), []);
  const closeEditModal = useCallback(() => {
    setEditOrder(null);
    setEditCustomerName('');
    setEditItems([]);
    setEditError(null);
    setEditBusy(false);
  }, []);

  /** Latest history day pre-selected so the calendar and list stay in sync when opening. */
  const openHistory = useCallback(() => {
    if (historyOrderCount > 0) {
      setHistoryDateFilter(historyGroups[0]?.key ?? '');
    } else {
      setHistoryDateFilter('');
    }
    setHistoryOpen(true);
  }, [historyOrderCount, historyGroups]);

  useEffect(() => {
    if (!historyOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') closeHistory();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [historyOpen, closeHistory]);

  const setOrderViewPersist = (value) => {
    setOrderView(value);
    try {
      sessionStorage.setItem(ORDER_VIEW_STORAGE, value);
    } catch {
      /* ignore */
    }
  };

  const showActive = orderView === 'active' || orderView === 'both';
  const showPast = orderView === 'past' || orderView === 'both';
  const showRejected = orderView === 'rejected';

  const patchStatus = async (orderId, status) => {
    setActionError(null);
    setUpdatingId(orderId);
    try {
      const payload = { status };
      if (String(status).toLowerCase() === 'completed') {
        payload.completedAt = serverTimestamp();
      }
      await updateDoc(doc(db, 'orders', orderId), payload);
    } catch (e) {
      setActionError(e.message || 'Update failed');
    } finally {
      setUpdatingId(null);
    }
  };

  const openEditModal = (o) => {
    setEditOrder(o);
    setEditCustomerName(displayCustomerName(o) === '—' ? '' : displayCustomerName(o));
    setEditItems(
      (o.items || []).map((line, i) => ({
        id: `${o.id}-${i}`,
        name: String(line.name || ''),
        qty: Math.max(1, Number(line.qty) || 1),
        price: Number(line.price || 0),
      })),
    );
    setEditError(null);
    setEditBusy(false);
  };

  const changeEditItem = (idx, field, value) => {
    setEditItems((prev) => {
      const next = [...prev];
      if (!next[idx]) return prev;
      if (field === 'qty') next[idx] = { ...next[idx], qty: Math.max(1, Number(value) || 1) };
      else if (field === 'price') next[idx] = { ...next[idx], price: Math.max(0, Number(value) || 0) };
      else next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const addEditItem = () => {
    setEditItems((prev) => [...prev, { id: `new-${Date.now()}-${prev.length}`, name: '', qty: 1, price: 0 }]);
  };

  const removeEditItem = (idx) => {
    setEditItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const saveOrderEdit = async () => {
    if (!editOrder) return;
    const items = editItems
      .map((line) => ({
        name: String(line.name || '').trim(),
        qty: Math.max(1, Number(line.qty) || 1),
        price: Math.max(0, Number(line.price) || 0),
      }))
      .filter((line) => line.name !== '');
    if (items.length === 0) {
      setEditError('Add at least one valid item name.');
      return;
    }
    const total = items.reduce((s, i) => s + i.qty * i.price, 0);
    setEditBusy(true);
    setEditError(null);
    try {
      await updateDoc(doc(db, 'orders', editOrder.id), {
        customerName: String(editCustomerName || '').trim() || 'Walk-in',
        items,
        total,
      });
      closeEditModal();
    } catch (e) {
      setEditError(e?.message || 'Could not save order changes');
    } finally {
      setEditBusy(false);
    }
  };

  const rejectOrder = async (orderId) => {
    if (!window.confirm('Reject this order? It leaves the kitchen queue and is removed from the open tab total.')) {
      return;
    }
    setActionError(null);
    setUpdatingId(orderId);
    try {
      await updateDoc(doc(db, 'orders', orderId), { status: 'rejected' });
    } catch (e) {
      setActionError(e?.message || 'Reject failed');
    } finally {
      setUpdatingId(null);
    }
  };

  const doSettleTableBill = async (t, list, sum) => {
    setSettlingTable(t);
    setActionError(null);
    try {
      let left = [...list];
      while (left.length > 0) {
        const chunk = left.slice(0, 500);
        left = left.slice(500);
        const batch = writeBatch(db);
        chunk.forEach((o) => {
          batch.update(doc(db, 'orders', o.id), { billingStatus: 'billed', billedAt: serverTimestamp() });
        });
        await batch.commit();
      }
      await addDoc(collection(db, 'settlements'), {
        table: t,
        amount: sum,
        orderCount: list.length,
        orderIds: list.map((o) => o.id),
        settledAt: serverTimestamp(),
      });
      await releaseTableLock(db, t);
      setLastSettlement({ table: t, amount: sum, at: Date.now() });
    } catch (e) {
      setActionError(e?.message || 'Could not settle bill');
    } finally {
      setSettlingTable(null);
    }
  };

  const confirmSettleFromPopup = async () => {
    const p = billConfirmPopup;
    if (!p) return;
    setBillConfirmPopup(null);
    await doSettleTableBill(p.table, p.orders, p.amount);
  };

  const settleTableBill = async (tableNum) => {
    const t = Number(tableNum);
    const list = orders.filter((o) => Number(o.table) === t && orderCountsOnOpenTab(o));
    if (list.length === 0) return;
    const pending = list.filter((o) => !isKitchenTerminalStatus(o.status));
    if (pending.length > 0) {
      const statusSummary = pending.reduce((acc, o) => {
        const key = String(o.status || 'pending').toLowerCase();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const statusLine = Object.entries(statusSummary)
        .map(([k, c]) => `${k}: ${c}`)
        .join(', ');
      setPendingBillPopup({
        table: t,
        pendingCount: pending.length,
        statusLine,
      });
      return;
    }
    const sum = list.reduce((s, o) => s + Number(o.total || 0), 0);
    setBillConfirmPopup({
      table: t,
      amount: sum,
      orderCount: list.length,
      orders: list,
    });
  };

  return (
    <div className="board orders-board-modern">
      {!billingOnly ? (
        <div className="orders-toolbar">
          <div className="orders-toolbar__main">
            <span className="orders-toolbar__caption">View</span>
            <div className="orders-segment" role="group" aria-label="Order list view">
              {[
                { value: 'active', label: 'Active' },
                { value: 'past', label: 'Past' },
                { value: 'both', label: 'Both' },
                { value: 'rejected', label: 'Rejected' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`orders-segment__btn ${orderView === value ? 'orders-segment__btn--on' : ''}`}
                  aria-pressed={orderView === value}
                  onClick={() => setOrderViewPersist(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="btn btn--primary btn--small" onClick={() => setManualOrderOpen(true)}>
            Manual order
          </button>
          <button
            type="button"
            className="orders-history-launch"
            disabled={historyOrderCount === 0}
            onClick={openHistory}
          >
            <CalendarIcon />
            <span className="orders-history-launch__text">History</span>
            <span className="orders-history-launch__badge">{historyOrderCount}</span>
          </button>
        </div>
      ) : null}

      <p className="board__hint board__hint--modern">
        {billingOnly ? (
          <>
            <strong>Billing desk</strong> — settle table totals here. Use <strong>Bill paid</strong> when money is
            collected to mark unpaid orders as billed and unlock that table QR for the next guest.
          </>
        ) : (
          <>
            <strong>Live</strong> — lists update automatically from Firestore. Guests get their table only from the{' '}
            <strong>QR printed in Tables &amp; QR</strong> (six tables; each QR sets <code>?table=</code>). The table
            stays locked for other phones until <strong>Bill paid</strong> (not when kitchen marks completed).{' '}
            <strong>Open tab</strong> shows unpaid totals per table. Use <strong>Rejected</strong> for voids and{' '}
            <strong>Manual order</strong> for walk-ins.
          </>
        )}
      </p>

      {loadError && (
        <div className="alert alert--error" role="alert">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="alert alert--error" role="alert">
          {actionError}
        </div>
      )}

      <ServiceRequestsBar />

      {pendingBillPopup ? (
        <div className="orders-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pending-bill-popup-title">
          <button
            type="button"
            className="orders-modal-overlay__backdrop"
            aria-label="Close"
            onClick={closePendingBillPopup}
          />
          <div className="orders-modal-panel orders-modal-panel--warning">
            <header className="orders-modal-panel__head">
              <span className="orders-modal-panel__icon" aria-hidden="true">
                !
              </span>
              <h2 id="pending-bill-popup-title">Orders still pending</h2>
            </header>
            <div className="orders-modal-panel__body">
              <p className="orders-modal-panel__lead">
                Cannot clear bill for <strong>table {pendingBillPopup.table}</strong> yet.
              </p>
              <p className="orders-modal-panel__meta">
                {pendingBillPopup.pendingCount} order(s) are still pending delivery.
              </p>
              <p className="orders-modal-panel__status">
                <span className="orders-modal-panel__status-label">Status</span>
                <span>{pendingBillPopup.statusLine}</span>
              </p>
              <p className="orders-modal-panel__hint">Please deliver/complete all orders first, then tap Bill paid.</p>
            </div>
            <div className="orders-modal-panel__footer">
              <button type="button" className="btn btn--primary orders-modal-panel__ok" onClick={closePendingBillPopup}>
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {billConfirmPopup ? (
        <div className="orders-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="bill-confirm-popup-title">
          <button
            type="button"
            className="orders-modal-overlay__backdrop"
            aria-label="Close"
            onClick={closeBillConfirmPopup}
          />
          <div className="orders-modal-panel orders-modal-panel--confirm">
            <header className="orders-modal-panel__head orders-modal-panel__head--confirm">
              <span className="orders-modal-panel__icon orders-modal-panel__icon--confirm" aria-hidden="true">
                ₹
              </span>
              <h2 id="bill-confirm-popup-title">Confirm bill paid</h2>
            </header>
            <div className="orders-modal-panel__body">
              <p className="orders-modal-panel__lead">
                Record bill paid for <strong>table {billConfirmPopup.table}</strong>?
              </p>
              <p className="orders-modal-panel__status orders-modal-panel__status--confirm">
                <span className="orders-modal-panel__status-label orders-modal-panel__status-label--confirm">Collect</span>
                <strong>₹{Number(billConfirmPopup.amount || 0).toFixed(2)}</strong>
                <span className="muted">from {billConfirmPopup.orderCount} order(s)</span>
              </p>
              <p className="orders-modal-panel__hint">
                This will mark those orders as billed and unlock the table QR for the next guest.
              </p>
            </div>
            <div className="orders-modal-panel__footer orders-modal-panel__footer--confirm">
              <button type="button" className="btn btn--ghost" onClick={closeBillConfirmPopup} disabled={settlingTable === billConfirmPopup.table}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary orders-modal-panel__ok"
                onClick={confirmSettleFromPopup}
                disabled={settlingTable === billConfirmPopup.table}
              >
                {settlingTable === billConfirmPopup.table ? 'Saving…' : 'Confirm Bill Paid'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {lastSettlement ? (
        <div className="alert alert--success settlement-banner" role="status">
          <span>
            Collected <strong>₹{Number(lastSettlement.amount).toFixed(2)}</strong> for table{' '}
            <strong>{lastSettlement.table}</strong> — table unlocked for the next guest.
          </span>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setLastSettlement(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {billingOnly ? (
        <>
          <div className="bill-views" role="tablist" aria-label="Bills view">
            <button
              type="button"
              role="tab"
              aria-selected={billsView === 'pending'}
              className={`orders-segment__btn ${billsView === 'pending' ? 'orders-segment__btn--on' : ''}`}
              onClick={() => setBillsView('pending')}
            >
              Pending
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={billsView === 'received'}
              className={`orders-segment__btn ${billsView === 'received' ? 'orders-segment__btn--on' : ''}`}
              onClick={() => setBillsView('received')}
            >
              Received
            </button>
          </div>

          {billsView === 'pending' ? (
            <section className="bill-strip" aria-label="Open tab totals by table">
              <h3 className="bill-strip__title">Pending bills by table</h3>
              <p className="bill-strip__meta muted">
                Tables with pending bill: <strong>{pendingBillsSummary.tableCountWithDue}</strong> · Pending total:{' '}
                <strong>₹{pendingBillsSummary.totalPendingAmount.toFixed(2)}</strong>
              </p>
              <div className="bill-strip__grid">
                {billTableNumbers.map((n) => {
                  const total = openTabTotalForTable(orders, n);
                  return (
                    <div key={n} className={`bill-pill ${total > 0 ? 'bill-pill--has' : 'bill-pill--empty'}`}>
                      <span className="bill-pill__label">Table {n}</span>
                      <span className="bill-pill__amt">₹{total.toFixed(2)}</span>
                      <button
                        type="button"
                        className="btn btn--done btn--small"
                        disabled={total <= 0 || settlingTable === n || clearAllBusy}
                        onClick={() => settleTableBill(n)}
                      >
                        {settlingTable === n ? '…' : 'Bill paid'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <section className="settlements-strip" aria-label="Settled bill history">
              <h3 className="settlements-strip__title">Settled bills history</h3>
              <div className="settlements-strip__controls">
                <button
                  type="button"
                  className={`btn btn--small ${settledViewMode === 'today' ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => {
                    const today = localDayKey(Date.now());
                    setSettledViewMode('today');
                    setSettledFromDate(today);
                    setSettledToDate(today);
                    setSelectedSettledDay(today);
                  }}
                >
                  Today
                </button>
                <button
                  type="button"
                  className={`btn btn--small ${settledViewMode === 'history' ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setSettledViewMode('history')}
                >
                  History
                </button>
                {settledViewMode === 'history' ? (
                  <>
                    <label className="settlements-strip__date-label">
                      From
                      <input
                        type="date"
                        className="history-date-input"
                        value={settledFromDate}
                        onChange={(e) => setSettledFromDate(e.target.value)}
                        max={settledToDate || localDayKey(Date.now())}
                      />
                    </label>
                    <label className="settlements-strip__date-label">
                      To
                      <input
                        type="date"
                        className="history-date-input"
                        value={settledToDate}
                        onChange={(e) => setSettledToDate(e.target.value)}
                        min={settledFromDate || undefined}
                        max={localDayKey(Date.now())}
                      />
                    </label>
                  </>
                ) : null}
              </div>
              <p className="settlements-strip__meta muted">
                Settlements: <strong>{filteredSettlementsSummary.totalSettlements}</strong> · Customers/orders settled:{' '}
                <strong>{filteredSettlementsSummary.totalSettledOrders}</strong> · Total settled amount:{' '}
                <strong>₹{filteredSettlementsSummary.totalSettledAmount.toFixed(2)}</strong>
              </p>
              {settlementsByDay.length === 0 ? (
                <p className="muted">
                  {settledViewMode === 'today' ? 'No settled bills for today.' : 'No settled bills in selected range.'}
                </p>
              ) : settledViewMode === 'history' ? (
                <>
                  <div className="settlements-days">
                    {settlementsByDay.map((day) => (
                      <button
                        key={day.key}
                        type="button"
                        className={`settlements-day ${selectedSettledDay === day.key ? 'settlements-day--active' : ''}`}
                        onClick={() => setSelectedSettledDay(day.key)}
                      >
                        <span className="settlements-day__label">{day.label}</span>
                        <span className="settlements-day__meta">
                          {day.settlements.length} settlement(s) · ₹{day.totalAmount.toFixed(2)}
                        </span>
                      </button>
                    ))}
                  </div>
                  <ul className="settlements-strip__list">
                    {selectedSettledRows.map((s) => (
                      <li key={s.id}>
                        Table <strong>{s.table}</strong> · ₹{Number(s.amount || 0).toFixed(2)} ·{' '}
                        {s.orderCount ?? (s.orderIds?.length || 0)} order(s) · {formatTime(s.settledAt)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <ul className="settlements-strip__list">
                  {filteredSettlements.map((s) => (
                    <li key={s.id}>
                      Table <strong>{s.table}</strong> · ₹{Number(s.amount || 0).toFixed(2)} ·{' '}
                      {s.orderCount ?? (s.orderIds?.length || 0)} order(s) · {formatTime(s.settledAt)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      ) : null}

      {!billingOnly ? (
        <>
          <ManualOrderModal
            open={manualOrderOpen}
            onClose={() => setManualOrderOpen(false)}
            tableNumbers={tableNumbersForManual}
            menuItems={menuItems}
            openTableNameByNumber={openTableNameByNumber}
            onPlaced={() => setManualOrderOpen(false)}
          />

          <HistoryPanel
            open={historyOpen}
            onClose={closeHistory}
            historyDateFilter={historyDateFilter}
            onHistoryDateFilter={setHistoryDateFilter}
            yesterdayKey={yesterdayKey}
            oldestDayKey={oldestDayKey}
            filteredGroups={filteredHistoryGroups}
            historyOrderCount={historyOrderCount}
            updatingId={updatingId}
            onPatchStatus={patchStatus}
          />
        </>
      ) : null}

      {!billingOnly && orders.length === 0 && !loadError && !showRejected ? (
        <p className="muted board__empty">No orders yet.</p>
      ) : !billingOnly ? (
        <div className="board-sections">
          {showRejected ? (
            <section className="board-surface board-surface--rejected" aria-labelledby="orders-rejected-heading">
              <h2 id="orders-rejected-heading" className="board-section__title board-section__title--lg">
                Rejected orders
                <span className="board-section__count">{rejected.length}</span>
              </h2>
              <p className="board-section__sub muted">Voided or refused tickets — totals do not count on open tabs.</p>
              {rejected.length === 0 ? (
                <p className="muted board-section__empty">No rejected orders.</p>
              ) : (
                <ul className="order-grid">
                  {rejected.map((o) => (
                    <OrderCard
                      key={o.id}
                      o={o}
                      updatingId={updatingId}
                      onPatchStatus={patchStatus}
                      onReject={undefined}
                      onEdit={openEditModal}
                    />
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <>
              {showActive ? (
                <section className="board-surface board-surface--active" aria-labelledby="orders-active-heading">
                  <h2 id="orders-active-heading" className="board-section__title board-section__title--lg">
                    Active orders
                    <span className="board-section__count">{active.length}</span>
                  </h2>
                  <p className="board-section__sub muted">First guest at the top — same order they joined the queue.</p>
                  {active.length === 0 ? (
                    <p className="muted board-section__empty">No active orders right now.</p>
                  ) : (
                    <ul className="order-grid">
                      {active.map((o) => (
                        <OrderCard
                          key={o.id}
                          o={o}
                          updatingId={updatingId}
                          onPatchStatus={patchStatus}
                          onReject={rejectOrder}
                          onEdit={openEditModal}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {showPast ? (
                <section
                  className={`board-surface board-surface--past ${showActive && showPast ? 'board-surface--past-below' : ''}`}
                  aria-labelledby="orders-past-heading"
                >
                  <h2 id="orders-past-heading" className="board-section__title board-section__title--lg">
                    Completed today
                    <span className="board-section__count board-section__count--muted">{pastToday.length}</span>
                  </h2>
                  <p className="board-section__sub muted">
                    Kitchen finished today (local time). Open-tab totals stay until <strong>Bill paid</strong>.
                  </p>

                  <PastBlock
                    title="Today's receipts"
                    count={pastToday.length}
                    muted={false}
                    emptyText="No completed orders today yet."
                  >
                    <ul className="order-grid order-grid--past">
                      {pastToday.map((o) => (
                        <OrderCard
                          key={o.id}
                          o={o}
                          updatingId={updatingId}
                          onPatchStatus={patchStatus}
                          onReject={rejectOrder}
                          onEdit={openEditModal}
                        />
                      ))}
                    </ul>
                  </PastBlock>

              <button
                type="button"
                className="history-cta"
                disabled={historyOrderCount === 0}
                onClick={openHistory}
              >
                <div className="history-cta__icon-wrap" aria-hidden="true">
                  <CalendarIcon />
                </div>
                <div className="history-cta__text">
                  <span className="history-cta__title">Browse order history</span>
                  <span className="history-cta__desc">
                    {historyOrderCount === 0
                      ? 'No earlier days in the loaded list yet.'
                      : `${historyOrderCount} order${historyOrderCount === 1 ? '' : 's'} on earlier days — open to filter by date.`}
                  </span>
                </div>
                <span className="history-cta__chev" aria-hidden="true">
                  →
                </span>
              </button>
            </section>
          ) : null}
            </>
          )}
        </div>
      ) : null}

      {editOrder ? (
        <div className="orders-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-order-title">
          <button type="button" className="orders-modal-overlay__backdrop" aria-label="Close" onClick={closeEditModal} />
          <div className="orders-modal-panel orders-modal-panel--confirm">
            <header className="orders-modal-panel__head orders-modal-panel__head--confirm">
              <span className="orders-modal-panel__icon orders-modal-panel__icon--confirm" aria-hidden="true">
                ✎
              </span>
              <h2 id="edit-order-title">Edit order</h2>
            </header>
            <div className="orders-modal-panel__body">
              {editError ? (
                <div className="alert alert--error" role="alert">
                  {editError}
                </div>
              ) : null}
              <label className="settings-card__hint">
                Name on ticket
                <input
                  className="orders-edit-input"
                  type="text"
                  value={editCustomerName}
                  onChange={(e) => setEditCustomerName(e.target.value)}
                  disabled={editBusy}
                />
              </label>

              <div className="orders-edit-items">
                {editItems.map((line, idx) => (
                  <div key={line.id} className="orders-edit-item-row">
                    <input
                      className="orders-edit-input orders-edit-input--name"
                      type="text"
                      placeholder="Item"
                      value={line.name}
                      onChange={(e) => changeEditItem(idx, 'name', e.target.value)}
                      disabled={editBusy}
                    />
                    <input
                      className="orders-edit-input orders-edit-input--qty"
                      type="number"
                      min={1}
                      value={line.qty}
                      onChange={(e) => changeEditItem(idx, 'qty', e.target.value)}
                      disabled={editBusy}
                    />
                    <span className="orders-edit-price-readonly">₹{Number(line.price || 0).toFixed(2)} each</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="orders-modal-panel__footer orders-modal-panel__footer--confirm">
              <button type="button" className="btn btn--ghost" onClick={closeEditModal} disabled={editBusy}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={saveOrderEdit} disabled={editBusy}>
                {editBusy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
