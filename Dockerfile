# AlgoClimb — образ FastAPI-бэкенда (Python). Запускается без установки Python на хосте.
FROM python:3.12-slim

WORKDIR /app

# Сначала только зависимости — чтобы слой с pip install кешировался.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Затем код приложения (task-bank.json / explanations.json копируются, если лежат рядом).
COPY . .

# data/ — том для базы SQLite, чтобы история сессий переживала перезапуск.
VOLUME ["/app/data"]

EXPOSE 3000

# Один воркер обязателен: состояние игры живёт в памяти процесса (asyncio.Lock),
# несколько воркеров рассинхронизировали бы игру.
CMD ["python", "-m", "uvicorn", "main:app", "--app-dir", "server_py", \
     "--host", "0.0.0.0", "--port", "3000"]
