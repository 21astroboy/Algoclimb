"""Дымовой тест для CI: приложение импортируется и поднимается без приватного банка.

Не требует task-bank.json / explanations.json (они в .gitignore). Проверяет, что
срабатывает фолбэк на task-bank.example.json и объект FastAPI-приложения создаётся.
Запуск:  python -m smoke_test   (из каталога server_py)
"""

import sys

import bank
import main


def main_check() -> int:
    ok = True

    def check(name: str, cond: bool) -> None:
        nonlocal ok
        ok = ok and cond
        print(("  PASS " if cond else "  FAIL ") + name)

    check("app is FastAPI", type(main.app).__name__ == "FastAPI")
    check("bank loaded (>=1 task)", len(bank.TASKS) >= 1)
    check("bank source is a json file", str(bank.BANK_SOURCE).endswith(".json"))
    check("BY_ID index built", len(bank.BY_ID) == len(bank.TASKS))
    check("EXPLAIN is a dict", isinstance(main.EXPLAIN, dict))

    # Публичная проекция каждой задачи не должна падать и не должна протекать ответами.
    for t in bank.TASKS:
        pub = bank.public_task(t)
        check(f"public_task({t['id']}) has no answer key", "answer" not in pub)

    print("SMOKE", "OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main_check())
