import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  {
    ignores: ['**/dist/**', '**/dist-electron/**', '**/out/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      // Asserting on a mock (`expect(viewer.dataSources.add)`) necessarily
      // references the method unbound — that IS the assertion, not an
      // accidental loss of `this`. The rule has no way to tell the two apart,
      // so it only produces false positives in test files.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
]);
