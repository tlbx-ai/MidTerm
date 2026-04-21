import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import midtermComments from './eslint.comment-rules.mjs';
import prettier from 'eslint-plugin-prettier/recommended';

const tsconfigRootDir = import.meta.dirname;

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/wwwroot/**', '**/*.min.js', '**/*.d.ts', '**/*.test.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  prettier,
  {
    files: ['src/ts/**/*.ts', 'vitest.config.ts'],
    plugins: {
      'midterm-comments': midtermComments,
    },
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.tools.json'],
        tsconfigRootDir,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-check': false,
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description',
          'ts-nocheck': true,
          minimumDescriptionLength: 5,
        },
      ],
      'midterm-comments/require-disable-description': 'error',
      'midterm-comments/no-unlimited-disable': 'error',
      'midterm-comments/disable-enable-pair': 'error',
      'no-console': 'error',
      'prefer-promise-reject-errors': 'error',
    },
  },
  {
    files: ['src/ts/api/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    files: ['src/ts/**/*.ts'],
    ignores: ['src/ts/api/**/*.ts', 'src/ts/api.generated.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api.generated'],
              message: 'Import generated OpenAPI types through src/ts/api/types.ts or API wrappers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ts/**/*.ts'],
    ignores: ['src/ts/api.generated.ts'],
    rules: {
      'complexity': ['error', 15],
      'max-lines': ['error', { max: 1200, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 600, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
    },
  },
  {
    files: ['**/modules/logging/**'],
    rules: {
      'no-console': 'off',
    },
  },
);
