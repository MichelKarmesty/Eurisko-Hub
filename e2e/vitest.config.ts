import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // The app lives under ../frontend and would resolve its own React copy;
    // force every import (app + harness) onto the single copy installed here
    // so React hooks/DOM agree (one React per tree).
    alias: {
      react: path.resolve(import.meta.dirname, 'node_modules/react'),
      'react-dom': path.resolve(import.meta.dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(import.meta.dirname, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(import.meta.dirname, 'node_modules/react/jsx-dev-runtime'),
      'react-dom/client': path.resolve(import.meta.dirname, 'node_modules/react-dom/client'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['dom/**/*.test.tsx'],
    globalSetup: ['global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    restoreMocks: true,
  },
});
