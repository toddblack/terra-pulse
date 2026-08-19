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
    // Structural half of non-negotiable #1 (Explore never displays
    // significance claims): Explore code cannot import Analyze's directory
    // or its result types, even by accident. See
    // `apps/desktop/src/renderer/src/analyze/explore-purity.test.ts` for the
    // scan that catches what this rule structurally can't (a p-value typed
    // into JSX by hand rather than imported).
    files: [
      'apps/desktop/src/renderer/src/{panels,layers,globe,state}/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/analyze/*', '**/analyze'],
              message: 'Explore code must not import from analyze/ — see non-negotiable #1.',
            },
          ],
          paths: [
            {
              name: '@terra-pulse/schema',
              importNames: [
                'AnalysisResult',
                'AnalysisTestResult',
                'AnalysisRunOutcome',
                'EngineStatus',
                'HypothesisSummary',
                'HypothesisId',
                'CorrectionInfo',
                'NullInfo',
              ],
              message:
                'Analysis result types must not reach Explore code — see non-negotiable #1.',
            },
          ],
        },
      ],
    },
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
