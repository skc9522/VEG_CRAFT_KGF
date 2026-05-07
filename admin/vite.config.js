import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * MUST be `/admin/` so built assets load as `/admin/assets/...` on Firebase Hosting.
 * Local dev: open http://localhost:5174/admin/ (not the site root).
 */
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    port: 5174,
    /** If 5174 is already taken (e.g. another admin tab), use the next free port — watch the terminal URL. */
    strictPort: false,
    open: '/admin/',
  },
});
