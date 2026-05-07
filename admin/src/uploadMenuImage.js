import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase.js';

const MAX_BYTES = 2 * 1024 * 1024;

/** Upload a dish photo to Storage at `menu_images/{menuId}/...` and return download URL. */
export async function uploadMenuImage(menuId, file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('Please choose an image file (JPG, PNG, WebP, etc.).');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('Image must be under 2 MB.');
  }
  const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const storageRef = ref(storage, `menu_images/${menuId}/${name}`);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}
