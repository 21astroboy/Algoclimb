#!/bin/bash
# Двойной клик по этому файлу запускает AlgoClimb (FastAPI-бэкенд).
# Экран преподавателя откроется в браузере. Чтобы остановить — закройте окно Терминала.
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════"
echo "   AlgoClimb — запуск"
echo "════════════════════════════════════"

if ! command -v python3 >/dev/null 2>&1; then
  echo
  echo "⚠  Python 3 не найден."
  echo "   Установите Python 3 с https://www.python.org/downloads/ и запустите файл снова."
  echo
  read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть…"
  exit 1
fi

# Первый запуск: виртуальное окружение + зависимости.
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
echo "Сервер запускается. Экран преподавателя откроется в браузере."
echo "Ключ преподавателя будет напечатан ниже."
echo "Остановить: закройте это окно или Ctrl+C."
echo

# Открыть экран преподавателя, когда сервер поднимется.
( sleep 2; open "http://localhost:${PORT}/teacher" >/dev/null 2>&1 ) &

PORT="$PORT" .venv/bin/python -m uvicorn main:app --app-dir backend --host 0.0.0.0 --port "$PORT"
