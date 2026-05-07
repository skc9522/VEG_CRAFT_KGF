import { doc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';

const COLLECTION = 'tableLocks';

/** @param {import('firebase/firestore').Firestore} db */
export function tableLockDocRef(db, tableNumber) {
  return doc(db, COLLECTION, String(tableNumber));
}

/**
 * Claim exclusive use of a table for this browser session, or confirm we already hold it.
 * @returns {Promise<{ claimed: boolean }>}
 */
export async function tryClaimTableLock(db, tableNumber, sessionId) {
  const ref = tableLockDocRef(db, tableNumber);
  return runTransaction(db, async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists()) {
      transaction.set(ref, {
        occupantSessionId: sessionId,
        released: false,
        updatedAt: serverTimestamp(),
      });
      return { claimed: true };
    }
    const d = snap.data();
    const occ = d?.occupantSessionId;
    const released = d?.released === true;
    if (released || occ == null || occ === '') {
      transaction.update(ref, {
        occupantSessionId: sessionId,
        released: false,
        updatedAt: serverTimestamp(),
      });
      return { claimed: true };
    }
    if (occ === sessionId) {
      return { claimed: true };
    }
    return { claimed: false };
  });
}

/**
 * @param {import('firebase/firestore').DocumentSnapshot} snap
 * @param {string} sessionId
 * @returns {{ mode: 'blocked' } | { mode: 'free' } | { mode: 'ours' }}
 */
export function tableLockSnapshotMode(snap, sessionId) {
  if (!snap.exists()) return { mode: 'free' };
  const d = snap.data();
  const occ = d?.occupantSessionId;
  const released = d?.released === true;
  if (released || occ == null || occ === '') return { mode: 'free' };
  if (occ === sessionId) return { mode: 'ours' };
  return { mode: 'blocked' };
}

/** Staff: mark table free after bill is paid (or to clear a stuck lock). */
export async function releaseTableLock(db, tableNumber) {
  await setDoc(
    tableLockDocRef(db, tableNumber),
    {
      released: true,
      occupantSessionId: null,
      releasedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
