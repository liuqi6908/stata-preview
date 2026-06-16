import antfu from '@antfu/eslint-config'

export default antfu(
  {
    rules: {
      'no-console': 'off',
      'nonblock-statement-body-position': ['error', 'below'],
    },
  },
  {
    files: ['l10n/*.json'],
    rules: {
      'style/eol-last': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'test/no-import-node-test': 'off',
    },
  },
  {
    files: ['media/**/*.js'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'prefer-const': 'off',
      'unused-imports/no-unused-vars': 'off',
    },
  },
)
