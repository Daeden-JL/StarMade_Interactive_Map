import { defineConfig } from 'vite';

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
    emptyOutDir: true
  }
});
