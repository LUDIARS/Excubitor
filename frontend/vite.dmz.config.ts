import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// A distinct root and output ensure the DMZ bundle never includes the Monitor app.
export default defineConfig({
  root: fileURLToPath(new URL('dmz', import.meta.url)),
  publicDir: fileURLToPath(new URL('public', import.meta.url)),
  plugins: [react()],
  resolve: { alias: { '/src': fileURLToPath(new URL('src', import.meta.url)) } },
  build: { outDir: '../dist-dmz', emptyOutDir: true },
});
