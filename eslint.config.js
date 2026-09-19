// Плоская конфигурация ESLint (v9) для фронтенда AlgoClimb.
// Линтим HTML-страницы в public/ (структуру и встроенные <script>-скрипты).
// Легаси Node-бэкенд (server.js и т.п.) заменён на server_py/ и не проверяется.

const html = require('@html-eslint/eslint-plugin');
const htmlParser = require('@html-eslint/parser');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'public/vendor/**',
      'lib/**',
      // легаси Node-бэкенд (заменён на server_py/)
      'server.js',
      'tasks.js',
      'db.js',
      'e2e.js',
      'runtest.js',
      'min.js',
      'verify_tasks.js',
      'explanations.js',
      'task-bank*.js',
    ],
  },
  {
    files: ['public/**/*.html'],
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
