import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  deleteField,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { menuItemFromFirestore } from './menuNormalize.js';
import { uploadMenuImage } from './uploadMenuImage.js';

/** Clearer copy when Console rules are stricter than this repo’s `firestore.rules`. */
function firestoreErrMessage(err, fallback) {
  const code = err?.code;
  const msg = String(err?.message || '');
  if (code === 'permission-denied' || msg.includes('Missing or insufficient permissions')) {
    return 'Firestore permission denied. In Firebase Console → Firestore → Rules, paste `firestore.rules` from this project folder and click Publish (same project as `admin/.env.local`). Or run: firebase deploy --only firestore:rules';
  }
  return msg || fallback;
}

function categorySortKey(cat) {
  const c = String(cat || '').trim();
  return c === '' ? '\uffff' : c;
}

function sortMenuRows(list) {
  return [...list].sort((a, b) => {
    const c = categorySortKey(a.category).localeCompare(categorySortKey(b.category), undefined, {
      sensitivity: 'base',
    });
    if (c !== 0) return c;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function categoryKey(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalCategoryName(items, inputCategory, ignoreId = null) {
  const raw = String(inputCategory || '').trim();
  if (!raw) return '';
  const key = categoryKey(raw);
  const hit = items.find((it) => it.id !== ignoreId && categoryKey(it.category) === key);
  return hit?.category?.trim() || raw;
}

function buildPayload(row, isCreate) {
  const name = row.name.trim();
  const category = (row.category || '').trim();
  const description = (row.description || '').trim();
  const price = typeof row.price === 'number' ? row.price : Number(row.price) || 0;
  const plRaw = row.priceLarge;
  const pl = typeof plRaw === 'number' ? plRaw : Number(plRaw);
  const img = (row.imageUrl || '').trim();

  const payload = {
    name,
    category,
    description,
    price,
    available: row.available === true,
  };

  if (Number.isFinite(pl) && pl > 0) {
    payload.priceLarge = pl;
  } else if (!isCreate) {
    payload.priceLarge = deleteField();
  }

  if (img) {
    payload.imageUrl = img;
  } else if (!isCreate) {
    payload.imageUrl = deleteField();
  }

  return payload;
}

function formatPriceLine(row) {
  const p = Number(row.price) || 0;
  const l = row.priceLarge != null && row.priceLarge > 0 ? Number(row.priceLarge) : null;
  if (l != null) return `₹${p} (M) · ₹${l} (L)`;
  return `₹${p % 1 === 0 ? p : p.toFixed(2)}`;
}

function cloneRow(r) {
  return {
    ...r,
    category: r.category ?? '',
    name: r.name ?? '',
    description: r.description ?? '',
    imageUrl: r.imageUrl ?? '',
    price: typeof r.price === 'number' ? r.price : Number(r.price) || 0,
    priceLarge: r.priceLarge == null || r.priceLarge === '' ? null : Number(r.priceLarge),
    available: r.available === true,
  };
}

/**
 * Food list + optional image (paste URL or upload file to Firebase Storage).
 * Compact list with an Edit button per row; add form behind “Add product”.
 */
export default function MenusBoard() {
  const [items, setItems] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [actionSuccess, setActionSuccess] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedEditId, setExpandedEditId] = useState(null);
  const [editSnapshot, setEditSnapshot] = useState(null);
  const [newCategoryMode, setNewCategoryMode] = useState('existing'); // existing | new
  const [newCategoryExisting, setNewCategoryExisting] = useState('');
  const [newCategoryNew, setNewCategoryNew] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newPriceLarge, setNewPriceLarge] = useState('');
  const [newImageFile, setNewImageFile] = useState(null);
  const [addErrors, setAddErrors] = useState({});

  const existingCategories = useMemo(
    () =>
      [...new Set(items.map((it) => String(it.category || '').trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    [items],
  );
  const editingRow = useMemo(() => items.find((r) => r.id === expandedEditId) || null, [items, expandedEditId]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'menus'),
      (snap) => {
        setLoadError(null);
        const list = [];
        snap.forEach((d) => list.push(menuItemFromFirestore(d)));
        setItems(sortMenuRows(list));
      },
      (err) => {
        setLoadError(firestoreErrMessage(err, 'Could not load menu'));
        setItems([]);
      },
    );
    return () => unsub();
  }, []);

  const patchLocal = (id, patch) => {
    setItems((prev) => sortMenuRows(prev.map((r) => (r.id === id ? { ...r, ...patch } : r))));
  };

  useEffect(() => {
    if (!actionSuccess) return undefined;
    const t = window.setTimeout(() => setActionSuccess(null), 3000);
    return () => window.clearTimeout(t);
  }, [actionSuccess]);

  const addDish = async (e) => {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);
    setAddErrors({});
    const name = newName.trim();
    const categoryInput = newCategoryMode === 'new' ? newCategoryNew : newCategoryExisting;
    const category = canonicalCategoryName(items, categoryInput);
    const price = Number(newPrice);
    const priceLarge = newPriceLarge === '' ? null : Number(newPriceLarge);
    const nextErrors = {};
    if (!category) nextErrors.category = 'Category is required.';
    if (!name) nextErrors.name = 'Dish name is required.';
    if (!Number.isFinite(price) || price <= 0) nextErrors.price = 'Enter a valid amount.';
    if (newPriceLarge !== '' && (!Number.isFinite(priceLarge) || priceLarge <= 0)) {
      nextErrors.priceLarge = 'Large amount must be a valid positive number.';
    }
    if (!newImageFile) nextErrors.imageFile = 'Dish image is required.';
    if (Object.keys(nextErrors).length > 0) {
      setAddErrors(nextErrors);
      setActionError('Please fill all required fields.');
      return;
    }
    const row = {
      name,
      category,
      description: newDesc.trim(),
      price,
      priceLarge,
      imageUrl: '',
      available: true,
    };
    setBusyId('__new__');
    try {
      const payload = buildPayload(row, true);
      const docRef = await addDoc(collection(db, 'menus'), payload);
      const imageFile = newImageFile;
      setNewCategoryExisting(existingCategories[0] || '');
      setNewCategoryNew('');
      setNewName('');
      setNewDesc('');
      setNewPrice('');
      setNewPriceLarge('');
      setNewImageFile(null);
      setAddErrors({});
      setShowAddForm(false);
      setBusyId(null);
      if (imageFile) {
        void (async () => {
          try {
            const url = await uploadMenuImage(docRef.id, imageFile);
            await updateDoc(docRef, { imageUrl: url });
            setActionSuccess('Dish added and image uploaded successfully.');
          } catch (err) {
            setActionError(firestoreErrMessage(err, 'Dish added, but image upload failed. Please edit and upload again.'));
          }
        })();
      }
      return;
    } catch (err) {
      setActionError(firestoreErrMessage(err, 'Could not add dish'));
    } finally {
      setBusyId(null);
    }
  };

  const openEditForRow = useCallback((row) => {
    if (expandedEditId && expandedEditId !== row.id && editSnapshot) {
      setItems((prev) =>
        sortMenuRows(prev.map((r) => (r.id === expandedEditId ? { ...editSnapshot } : r))),
      );
    }
    setEditSnapshot(cloneRow(row));
    setExpandedEditId(row.id);
  }, [expandedEditId, editSnapshot]);

  const cancelEdit = () => {
    if (expandedEditId == null) return;
    if (editSnapshot && editSnapshot.id === expandedEditId) {
      setItems((prev) =>
        sortMenuRows(prev.map((r) => (r.id === expandedEditId ? { ...editSnapshot } : r))),
      );
    }
    setExpandedEditId(null);
    setEditSnapshot(null);
  };

  const saveRow = async (row) => {
    setActionError(null);
    setActionSuccess(null);
    if (!row.name.trim()) {
      setActionError('Name cannot be empty.');
      return;
    }
    const nextRow = { ...row, category: canonicalCategoryName(items, row.category, row.id) };
    patchLocal(row.id, { category: nextRow.category });
    setBusyId(row.id);
    try {
      await updateDoc(doc(db, 'menus', row.id), buildPayload(nextRow, false));
      setExpandedEditId(null);
      setEditSnapshot(null);
    } catch (err) {
      setActionError(firestoreErrMessage(err, 'Could not save'));
    } finally {
      setBusyId(null);
    }
  };

  const removeRow = async (id) => {
    if (!window.confirm('Remove this dish from the menu?')) return;
    setActionError(null);
    setActionSuccess(null);
    setBusyId(id);
    try {
      await deleteDoc(doc(db, 'menus', id));
      setExpandedEditId((cur) => (cur === id ? null : cur));
      setEditSnapshot((snap) => (snap?.id === id ? null : snap));
    } catch (err) {
      setActionError(firestoreErrMessage(err, 'Could not delete'));
    } finally {
      setBusyId(null);
    }
  };

  /** When off, dish stays in admin list but hidden on the public menu (see App.jsx `available` filter). */
  const setRowAvailable = async (row, available) => {
    if (row.available === available) return;
    setActionError(null);
    setActionSuccess(null);
    setBusyId(row.id);
    try {
      await updateDoc(doc(db, 'menus', row.id), { available });
      patchLocal(row.id, { available });
    } catch (err) {
      setActionError(firestoreErrMessage(err, 'Could not update visibility'));
    } finally {
      setBusyId(null);
    }
  };

  const onRowImageFile = async (row, e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setActionError(null);
    setActionSuccess(null);
    setBusyId(row.id);
    try {
      const url = await uploadMenuImage(row.id, file);
      await updateDoc(doc(db, 'menus', row.id), { imageUrl: url });
      patchLocal(row.id, { imageUrl: url });
      setActionSuccess('Image uploaded successfully.');
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('storage/') || msg.includes('Firebase Storage')) {
        setActionError(
          'Image upload failed. Check Firebase Storage Rules and publish `storage.rules`, then try again.',
        );
      } else {
        setActionError(firestoreErrMessage(err, 'Upload failed'));
      }
    } finally {
      setBusyId(null);
    }
  };

  const clearRowImage = async (row) => {
    if (!window.confirm('Remove this image from the dish?')) return;
    setActionError(null);
    setActionSuccess(null);
    setBusyId(row.id);
    try {
      await updateDoc(doc(db, 'menus', row.id), { imageUrl: deleteField() });
      patchLocal(row.id, { imageUrl: '' });
    } catch (err) {
      setActionError(firestoreErrMessage(err, 'Could not clear image'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="menus-board">
      <h2 className="menus-board__title">Food list</h2>
      <p className="menus-board__hint">
        Use <strong>Show</strong> / <strong>Hide</strong> on each row for the public menu. Tap <strong>Edit</strong> to change details.
        Add new products with the button at the bottom. Dish image upload uses Firebase Storage, so deploy{' '}
        <code>storage.rules</code> in Console.
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
      {actionSuccess && (
        <div className="alert alert--success" role="status">
          {actionSuccess}
        </div>
      )}

      <section className="menus-section" aria-labelledby="menus-existing-heading">
        <h3 id="menus-existing-heading" className="menus-section__title">
          Already on menu
        </h3>
        {items.length === 0 && !loadError ? (
          <p className="muted menus-board__empty">No dishes yet. Use “Add product” below.</p>
        ) : (
          <ul className="menus-list">
            {items.map((row) => (
              <li key={row.id} className="menus-row menus-row--compact">
                <div className="menus-row-compact__main">
                  <div className="menus-row__media menus-row__media--inline">
                    {row.imageUrl ? (
                      <img className="menus-thumb menus-thumb--sm" src={row.imageUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="menus-thumb menus-thumb--sm menus-thumb--empty" aria-hidden="true" />
                    )}
                  </div>
                  <div className="menus-row-compact__text">
                    <span className="menus-row-compact__name">{row.name || 'Untitled'}</span>
                    <span className="menus-row-compact__meta">
                      {(row.category || '').trim() || 'Menu'} · {formatPriceLine(row)}
                    </span>
                    <span className={`menus-row-compact__badge ${row.available ? '' : 'menus-row-compact__badge--off'}`}>
                      {row.available ? 'Shown' : 'Hidden'}
                    </span>
                  </div>
                </div>
                <div className="menus-row-compact__actions">
                  <div className="menus-showhide-wrap">
                    <span className="menus-showhide-wrap__label" id={`avail-label-${row.id}`}>
                      {row.available ? 'Show' : 'Hide'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.available}
                      aria-labelledby={`avail-label-${row.id}`}
                      className="menus-avail-switch"
                      disabled={busyId === row.id}
                      onClick={() => setRowAvailable(row, !row.available)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small menus-edit-btn"
                    disabled={busyId === row.id}
                    onClick={() => openEditForRow(row)}
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editingRow ? (
        <div className="menus-edit-overlay" role="dialog" aria-modal="true" aria-labelledby="menus-edit-title">
          <button type="button" className="menus-edit-overlay__backdrop" aria-label="Close" onClick={cancelEdit} />
          <div className="menus-edit-panel">
            <div className="menus-add__head">
              <h3 id="menus-edit-title" className="menus-add__title">
                Edit product
              </h3>
              <button type="button" className="btn btn--ghost btn--small" onClick={cancelEdit} disabled={busyId === editingRow.id}>
                Close
              </button>
            </div>
            <div className="menus-row__media">
              {editingRow.imageUrl ? (
                <img className="menus-thumb" src={editingRow.imageUrl} alt="" loading="lazy" />
              ) : (
                <div className="menus-thumb menus-thumb--empty" aria-hidden="true" />
              )}
            </div>
            <div className="menus-row__grid">
              <input
                className="menus-input"
                placeholder="Category"
                value={editingRow.category}
                onChange={(e) => patchLocal(editingRow.id, { category: e.target.value })}
              />
              <input
                className="menus-input"
                placeholder="Dish name"
                value={editingRow.name}
                onChange={(e) => patchLocal(editingRow.id, { name: e.target.value })}
              />
              <input
                className="menus-input menus-input--full"
                placeholder="Description (optional)"
                value={editingRow.description}
                onChange={(e) => patchLocal(editingRow.id, { description: e.target.value })}
              />
              <div className="menus-row__prices">
                <input
                  className="menus-input"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Price ₹"
                  value={editingRow.price}
                  onChange={(e) => patchLocal(editingRow.id, { price: Number(e.target.value) || 0 })}
                />
                <input
                  className="menus-input"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Large ₹ (opt)"
                  value={editingRow.priceLarge ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    patchLocal(editingRow.id, { priceLarge: v === '' ? null : Number(v) || null });
                  }}
                />
              </div>
              <div className="menus-image-actions">
                <label className="menus-file-label menus-file-label--inline">
                  <span className="btn btn--ghost">Upload photo</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="menus-file-input"
                    disabled={busyId === editingRow.id}
                    onChange={(e) => onRowImageFile(editingRow, e)}
                  />
                </label>
                {editingRow.imageUrl ? (
                  <button type="button" className="btn btn--ghost menus-linkish" onClick={() => clearRowImage(editingRow)}>
                    Remove image
                  </button>
                ) : null}
              </div>
              <label className="menus-check">
                <input
                  type="checkbox"
                  checked={editingRow.available}
                  onChange={(e) => patchLocal(editingRow.id, { available: e.target.checked })}
                />
                <span>Show on public menu</span>
              </label>
            </div>
            <div className="menus-row__actions menus-row__actions--edit">
              <button
                type="button"
                className="btn btn--prep"
                disabled={busyId === editingRow.id}
                onClick={() => saveRow(editingRow)}
              >
                {busyId === editingRow.id ? '…' : 'Save'}
              </button>
              <button type="button" className="btn btn--ghost" disabled={busyId === editingRow.id} onClick={cancelEdit}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--ghost menus-linkish"
                disabled={busyId === editingRow.id}
                onClick={() => removeRow(editingRow.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="menus-add-wrap">
        {!showAddForm ? (
          <button
            type="button"
            className="btn btn--primary menus-add-trigger"
            onClick={() => {
              setAddErrors({});
              setNewCategoryMode(existingCategories.length > 0 ? 'existing' : 'new');
              setNewCategoryExisting(existingCategories[0] || '');
              setNewCategoryNew('');
              setShowAddForm(true);
            }}
          >
            ＋ Add product
          </button>
        ) : (
          <div className="menus-add-overlay" role="dialog" aria-modal="true" aria-labelledby="menus-add-title">
            <button
              type="button"
              className="menus-add-overlay__backdrop"
              aria-label="Close"
              onClick={() => {
                setAddErrors({});
                setNewCategoryMode(existingCategories.length > 0 ? 'existing' : 'new');
                setNewCategoryExisting(existingCategories[0] || '');
                setNewCategoryNew('');
                setShowAddForm(false);
              }}
            />
            <form className="menus-add menus-add--modal" onSubmit={addDish}>
              <div className="menus-add__head">
                <h3 id="menus-add-title" className="menus-add__title">
                  Add new product
                </h3>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setAddErrors({});
                    setNewCategoryMode(existingCategories.length > 0 ? 'existing' : 'new');
                    setNewCategoryExisting(existingCategories[0] || '');
                    setNewCategoryNew('');
                    setShowAddForm(false);
                  }}
                >
                  Close
                </button>
              </div>
              <div className="menus-add__grid menus-add__grid--compact">
                <label className="menus-field">
                  <span className="menus-field__label">Category *</span>
                  {existingCategories.length > 0 ? (
                    <div className="menus-category-picker">
                      <select
                        className={`menus-input ${addErrors.category ? 'menus-input--invalid' : ''}`}
                        value={newCategoryMode}
                        onChange={(e) => setNewCategoryMode(e.target.value)}
                      >
                        <option value="existing">Choose existing</option>
                        <option value="new">Add new category</option>
                      </select>
                      {newCategoryMode === 'existing' ? (
                        <select
                          className={`menus-input ${addErrors.category ? 'menus-input--invalid' : ''}`}
                          value={newCategoryExisting}
                          onChange={(e) => setNewCategoryExisting(e.target.value)}
                        >
                          <option value="">Select category</option>
                          {existingCategories.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={`menus-input ${addErrors.category ? 'menus-input--invalid' : ''}`}
                          placeholder="New category name"
                          value={newCategoryNew}
                          onChange={(e) => setNewCategoryNew(e.target.value)}
                        />
                      )}
                    </div>
                  ) : (
                    <input
                      className={`menus-input ${addErrors.category ? 'menus-input--invalid' : ''}`}
                      placeholder="New category name"
                      value={newCategoryNew}
                      onChange={(e) => setNewCategoryNew(e.target.value)}
                    />
                  )}
                  {addErrors.category ? <span className="menus-field__error">{addErrors.category}</span> : null}
                </label>
                <label className="menus-field">
                  <span className="menus-field__label">Dish name *</span>
                  <input
                    className={`menus-input ${addErrors.name ? 'menus-input--invalid' : ''}`}
                    placeholder="Dish name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  {addErrors.name ? <span className="menus-field__error">{addErrors.name}</span> : null}
                </label>
                <label className="menus-field menus-field--full">
                  <span className="menus-field__label">Description</span>
                  <input
                    className="menus-input menus-input--full"
                    placeholder="Description"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                  />
                </label>
                <div className="menus-add__prices menus-field--full">
                  <label className="menus-field">
                    <span className="menus-field__label">Small/Regular price (₹) *</span>
                    <input
                      className={`menus-input ${addErrors.price ? 'menus-input--invalid' : ''}`}
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Amount"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                    />
                    {addErrors.price ? <span className="menus-field__error">{addErrors.price}</span> : null}
                  </label>
                  <label className="menus-field">
                    <span className="menus-field__label">Large portion price (₹)</span>
                    <input
                      className={`menus-input ${addErrors.priceLarge ? 'menus-input--invalid' : ''}`}
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Large amount (optional)"
                      value={newPriceLarge}
                      onChange={(e) => setNewPriceLarge(e.target.value)}
                    />
                    {addErrors.priceLarge ? <span className="menus-field__error">{addErrors.priceLarge}</span> : null}
                  </label>
                </div>
                <label className="menus-file-label menus-field--full">
                  <span className="btn btn--ghost">Choose photo *</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="menus-file-input"
                    onChange={(e) => setNewImageFile(e.target.files?.[0] || null)}
                  />
                  {newImageFile ? <span className="menus-file-name">{newImageFile.name}</span> : null}
                  {addErrors.imageFile ? <span className="menus-field__error">{addErrors.imageFile}</span> : null}
                </label>
                <button type="submit" className="btn btn--primary menus-add__btn" disabled={busyId === '__new__'}>
                  {busyId === '__new__' ? 'Adding…' : 'Add dish'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
