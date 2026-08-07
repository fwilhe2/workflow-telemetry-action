import github from 'eslint-plugin-github'
import tseslint from 'typescript-eslint'

const {recommended: githubRecommended, typescript: githubTypescript} =
  github.getFlatConfigs()

export default tseslint.config(
  {
    ignores: ['dist/', 'lib/', 'node_modules/']
  },
  githubRecommended,
  githubTypescript,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      'i18n-text/no-en': 'off',
      'eslint-comments/no-use': 'off',
      'import/no-namespace': 'off',
      'no-unused-vars': 'off',
      // Renamed from `filenames/match-regex` in eslint-plugin-github v6.
      'github/filenames-match-regex': 'off',
      // TypeScript already resolves (and type-checks) these imports; the
      // import plugin's resolver cannot follow "exports"-only ESM packages.
      'import/no-unresolved': 'off',
      camelcase: 'off',
      // Unused params are kept where a signature is shared across the
      // stepTracer/statCollector/processTracer modules; mark them with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}
      ],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {accessibility: 'no-public'}
      ],
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {allowExpressions: true}
      ],
      '@typescript-eslint/no-array-constructor': 'error',
      // Pre-existing debt, surfaced when `npm run lint` was fixed to actually
      // walk src/ (the old `src/**/*.ts` glob only ever matched
      // src/interfaces/). Kept as warnings so they stay visible without
      // gating the build on a refactor of otherwise working code.
      '@typescript-eslint/no-explicit-any': 'warn',
      'github/no-then': 'warn',
      'github/array-foreach': 'warn',
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/prefer-for-of': 'warn',
      '@typescript-eslint/prefer-function-type': 'warn',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/unbound-method': 'error'
    }
  }
)
