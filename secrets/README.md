# secrets/ — приватные файлы (в Git не попадают)

Сюда кладутся файлы, которые НЕ должны лежать в репозитории и НЕ должны
«вшиваться» в Docker-образ:

```
secrets/
  task-bank.json        # банк задач: вопросы + правильные ответы
  explanations.json     # разборы задач (показываются после игры)
```

Содержимое папки игнорируется Git (см. `.gitignore`) — коммитится только этот README.

## Как это работает

`docker-compose.yml` монтирует эту папку внутрь контейнера как `/app/secrets`
(только чтение) и передаёт пути через переменные окружения:

```
TASK_BANK_PATH=/app/secrets/task-bank.json
EXPLANATIONS_PATH=/app/secrets/explanations.json
```

Бэкенд (`backend/bank.py`, `backend/main.py`) сначала смотрит на эти переменные,
поэтому банк берётся из смонтированной папки, а не из образа. Если файлов здесь
нет — приложение откатывается на `backend/data/task-bank.example.json` (демо-банк).

## Деплой на VPS

```bash
# с рабочей машины — подложить приватные файлы в secrets/ на сервере
scp secrets/task-bank.json secrets/explanations.json <user>@<vps>:~/algoclimb/secrets/
```

Затем на сервере: `./algoclimb up` (или `up`/`restart`). Образ пересобирать
не нужно — файлы монтируются на лету.

## Локальный запуск без Docker

Двойной клик по «Запустить AlgoClimb.command» и `./algoclimb` в локальном
Python-режиме читают банк из `backend/data/task-bank.json`. Можно держать файлы
там, либо задать `TASK_BANK_PATH`/`EXPLANATIONS_PATH` в `.env`, указав на `secrets/`.
