# AlgoClimb — образ для запуска без установки Node на хосте.
# Node 22 нужен для встроенного node:sqlite (без нативной сборки).
FROM node:22-alpine

WORKDIR /app

# Сначала только манифесты — чтобы слой с npm install кешировался.
COPY package.json ./
RUN npm install --omit=dev

# Затем код приложения.
COPY . .

# data/ — том для базы (SQLite/JSONL), чтобы посещаемость и результаты переживали перезапуск.
VOLUME ["/app/data"]

EXPOSE 3000

# Флаг включает встроенный node:sqlite в Node 22 (иначе db.js падает на JSONL).
CMD ["node", "--experimental-sqlite", "server.js"]
