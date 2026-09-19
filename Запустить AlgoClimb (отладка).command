#!/bin/bash
# Режим отладки: тестируй оба экрана (студент + преподаватель) с этой машины.
# Откроется страница /debug со ссылками. С localhost вход студентом идёт без QR/кода.
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════"
echo "   AlgoClimb — ОТЛАДКА (DEBUG)"
echo "════════════════════════════════════"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "⚠  Node.js не найден. Установите LTS с https://nodejs.org и запустите снова."
  echo
  read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "Первый запуск: устанавливаю зависимости (npm install)…"
  npm install || { echo "Не удалось установить зависимости."; read -n 1 -s -r -p "Клавиша для выхода…"; exit 1; }
fi

PORT="${PORT:-3000}"
echo
echo "Debug-режим ВКЛ. Лаунчер откроется в браузере: http://localhost:${PORT}/debug"
echo "Остановить: закройте это окно или Ctrl+C."
echo

( sleep 2; open "http://localhost:${PORT}/debug" >/dev/null 2>&1 ) &

DEBUG=1 node server.js
