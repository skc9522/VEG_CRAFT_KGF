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

/** Kitchen / queue terminal (not rejected — rejected has its own tab). */
export function isKitchenTerminalStatus(status) {
  const s = String(status || '').toLowerCase();
  return ['completed', 'delivered', 'closed', 'cancelled', 'canceled'].includes(s);
}

export function isRejectedStatus(status) {
  return String(status || '').toLowerCase() === 'rejected';
}

/** Bill not yet collected at counter. */
export function isUnbilledOrder(o) {
  return o?.billingStatus !== 'billed';
}

/** Lines that still count on the guest’s open tab (before “Bill paid”). */
export function orderCountsOnOpenTab(o) {
  if (!o || isRejectedStatus(o.status)) return false;
  return isUnbilledOrder(o);
}

export function openTabTotalForTable(orders, tableNum) {
  const t = Number(tableNum);
  if (!Number.isFinite(t)) return 0;
  return orders
    .filter((o) => Number(o.table) === t && orderCountsOnOpenTab(o))
    .reduce((sum, o) => sum + Number(o.total || 0), 0);
}

export function partitionOrdersForAdmin(orders) {
  const rejected = orders.filter((o) => isRejectedStatus(o.status));
  const nonRej = orders.filter((o) => !isRejectedStatus(o.status));
  const active = nonRej.filter((o) => !isKitchenTerminalStatus(o.status));
  const past = nonRej.filter((o) => isKitchenTerminalStatus(o.status));
  const byCreated = (a, b) => timeMs(a.createdAt) - timeMs(b.createdAt);
  active.sort(byCreated);
  rejected.sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt));
  past.sort((a, b) => {
    const ta = timeMs(a.completedAt) || timeMs(a.createdAt);
    const tb = timeMs(b.completedAt) || timeMs(b.createdAt);
    return ta - tb;
  });
  return { active, past, rejected };
}
