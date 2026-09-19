# Развёртывание AlgoClimb на VPS

Бэкенд переписан на **FastAPI** (папка `server_py/`). Фронтенд (`public/`) не менялся.
История сессий хранится в SQLite (`data/algoclimb.db`) и переживает перезапуски.

## Что нужно знать про приватные файлы

`task-bank.json` (вопросы + ответы) и `explanations.json` (разборы) **не лежат в Git** —
они в `.gitignore`, чтобы студенты не нашли ответы. При деплое их нужно скопировать
на сервер отдельно. Без них приложение запустится, но с демо-банком из 6 задач.

## Первичная установка (один раз)

На сервере нужен либо **Docker** (рекомендуется), либо **Python 3.11+**.
Скрипт `./algoclimb` сам определит, что доступно.

```bash
# 1. Забрать код на сервер
git clone https://github.com/21astroboy/Algoclimb.git algoclimb
cd algoclimb

# 2. Докинуть приватные файлы с рабочей машины (выполнять со своего ноутбука)
scp task-bank.json explanations.json <user>@<vps>:~/algoclimb/

# 3. Настроить окружение
cp .env.example .env
nano .env          # укажите PUBLIC_URL и, по желанию, TEACHER_KEY
```

Минимум в `.env` — публичный адрес, который попадёт в QR для студентов:

```
PUBLIC_URL=http://<ip-или-домен>:3000
TEACHER_KEY=<свой-постоянный-ключ>
```

## Запуск — одна команда

```bash
./algoclimb up
```

Собирает и стартует приложение в фоне, печатает ключ преподавателя.
История в `./data` сохраняется между перезапусками и пересборками.

Остальные команды:

```bash
./algoclimb logs      # смотреть логи (Ctrl+C — выйти)
./algoclimb key       # показать ключ преподавателя
./algoclimb status    # состояние
./algoclimb restart   # перезапустить
./algoclimb down      # остановить
```

## Экраны

| Кто | Адрес |
|-----|-------|
| Преподаватель | `PUBLIC_URL/teacher` (вход по ключу) |
| Студенты | `PUBLIC_URL/` (QR ведёт сюда) |
| Ключ ответов | `PUBLIC_URL/answers` |

## Обновление версии

```bash
git pull
./algoclimb restart      # Docker пересоберёт образ; данные в ./data не тронутся
```

## HTTPS и домен (по желанию)

Приложение слушает обычный HTTP на `PORT`. Для домена и TLS поставьте перед ним
reverse-proxy (Caddy или nginx), проксируйте на `127.0.0.1:3000` и **обязательно
разрешите WebSocket** (проброс заголовков `Upgrade`/`Connection`). Затем укажите
`PUBLIC_URL=https://ваш-домен` в `.env` и `./algoclimb restart`.

Пример для Caddy (`Caddyfile`) — WebSocket он проксирует автоматически:

```
algoclimb.example.ru {
    reverse_proxy 127.0.0.1:3000
}
```

## Безопасность входа

- `TEACHER_KEY` — ключ учителя; не показывайте студентам.
- `QR_ROTATION=1` включает сменные одноразовые коды входа (TOTP) — код в QR
  меняется каждые `QR_INTERVAL` секунд, повторный вход по старому коду невозможен.
- Ограничение по сети вуза (IP-allowlist) настраивается в `config.json` → `ipAllowlist`.

## Запуск без скрипта

```bash
# Docker
docker compose up -d --build

# или напрямую (Python)
pip install -r requirements.txt
python -m uvicorn main:app --app-dir server_py --host 0.0.0.0 --port 3000
```

> Только один воркер: состояние игры живёт в памяти процесса. Несколько воркеров
> рассинхронизируют игру, поэтому `--workers` использовать нельзя.
