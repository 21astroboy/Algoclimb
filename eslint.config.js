// Плоская конфигурация ESLint (v9) для фронтенда AlgoClimb.
// Линтим HTML-страницы в frontend/ (структуру и встроенные <script>-скрипты).

const html = require('@html-eslint/eslint-plugin');
const htmlParser = require('@html-eslint/parser');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'backend/**',
      'frontend/vendor/**',
    ],
  },
  {
    files: ['frontend/**/*.html'],
    plugins: { '@html-eslint': html },
    language: '@html-eslint/html',
    languageOptions: { parser: htmlParser },
    rules: {
      // Реальные баги вёрстки, а не стиль (стилем занимается Prettier).
      '@html-eslint/no-duplicate-id': 'error',
      '@html-eslint/no-duplicate-attrs': 'error',
      '@html-eslint/no-obsolete-tags': 'error',
      '@html-eslint/require-doctype': 'error',
      '@html-eslint/no-multiple-h1': 'error',
      '@html-eslint/require-img-alt': 'warn',
    },
  },
];
