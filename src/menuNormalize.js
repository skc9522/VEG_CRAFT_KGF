/** Normalize one Firestore `menus` document for the customer app. */
export function menuItemFromFirestore(docSnap) {
  const data = docSnap.data();
  const rawLarge = data.priceLarge;
  let priceLarge = null;
  if (typeof rawLarge === 'number' && rawLarge > 0) priceLarge = rawLarge;
  else if (rawLarge != null && Number(rawLarge) > 0) priceLarge = Number(rawLarge);

  return {
    id: docSnap.id,
    name: data.name ?? '',
    price: typeof data.price === 'number' ? data.price : Number(data.price) || 0,
    priceLarge,
    category: String(data.category ?? '').trim(),
    description: String(data.description ?? '').trim(),
    imageUrl: String(data.imageUrl ?? '').trim(),
    available: data.available === true,
  };
}
