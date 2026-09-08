import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API lives in ../backend (NestJS on :3000). In dev we proxy API calls
// through Vite so the app can use relative URLs (no CORS / hardcoded host).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // NestJS routes have no prefix; strip the /api prefix on the way in.
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
