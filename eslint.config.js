// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  {
    files: ['src/**/*.ts'],

    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],

    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },

    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],

      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/prefer-optional-chain': 'warn',
    },
  },

  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],

    plugins: {
      vitest,
    },

    rules: {
      ...vitest.configs.recommended.rules,

      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      '@typescript-eslint/no-floating-promises': 'error',

      // Replace with vitest-aware version that understands vi.fn() mocks
      '@typescript-eslint/unbound-method': 'off',
      'vitest/unbound-method': 'error',
    },
  },

  prettierConfig,
);
