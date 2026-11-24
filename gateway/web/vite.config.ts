import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by the gateway under /gw/assets/ (see server.js); relative base keeps `vite dev` working too.
export default defineConfig({
  base: '/gw/assets/',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: '.', emptyOutDir: true },
});
