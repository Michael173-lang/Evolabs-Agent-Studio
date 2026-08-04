import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    cssMinify: 'lightningcss',
    sourcemap: false,
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
