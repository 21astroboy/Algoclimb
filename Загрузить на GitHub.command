#!/bin/bash
# Загрузка AlgoClimb на GitHub. Двойной клик по этому файлу.
# Приватный банк вопросов/ответов (task-bank.js, explanations.js, verify_tasks.js)
# и папка data/ в репозиторий НЕ попадают — они в .gitignore.
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════"
echo "   AlgoClimb → GitHub"
echo "════════════════════════════════════"
REPO="https://github.com/21astroboy/Algoclimb.git"

if ! command -v git >/dev/null 2>&1; then
  echo "⚠  git не установлен. Выполните в Терминале: xcode-select --install"
  read -n 1 -s -r -p "Клавиша для выхода…"; exit 1
fi

[ -d .git ] || git init -q

# На случай повторного запуска — убрать приватные файлы из индекса, если попали
git rm -r --cached --quiet task-bank.js explanations.js verify_tasks.js data node_modules >/dev/null 2>&1

# Идентификация автора (только если ещё не настроена)
git config user.name  >/dev/null 2>&1 || git config user.name  "21astroboy"
git config user.email >/dev/null 2>&1 || git config user.email "leyurus21@gmail.com"

git add -A
echo
echo "Файлы, которые будут отправлены:"
git diff --cached --name-only | sed 's/^/   /'
echo
git commit -q -m "AlgoClimb: движок игры (банк вопросов и ответов исключён из репозитория)" \
  && echo "Коммит создан." || echo "(нечего коммитить — возможно, уже закоммичено)"

git branch -M main
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$REPO"; else git remote add origin "$REPO"; fi

echo
echo "Отправляю на GitHub…"
echo "Если попросит авторизацию — введите логин GitHub и Personal Access Token (вместо пароля)."
echo
git push -u origin main
code=$?
echo
if [ $code -eq 0 ]; then
  echo "✅ Готово! Репозиторий: https://github.com/21astroboy/Algoclimb"
  echo "   Проверьте: task-bank.js / explanations.js там быть НЕ должно."
else
  echo "⚠  Не удалось отправить (код $code). Обычно это авторизация."
  echo "   Способ 1: brew install gh && gh auth login  — затем запустите этот файл снова."
  echo "   Способ 2: создайте токен на https://github.com/settings/tokens (scope: repo)"
  echo "            и введите его как пароль, когда git спросит."
fi
echo
read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть…"
