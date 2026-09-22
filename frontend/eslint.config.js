import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      // Bundle-size invariant that used to live in a source-text test: the app
      // must use the lightweight `m` components from `motion/react-m` under the
      // `LazyMotion strict` boundary in main.tsx, never the full `motion`
      // component. `AnimatePresence`, `useIsPresent`, `LazyMotion` and
      // `domAnimation` are legitimate and stay allowed.
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'motion/react',
          importNames: ['motion'],
          message: 'Use `m` from motion/react-m under a LazyMotion boundary, not the full `motion` component.',
        }],
      }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
])
