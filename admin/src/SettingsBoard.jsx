import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, writeBatch, query, where, limit, doc, addDoc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { db } from './firebase.js';
import { releaseTableLock } from '../../src/tableLockFirestore.js';
import TablesBoard from './TablesBoard.jsx';
import MenusBoard from './MenusBoard.jsx';
import { isKitchenTerminalStatus, orderCountsOnOpenTab } from './orderUtils.js';

/** Deletes every document in a collection (500 writes per batch). Returns count removed. */
async function deleteEveryDocInCollection(firestore, collName) {
  const snap = await getDocs(collection(firestore, collName));
  const docs = snap.docs;
  let removed = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = writeBatch(firestore);
    docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += Math.min(500, docs.length - i);
  }
  return removed;
}

export default function SettingsBoard() {
  const [section, setSection] = useState('general'); // general | tables | menus
  const [actionError, setActionError] = useState(null);
  const [freeTableInput, setFreeTableInput] = useState('');
  const [freeTableBusy, setFreeTableBusy] = useState(false);
  const [clearAllBusy, setClearAllBusy] = useState(false);
  const [unlockFlow, setUnlockFlow] = useState(null);
  const [tablesDef, setTablesDef] = useState([]);

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

  const tableNumbers = useMemo(
    () => tablesDef.map((t) => Number(t.number)).filter((n) => Number.isFinite(n) && n > 0),
    [tablesDef],
  );

  const summarizeStatuses = (rows) => {
    const map = {};
    rows.forEach((o) => {
      const s = String(o.status || 'pending').toLowerCase();
      map[s] = (map[s] || 0) + 1;
    });
    return Object.entries(map)
      .map(([k, c]) => `${k}: ${c}`)
      .join(', ');
  };

  const settleAsBillPaid = async (tableNum, orders) => {
    const sum = orders.reduce((s, o) => s + Number(o.total || 0), 0);
    let left = [...orders];
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
      table: tableNum,
      amount: sum,
      orderCount: orders.length,
      orderIds: orders.map((o) => o.id),
      settledAt: serverTimestamp(),
    });
    await releaseTableLock(db, tableNum);
  };

  const cancelPendingOrders = async (tableNum, orders) => {
    let left = [...orders];
    while (left.length > 0) {
      const chunk = left.slice(0, 500);
      left = left.slice(500);
      const batch = writeBatch(db);
      chunk.forEach((o) => {
        batch.update(doc(db, 'orders', o.id), {
          status: 'rejected',
          rejectedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }
    await releaseTableLock(db, tableNum);
  };

  const freeTableManually = async () => {
    const raw = String(freeTableInput || '').trim();
    if (raw === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setActionError('Enter a valid table number');
      return;
    }
    setActionError(null);
    setFreeTableBusy(true);
    try {
      const snap = await getDocs(query(collection(db, 'orders'), where('table', '==', n), limit(300)));
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      const openOrders = rows.filter((o) => orderCountsOnOpenTab(o));
      const pending = openOrders.filter((o) => !isKitchenTerminalStatus(o.status));

      if (pending.length > 0) {
        setUnlockFlow({
          type: 'pending',
          table: n,
          pendingCount: pending.length,
          statusLine: summarizeStatuses(pending),
        });
        return;
      }
      if (openOrders.length > 0) {
        setUnlockFlow({
          type: 'billDue',
          table: n,
          orderCount: openOrders.length,
          amount: openOrders.reduce((s, o) => s + Number(o.total || 0), 0),
          orders: openOrders,
        });
        return;
      }
      setUnlockFlow({ type: 'confirm', table: n });
    } catch (e) {
      setActionError(e?.message || 'Could not free table');
    } finally {
      setFreeTableBusy(false);
    }
  };

  const closeUnlockFlow = () => setUnlockFlow(null);

  const doUnlockConfirmed = async () => {
    if (!unlockFlow) return;
    setActionError(null);
    setFreeTableBusy(true);
    try {
      await releaseTableLock(db, unlockFlow.table);
      setFreeTableInput('');
      setUnlockFlow(null);
    } catch (e) {
      setActionError(e?.message || 'Could not free table');
    } finally {
      setFreeTableBusy(false);
    }
  };

  const doBillPaidAndUnlock = async () => {
    if (!unlockFlow || unlockFlow.type !== 'billDue') return;
    setActionError(null);
    setFreeTableBusy(true);
    try {
      await settleAsBillPaid(unlockFlow.table, unlockFlow.orders);
      setFreeTableInput('');
      setUnlockFlow(null);
    } catch (e) {
      setActionError(e?.message || 'Could not mark bill paid');
    } finally {
      setFreeTableBusy(false);
    }
  };

  const doCancelOrdersAndUnlock = async () => {
    if (!unlockFlow || unlockFlow.type !== 'billDue') return;
    setActionError(null);
    setFreeTableBusy(true);
    try {
      await cancelPendingOrders(unlockFlow.table, unlockFlow.orders);
      setFreeTableInput('');
      setUnlockFlow(null);
    } catch (e) {
      setActionError(e?.message || 'Could not cancel orders');
    } finally {
      setFreeTableBusy(false);
    }
  };

  const clearAllOrders = async () => {
    if (
      !window.confirm(
        'Delete ALL orders from the database? This cannot be undone. Table QR locks and settlements will be cleared too.',
      )
    ) {
      return;
    }
    const typed = window.prompt('Type DELETE ALL exactly to confirm:');
    if (typed !== 'DELETE ALL') {
      setActionError('Clear cancelled — confirmation text did not match.');
      return;
    }
    setActionError(null);
    setClearAllBusy(true);
    try {
      const orderCount = await deleteEveryDocInCollection(db, 'orders');
      const lockCount = await deleteEveryDocInCollection(db, 'tableLocks');
      const settleCount = await deleteEveryDocInCollection(db, 'settlements');
      const serviceCount = await deleteEveryDocInCollection(db, 'serviceRequests');
      window.alert(
        `Removed ${orderCount} order(s), ${lockCount} table lock(s), ${settleCount} settlement record(s), ${serviceCount} service request(s).`,
      );
    } catch (e) {
      setActionError(e?.message || 'Could not clear data.');
    } finally {
      setClearAllBusy(false);
    }
  };

  return (
    <div className="settings-board">
      <div className="settings-subtabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          className={`settings-subtab ${section === 'general' ? 'settings-subtab--active' : ''}`}
          role="tab"
          aria-selected={section === 'general'}
          onClick={() => setSection('general')}
        >
          General
        </button>
        <button
          type="button"
          className={`settings-subtab ${section === 'tables' ? 'settings-subtab--active' : ''}`}
          role="tab"
          aria-selected={section === 'tables'}
          onClick={() => setSection('tables')}
        >
          Tables &amp; QR
        </button>
        <button
          type="button"
          className={`settings-subtab ${section === 'menus' ? 'settings-subtab--active' : ''}`}
          role="tab"
          aria-selected={section === 'menus'}
          onClick={() => setSection('menus')}
        >
          Food list
        </button>
      </div>

      {section === 'general' ? (
        <section className="board settings-general">
          <h2 className="board-section__title board-section__title--lg">Settings</h2>
          <p className="board__hint board__hint--modern">
            Rarely used controls are grouped here to keep Orders and Bills screens clean.
          </p>

          {actionError ? (
            <div className="alert alert--error" role="alert">
              {actionError}
            </div>
          ) : null}

          <div className="settings-card">
            <h3 className="settings-card__title">Free table lock</h3>
            <p className="muted settings-card__hint">Use only when a table is stuck and needs manual unlock.</p>
            <div className="settings-free-table-row" role="group" aria-label="Free table for new guests">
              <label className="orders-free-table-label" htmlFor="settings-free-table-num">
                Table number
              </label>
              <select
                id="settings-free-table-num"
                className="orders-free-table-input settings-free-table-select"
                value={freeTableInput}
                onChange={(e) => setFreeTableInput(e.target.value)}
                disabled={freeTableBusy || tableNumbers.length === 0}
              >
                <option value="">Select…</option>
                {tableNumbers.map((n) => (
                  <option key={n} value={n}>
                    Table {n}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={freeTableBusy || String(freeTableInput || '').trim() === '' || tableNumbers.length === 0}
                onClick={freeTableManually}
              >
                {freeTableBusy ? '…' : 'Unlock'}
              </button>
            </div>
            {tableNumbers.length === 0 ? (
              <p className="muted settings-card__hint">No tables found. Create tables in Settings → Tables &amp; QR first.</p>
            ) : null}
          </div>

          <div className="settings-card settings-card--danger">
            <h3 className="settings-card__title">Danger zone</h3>
            <p className="muted settings-card__hint">Deletes orders, table locks, settlements, and service requests.</p>
            <button
              type="button"
              className="btn btn--danger btn--small"
              disabled={clearAllBusy || freeTableBusy}
              onClick={clearAllOrders}
            >
              {clearAllBusy ? 'Clearing…' : 'Clear all orders'}
            </button>
          </div>
        </section>
      ) : null}

      {unlockFlow ? (
        <div className="orders-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-unlock-flow-title">
          <button type="button" className="orders-modal-overlay__backdrop" aria-label="Close" onClick={closeUnlockFlow} />
          <div className={`orders-modal-panel ${unlockFlow.type === 'pending' ? 'orders-modal-panel--warning' : 'orders-modal-panel--confirm'}`}>
            <header className={`orders-modal-panel__head ${unlockFlow.type === 'pending' ? '' : 'orders-modal-panel__head--confirm'}`}>
              <span className={`orders-modal-panel__icon ${unlockFlow.type === 'pending' ? '' : 'orders-modal-panel__icon--confirm'}`} aria-hidden="true">
                {unlockFlow.type === 'pending' ? '!' : '₹'}
              </span>
              <h2 id="settings-unlock-flow-title">
                {unlockFlow.type === 'confirm'
                  ? 'Confirm table unlock'
                  : unlockFlow.type === 'pending'
                    ? 'Orders pending'
                    : 'Bill due on this table'}
              </h2>
            </header>
            <div className="orders-modal-panel__body">
              {unlockFlow.type === 'confirm' ? (
                <>
                  <p className="orders-modal-panel__lead">
                    Are you sure you want to clear <strong>table {unlockFlow.table}</strong>?
                  </p>
                  <p className="orders-modal-panel__hint">This unlocks the QR so a new guest can start ordering.</p>
                </>
              ) : null}

              {unlockFlow.type === 'pending' ? (
                <>
                  <p className="orders-modal-panel__lead">
                    Table <strong>{unlockFlow.table}</strong> still has pending orders.
                  </p>
                  <p className="orders-modal-panel__meta">{unlockFlow.pendingCount} order(s) are not completed yet.</p>
                  <p className="orders-modal-panel__status">
                    <span className="orders-modal-panel__status-label">Status</span>
                    <span>{unlockFlow.statusLine}</span>
                  </p>
                  <p className="orders-modal-panel__hint">Complete/deliver these orders first, then clear the table.</p>
                </>
              ) : null}

              {unlockFlow.type === 'billDue' ? (
                <>
                  <p className="orders-modal-panel__lead">
                    Table <strong>{unlockFlow.table}</strong> has unpaid bill.
                  </p>
                  <p className="orders-modal-panel__status orders-modal-panel__status--confirm">
                    <span className="orders-modal-panel__status-label orders-modal-panel__status-label--confirm">Due</span>
                    <strong>₹{Number(unlockFlow.amount || 0).toFixed(2)}</strong>
                    <span className="muted">from {unlockFlow.orderCount} order(s)</span>
                  </p>
                  <p className="orders-modal-panel__hint">
                    Choose one action: mark bill paid (collect money) or cancel these orders.
                  </p>
                </>
              ) : null}
            </div>
            <div className="orders-modal-panel__footer orders-modal-panel__footer--confirm">
              <button type="button" className="btn btn--ghost" onClick={closeUnlockFlow} disabled={freeTableBusy}>
                Close
              </button>

              {unlockFlow.type === 'confirm' ? (
                <button type="button" className="btn btn--primary" onClick={doUnlockConfirmed} disabled={freeTableBusy}>
                  {freeTableBusy ? 'Saving…' : 'Yes, unlock table'}
                </button>
              ) : null}

              {unlockFlow.type === 'pending' ? (
                <button type="button" className="btn btn--primary" onClick={closeUnlockFlow}>
                  OK
                </button>
              ) : null}

              {unlockFlow.type === 'billDue' ? (
                <>
                  <button type="button" className="btn btn--danger" onClick={doCancelOrdersAndUnlock} disabled={freeTableBusy}>
                    {freeTableBusy ? 'Saving…' : 'Order cancelled'}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={doBillPaidAndUnlock} disabled={freeTableBusy}>
                    {freeTableBusy ? 'Saving…' : 'Bill paid'}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {section === 'tables' ? <TablesBoard /> : null}
      {section === 'menus' ? <MenusBoard /> : null}
    </div>
  );
}

