/**
 * STEP 4 (explicit): after `vite build`, copy `public/admin` → `dist/admin`.
 * Vite already copies `public/` into `dist/` during the build; this run is a
 * safety net so `dist/admin` always matches `public/admin` before deploy.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public', 'admin');
const dest = join(root, 'dist', 'admin');

if (!existsSync(join(root, 'dist'))) {
  console.warn('[ensure-admin-in-dist] No dist/ folder — run vite build first.');
  process.exit(0);
}

if (!existsSync(src)) {
  console.warn('[ensure-admin-in-dist] No public/admin — skip (run: npm run build:firebase or sync:admin after admin build).');
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log('[ensure-admin-in-dist] public/admin → dist/admin');
