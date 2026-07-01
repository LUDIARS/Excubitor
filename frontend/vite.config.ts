import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { config } from './config';
import { resolveViteAllowedHosts } from './vite-hosts';

export default defineConfig({
  plugins: [react()],
  server: {
    port: config.port,
    strictPort: true,
    host: true,
    allowedHosts: resolveViteAllowedHosts(),
    proxy: {
      '/api': config.backendUrl,
    },
  },
});
