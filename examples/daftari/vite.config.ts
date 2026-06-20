import { defineConfig } from 'vite';

// Plain Vite + TypeScript — no framework, minimal deps. The dev server runs on
// 5180 (out of the way of the rest of the Laetoli stack). The SDK is consumed
// as a normal dependency (@laetoli/data → file:../../client), exactly as a real
// app would consume the published package.
export default defineConfig({
  server: { port: 5180 },
  preview: { port: 5180 },
});
