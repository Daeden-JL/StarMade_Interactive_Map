import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8888',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:8888',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: '../src/main/resources/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Main galaxy map and the standalone block-orientation debug page.
        main: resolve(root, 'index.html'),
        debug: resolve(root, 'debug.html')
      }
    }
  }
});
