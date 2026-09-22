import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'coverage/**', 'src/compression/bzip2/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // This library is bit-twiddling from top to bottom; a blanket no-bitwise
      // ban would be suppressed in every file. The 2018 source carried three
      // `// tslint:disable:no-bitwise` comments for exactly this reason.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-extra-semi': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
