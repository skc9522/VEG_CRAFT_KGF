/** Map Firestore `status` from admin app to customer UI buckets. */
export function normalizeKitchenStatus(raw) {
  const s = String(raw ?? 'pending')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
  if (s === 'rejected') return 'rejected';
  if (['preparing', 'in_kitchen', 'cooking', 'picked', 'accepted', 'confirmed'].includes(s)) return 'preparing';
  if (['ready', 'done', 'served', 'completed_for_customer'].includes(s)) return 'ready';
  if (['completed', 'delivered', 'closed', 'cancelled', 'canceled'].includes(s)) return 'idle';
  return 'pending';
}
