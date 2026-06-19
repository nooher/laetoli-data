/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served behind Caddy at /studio/*, so every asset URL is prefixed accordingly.
export default defineConfig({
  base: '/studio/',
  plugins: [react()],
  server: { port: 5180 },
  preview: { port: 5180 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
  },
});
