// See: https://eslint.org/docs/latest/use/configure/configuration-files

import js from '@eslint/js'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier'
import jest from 'eslint-plugin-jest'
import prettier from 'eslint-plugin-prettier'
import globals from 'globals'

export default [
  {
    ignores: ['**/coverage', '**/dist', '**/node_modules']
  },
  js.configs.recommended,
  ...typescriptEslint.configs['flat/recommended'],
  jest.configs['flat/recommended'],
  prettierConfig,
  {
    plugins: {
      prettier
    },

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest
      },

      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',

      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '__tests__/*.ts',
            'eslint.config.mjs',
            'jest.config.js',
            'rollup.config.ts',
            'script/*.mjs'
          ]
        },
        tsconfigRootDir: import.meta.dirname
      }
    },

    rules: {
      'prettier/prettier': 'error',
      'no-unused-vars': 'off',
      // Deliberately unused bindings are marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
]
