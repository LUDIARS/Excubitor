import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Separate entry points: Viewer shell and read-only Monitor, never the management App.
export default defineConfig({
  root: fileURLToPath(new URL('dmz', import.meta.url)),
  publicDir: fileURLToPath(new URL('public', import.meta.url)),
  plugins: [react()],
  resolve: { alias: { '/src': fileURLToPath(new URL('src', import.meta.url)) } },
  build: { outDir: '../dist-dmz', emptyOutDir: true,
    rollupOptions: { input: {
      viewer: fileURLToPath(new URL('dmz/index.html', import.meta.url)),
      monitor: fileURLToPath(new URL('dmz/monitor.html', import.meta.url)),
    } },
  },
});
