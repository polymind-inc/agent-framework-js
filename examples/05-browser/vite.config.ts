import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        canvas: resolve(import.meta.dirname, 'canvas.html'),
        structured: resolve(import.meta.dirname, 'structured.html'),
        anthropic: resolve(import.meta.dirname, 'anthropic.html'),
      },
    },
  },
});
