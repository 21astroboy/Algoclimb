#!/bin/bash
# Двойной клик по этому файлу запускает AlgoClimb.
# Экран преподавателя откроется в браузере. Чтобы остановить — закройте окно Терминала.
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════"
echo "   AlgoClimb — запуск"
echo "════════════════════════════════════"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "⚠  Node.js не найден."
  echo "   Установите LTS-версию с https://nodejs.org и запустите файл снова."
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
echo "Сервер запускается. Экран преподавателя откроется в браузере."
echo "Ключ преподавателя будет напечатан ниже."
echo "Остановить: закройте это окно или Ctrl+C."
echo

# Открыть экран преподавателя, когда сервер поднимется.
( sleep 2; open "http://localhost:${PORT}/teacher" >/dev/null 2>&1 ) &

node server.js
