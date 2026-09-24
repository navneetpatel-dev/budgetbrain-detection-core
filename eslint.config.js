import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import regexp from 'eslint-plugin-regexp';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'perf/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Message parsing runs on untrusted text: block super-linear backtracking and other regex hazards.
  regexp.configs['flat/recommended'],
  {
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
