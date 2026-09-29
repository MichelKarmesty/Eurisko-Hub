import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API lives in ../backend (NestJS on :3000). In dev we proxy API calls
// through Vite so the app can use relative URLs (no CORS / hardcoded host).
// API_PROXY_TARGET lets the automated browser E2E run against an isolated
// backend on a different port (see scripts/run-browser-e2e.mjs).
//
// DEV_HOST is opt-in and exists for one purpose: letting another PC on the same
// network open the app (`LAN=1 npm run dev` sets it to 0.0.0.0; see
// scripts/dev.mjs). It does two things:
//
//   1. binds the dev server to that address instead of localhost;
//   2. allows *hostname* Host headers. Vite's DNS-rebinding protection accepts
//      `localhost` and plain IP literals by default, so `http://172.24.26.42:5173`
//      already works with `--host` alone - but reaching the app by machine name
//      (`http://my-pc:5173`, the usual way on a home or Windows network) answers
//      `Blocked request` without this.
//
// Unset - the normal case - the dev server stays on localhost only, and the
// hostname protection stays on. Allowing any host is acceptable here only
// because the mode is explicit and meant for short-lived dev sharing.
const devHost = process.env.DEV_HOST?.trim();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    ...(devHost ? { host: devHost, allowedHosts: true } : {}),
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        // NestJS routes have no prefix; strip the /api prefix on the way in.
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
