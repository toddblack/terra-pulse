import { defineConfig } from 'vitest/config';

/**
 * Deliberately minimal: the only thing this adds over Vitest's defaults is a
 * setup file supplying browser globals that Cesium references without
 * guarding. Everything else — node environment, module resolution — stays on
 * defaults, which the rest of the suite already relies on.
 *
 * See `test-setup.ts` for why the shim exists.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
  },
});
