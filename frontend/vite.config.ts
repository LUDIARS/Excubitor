import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import { resolveViteAllowedHosts } from './vite-hosts';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
      },
    },
  },
  server: {
    port: config.port,
    strictPort: true,
    host: true,
    allowedHosts: resolveViteAllowedHosts(),
    proxy: {
      '/api': {
        target: config.backendUrl,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            const address = incoming.socket.remoteAddress?.replace(/^::ffff:/, '');
            if (address !== '127.0.0.1' && address !== '::1') {
              outgoing.setHeader('x-forwarded-for', address ?? 'unknown');
            }
          });
        },
      },
    },
  },
});
