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
)
