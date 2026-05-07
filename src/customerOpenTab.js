/** Unpaid tab logic for the guest app (mirrors admin open-tab rules). */

export function isRejectedStatus(status) {
  return String(status || '').toLowerCase() === 'rejected';
}

export function isUnbilledOrder(o) {
  return o?.billingStatus !== 'billed';
}

export function orderCountsOnOpenTab(o) {
  if (!o || isRejectedStatus(o.status)) return false;
  return isUnbilledOrder(o);
}

/** Sum of `total` for this table’s orders that still count toward the cheque (not billed, not rejected). */
export function openTabTotalForTable(orders, tableNum) {
  const t = Number(tableNum);
  if (!Number.isFinite(t)) return 0;
  return orders
    .filter((o) => Number(o.table) === t && orderCountsOnOpenTab(o))
    .reduce((sum, o) => sum + Number(o.total || 0), 0);
}
