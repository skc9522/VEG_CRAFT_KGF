/**
 * Copies `admin/dist` → `public/admin` for Firebase Hosting (single-site + /admin rewrite).
 * Run after `npm run build --prefix admin`.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'admin', 'dist');
const dest = join(root, 'public', 'admin');

if (!existsSync(src)) {
  console.error('Missing admin/dist — run: npm run build --prefix admin');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log('Synced admin/dist → public/admin');
