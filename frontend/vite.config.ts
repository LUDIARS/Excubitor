import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { config, resolveAllowedHosts } from './config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: config.port,
    strictPort: true,
    host: true,
    allowedHosts: resolveAllowedHosts(),
    proxy: {
      '/api': config.backendUrl,
    },
  },
});
