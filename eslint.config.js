const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
module.exports = tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.local-test/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { files: ['*.js', '*.cjs'], languageOptions: { sourceType: 'commonjs' }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
