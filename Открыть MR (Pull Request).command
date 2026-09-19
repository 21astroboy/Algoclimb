#!/bin/bash
# Пуш ветки на GitHub + открытие Pull Request (MR) на вас. Двойной клик по файлу.
# Ветка feature/fastapi-backend → база main. PR назначается на вас (@me).
# Приватный банк (task-bank.json / explanations.json) и data/ в репозиторий НЕ попадают (.gitignore).
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════"
echo "   AlgoClimb → Pull Request (MR)"
echo "════════════════════════════════════"

REPO_URL="https://github.com/21astroboy/Algoclimb"
BASE="main"

# --- проверки окружения ---
if ! command -v git >/dev/null 2>&1; then
  echo "⚠  git не установлен. Выполните в Терминале: xcode-select --install"
  read -n 1 -s -r -p "Клавиша для выхода…"; exit 1
fi

# Текущая ветка (обычно feature/fastapi-backend)
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "⚠  Не удалось определить ветку. Переключитесь на рабочую ветку и повторите."
  read -n 1 -s -r -p "Клавиша для выхода…"; exit 1
fi
if [ "$BRANCH" = "$BASE" ]; then
  echo "⚠  Вы на ветке '$BASE'. PR открывают из отдельной ветки, а не из '$BASE'."
  echo "   Создайте ветку:  git switch -c feature/моя-правка"
  read -n 1 -s -r -p "Клавиша для выхода…"; exit 1
fi

echo "Ветка:  $BRANCH"
echo "База:   $BASE"
echo

# --- 1) пуш ветки ---
echo "① Отправляю ветку на GitHub…"
echo "   Если попросит авторизацию — логин GitHub + Personal Access Token (вместо пароля)."
echo
git push -u origin "$BRANCH"
push_code=$?
echo
if [ $push_code -ne 0 ]; then
  echo "⚠  Пуш не удался (код $push_code). Обычно это авторизация."
  echo "   Способ 1: brew install gh && gh auth login  — затем запустите файл снова."
  echo "   Способ 2: токен на https://github.com/settings/tokens (scope: repo) — введите как пароль."
  read -n 1 -s -r -p "Клавиша для выхода…"; exit 1
fi
echo "✅ Ветка отправлена."
echo

# --- 2) открытие Pull Request ---
TITLE="FastAPI-бэкенд + CI/CD (линтеры, pre-commit, GitHub Actions)"
BODY=$(cat <<'MSG'
## Что в этом PR

**Бэкенд** переписан с Node на **FastAPI** (server_py/) с полным паритетом:
WebSocket-игра, SQLite-история сессий, аналитика, экспорт в xlsx, TOTP-защита входа.

**Деплой одной командой** на VPS: Docker + docker-compose (том ./data для БД),
скрипт-обёртка `algoclimb` (up/down/logs/key), `.env.example`, README-DEPLOY.md.

**CI/CD (линтеры как в бигтехе):**
- Python — Ruff (линтер+форматтер) и mypy (pyproject.toml)
- Frontend — ESLint (@html-eslint) + Prettier (public/*.html)
- pre-commit хуки: ruff, ruff-format, mypy, prettier, eslint, гигиена файлов
- GitHub Actions (.github/workflows/ci.yml): python (ruff/mypy/smoke) · frontend (eslint/prettier) · docker build
- Дымовой тест server_py/smoke_test.py работает без приватного банка (фолбэк на example)

Приватный банк (task-bank.json / explanations.json) и data/ остаются в .gitignore.

## Проверки
Локально всё зелёное: ruff check ✓, ruff format ✓, mypy ✓, smoke ✓, eslint ✓, prettier ✓, e2e 25/25 ✓.
MSG
)

if command -v gh >/dev/null 2>&1; then
  echo "② Открываю Pull Request через gh…"
  # Проверим авторизацию gh
  if ! gh auth status >/dev/null 2>&1; then
    echo "   gh не авторизован. Выполняю вход:"
    gh auth login
  fi
  # Если PR уже есть — просто откроем его в браузере
  if gh pr view "$BRANCH" >/dev/null 2>&1; then
    echo "   PR для '$BRANCH' уже существует — открываю в браузере."
    gh pr view "$BRANCH" --web
  else
    gh pr create \
      --base "$BASE" --head "$BRANCH" \
      --title "$TITLE" --body "$BODY" \
      --assignee @me \
      && echo "✅ PR создан и назначен на вас." \
      && gh pr view "$BRANCH" --web
    pr_code=$?
    if [ $pr_code -ne 0 ]; then
      echo "⚠  gh не смог создать PR. Откройте вручную (ссылка ниже)."
      COMPARE="$REPO_URL/compare/$BASE...$BRANCH?expand=1"
      echo "   $COMPARE"
      command -v open >/dev/null 2>&1 && open "$COMPARE"
    fi
  fi
else
  echo "② gh CLI не установлен — открываю страницу создания PR в браузере."
  echo "   (Для автосоздания и назначения на вас поставьте: brew install gh && gh auth login)"
  COMPARE="$REPO_URL/compare/$BASE...$BRANCH?expand=1"
  echo "   $COMPARE"
  command -v open >/dev/null 2>&1 && open "$COMPARE"
  echo
  echo "   На открывшейся странице: заполните заголовок/описание, справа в 'Assignees' выберите себя, затем 'Create pull request'."
fi

echo
read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть…"
