/**
 * Firestore client — config comes from `.env.local` (see `.env.example`).
 * Vite only exposes env vars that start with VITE_.
 */
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const measurementId = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? '';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
  ...(measurementId ? { measurementId } : {}),
};

if (import.meta.env.DEV && !firebaseConfig.projectId) {
  console.warn(
    '[VEG CRAFT] Firebase: add root `.env.local` with VITE_FIREBASE_* (copy from `.env.example`). See SETUP_FIREBASE.txt',
  );
}

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
