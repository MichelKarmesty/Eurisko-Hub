import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the backend test suite.
 *
 * NestJS 12 ships as ESM-only, and Nest's dependency injection relies on
 * `emitDecoratorMetadata`. Plain esbuild/oxc (Vitest's default transform) does
 * not emit that metadata, so we compile the tests with SWC, which does — the
 * same recipe NestJS documents for Vitest. The result: tests boot the *real*
 * Nest modules exactly as production does.
 *
 *   npm test                 # everything
 *   npm run test:unit        # business-rule unit test (no DB)
 *   npm run test:integration # backend <-> database integration test
 *   npm run test:api         # HTTP contract / authorization / regression
 */
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each suite opens its own in-memory database; run files one at a time so
    // they stay isolated and the output is easy to read.
    fileParallelism: false,
  },
});
