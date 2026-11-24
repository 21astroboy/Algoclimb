# AlgoClimb backlog context

[English](README.md) · [Русский](README.ru.md) · [GitHub Projects board](https://github.com/users/21astroboy/projects/1/views/1)

These documents mirror the expanded Russian descriptions of the 20 existing project draft cards.
They describe problems, current behavior, proposed workflows, examples, outcomes, acceptance criteria,
implementation pointers and dependencies. They are specifications, not implemented-feature claims.
Planning status, priority, size and iteration remain on the board; this documentation update does not change them.
Original acceptance criteria are retained and supplemented. Descriptions were reviewed on 24 November 2026.

## Cards

1. [Подготовка: исключить случайный запуск всего банка](cards/01.md)
2. [Занятие: показать текущий вопрос, таймер и ответы преподавателю](cards/02.md)
3. [Библиотека: редактор личных задач и версии наборов](cards/03.md)
4. [Оценивание: отдельный рейтинг подтверждённо присутствующих](cards/04.md)
5. [Надёжность: диагностика отключений и показатели сессии](cards/05.md)
6. [Эксплуатация: автоматические резервные копии и проверка восстановления](cards/06.md)
7. [Выкатка: защита активных занятий и быстрый откат](cards/07.md)
8. [Посещаемость: полевой пилот геопроверки в аудитории](cards/08.md)
9. [Комнаты: удобные сохраняемые черновики подготовки](cards/09.md)
10. [Сессии: точное повторение по сохранённому снимку](cards/10.md)
11. [Библиотека: свёрнутые фильтры и случайная выборка](cards/11.md)
12. [Аналитика: сравнение занятий и динамика по вопросам](cards/12.md)
13. [Экспорт: ответы по вопросам и XLSX](cards/13.md)
14. [Группы: постоянный список студентов и устойчивые идентификаторы](cards/14.md)
15. [Доступы: список получателей отчёта и срок чтения](cards/15.md)
16. [Разделы: создание и архивирование через Administration](cards/16.md)
17. [Контент: стартовые согласованные наборы для DB и NN](cards/17.md)
18. [Проектор: отдельное живое окно доски подъёма](cards/18.md)
19. [Интерфейс: мобильный кабинет и доступность](cards/19.md)
20. [Обратная связь: удобные заявки и безопасные вложения](cards/20.md)

## Illustrations

The images in `images/` are screenshots of the actual local UI with synthetic students, catalog and report data.
No VPS records, credentials, private question bank or real student names are used. A context banner identifies
what area the card concerns. `operations-proposal.png` is explicitly a proposed workflow diagram, not a screen
that already exists. Screenshots locate a problem; they do not establish that every desired feature is absent.
The draft and mobile/accessibility cards specifically distinguish the improvements already shipped from remaining work.

Reproduce the images after `npm ci` and browser installation:

```bash
node tools/capture_backlog.cjs
# Or use installed Chrome on macOS:
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tools/capture_backlog.cjs
```

The fixture is local and intercepts all application API requests. It never opens a real classroom.
Screenshots are published in the repository so the project cards can embed stable links to a specific commit.
When a card changes, maintain its local description and live project body together; operational status remains on Projects.
