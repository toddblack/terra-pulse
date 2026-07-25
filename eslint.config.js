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
]);
