import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: { outDir: 'public', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/runtime': 'http://127.0.0.1:4000',
      '/health': 'http://127.0.0.1:4000',
      '/workshop': 'http://127.0.0.1:4000',
    },
  },
});
