#!/bin/bash
# Режим отладки: тестируй оба экрана (студент + преподаватель) с этой машины.
# Откроется страница /debug со ссылками. С localhost вход студентом идёт без QR/кода.
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════"
echo "   AlgoClimb — ОТЛАДКА (DEBUG)"
echo "════════════════════════════════════"

if ! command -v python3 >/dev/null 2>&1; then
  echo
  echo "⚠  Python 3 не найден. Установите с https://www.python.org/downloads/ и запустите снова."
  echo
  read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть…"
  exit 1
fi

if [ ! -d .venv ]; then
  echo
  echo "Первый запуск: создаю окружение и ставлю зависимости…"
  python3 -m venv .venv || { echo "Не удалось создать venv."; read -n 1 -s -r -p "Клавиша для выхода…"; exit 1; }
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt || { echo "Не удалось установить зависимости."; read -n 1 -s -r -p "Клавиша для выхода…"; exit 1; }
fi

PORT="${PORT:-3000}"
mkdir -p backend/data/runtime
echo
echo "Debug-режим ВКЛ. Лаунчер откроется в браузере: http://localhost:${PORT}/debug"
echo "Остановить: закройте это окно или Ctrl+C."
echo

( sleep 2; open "http://localhost:${PORT}/debug" >/dev/null 2>&1 ) &

DEBUG=1 PORT="$PORT" .venv/bin/python -m uvicorn main:app --app-dir backend --host 0.0.0.0 --port "$PORT"
