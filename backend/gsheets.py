"""
AlgoClimb — выгрузка результатов в Google Sheets (лист «Оценки»).

Что делает: после игры преподаватель жмёт кнопку → сервер по логинам участников
находит их строки на листе «Оценки» нужного потока, берёт первый свободный
столбец заданий, пишет заголовок «Algoclimb №n» (n — авто) и ставит участникам
<points> балла (по умолчанию 2). Отсутствующим — ничего. Максимальный балл не
трогаем (это доп. задания).

Как связываются логин и строка оценок:
  лист «Данные для входа»: Логин → (Группа, ФИО полное)
  лист «Оценки»:           строка студента по (Группа, «Фамилия Имя»)
ФИО на «Оценках» короткое (Фамилия Имя), поэтому полное ФИО из входа сжимаем до
первых двух слов и сравниваем нормализованно (нижний регистр, ё→е, схлоп пробелов).

Доступ к таблицам — сервисный аккаунт Google (gspread + google-auth). Импорт
gspread «ленивый» (внутри функций), чтобы модуль и его чистые помощники можно
было тестировать без установленного gspread.
"""

from __future__ import annotations

import re

# ----------------------------------------------------------------- чистые помощники
# (без сети и gspread — удобно покрывать юнит-тестами)


def norm(s) -> str:
    """Нормализация для сравнения имён/групп: str, trim, нижний регистр, ё→е,
    схлопывание пробелов. None → ''."""
    if s is None:
        return ""
    s = str(s).replace("\u00a0", " ").strip().lower().replace("ё", "е")
    return re.sub(r"\s+", " ", s)


def short_fio(fio) -> str:
    """Полное ФИО → «Фамилия Имя» (первые два слова). Если слово одно — его же."""
    parts = norm(fio).split(" ")
    parts = [p for p in parts if p]
    return " ".join(parts[:2])


def _cell(row, i) -> str:
    """Безопасно взять ячейку строки (list) по 0-based индексу; за пределами → ''."""
    return row[i] if 0 <= i < len(row) else ""


def col_letter(idx: int) -> str:
    """1 → 'A', 26 → 'Z', 27 → 'AA'."""
    if idx < 1:
        raise ValueError("col index must be >= 1")
    out = ""
    while idx:
        idx, rem = divmod(idx - 1, 26)
        out = chr(65 + rem) + out
    return out


def col_idx(letter: str) -> int:
    """'A' → 1, 'AA' → 27."""
    letter = (letter or "").strip().upper()
    if not letter or not letter.isalpha():
        raise ValueError(f"bad column letter: {letter!r}")
    n = 0
    for ch in letter:
        n = n * 26 + (ord(ch) - 64)
    return n


def build_login_index(rows, header_row, group_col, fio_col, login_col):
    """Лист «Данные для входа» → {norm(login): {'login','group','fio'}}.

    rows — список строк (list[list]) как из gspread get_all_values() (1-based строки
    мы режем по header_row). *_col — буквы столбцов.
    """
    gi, fi, li = col_idx(group_col) - 1, col_idx(fio_col) - 1, col_idx(login_col) - 1
    out = {}
    for r in rows[header_row:]:
        login = str(_cell(r, li)).strip()
        if not login:
            continue
        out[norm(login)] = {
            "login": login,
            "group": str(_cell(r, gi)).strip(),
            "fio": str(_cell(r, fi)).strip(),
        }
    return out


def build_grade_index(rows, first_data_row, group_col, fio_col):
    """Лист «Оценки» → {(norm(group), norm(short_fio)): row_number_1based}.

    row_number — абсолютный номер строки в таблице (1-based), пригодный для записи.
    """
    gi, fi = col_idx(group_col) - 1, col_idx(fio_col) - 1
    out = {}
    for n0, r in enumerate(rows):
        row_no = n0 + 1
        if row_no < first_data_row:
            continue
        group = str(_cell(r, gi)).strip()
        fio = str(_cell(r, fi)).strip()
        if not group and not fio:
            continue
        out[(norm(group), short_fio(fio))] = row_no
    return out


_ALGO_RE = re.compile(r"algoclimb\s*№?\s*(\d+)", re.IGNORECASE)


def scan_assignment_headers(header_cells, first_assignment_idx0):
    """header_cells — строка-заголовок заданий (list), 0-based.
    first_assignment_idx0 — 0-based индекс первого столбца заданий.

    Возвращает (next_free_idx0, next_algoclimb_n):
      next_free_idx0   — 0-based индекс первого пустого столбца заданий;
      next_algoclimb_n — max существующий номер «Algoclimb №k» + 1 (или 1).
    """
    max_n = 0
    free_idx = first_assignment_idx0
    i = first_assignment_idx0
    # идём вправо, пока есть непустые заголовки
    while i < len(header_cells) and str(header_cells[i]).strip():
        m = _ALGO_RE.search(str(header_cells[i]))
        if m:
            max_n = max(max_n, int(m.group(1)))
        i += 1
        free_idx = i
    return free_idx, max_n + 1


# ----------------------------------------------------------------- планирование записи


def plan_export(login_rows, grade_rows, logins, cfg):
    """Чистое ядро: по данным двух листов и списку логинов-участников строит план
    записи. Сети нет. Возвращает dict-отчёт.

    cfg — секция config['gsheets'] (нужны ключи login/grade/points/columnPrefix).
    """
    lcfg, gcfg = cfg["login"], cfg["grade"]
    points = cfg.get("points", 2)
    prefix = cfg.get("columnPrefix", "Algoclimb")

    login_idx = build_login_index(
        login_rows, lcfg["headerRow"], lcfg["groupCol"], lcfg["fioCol"], lcfg["loginCol"]
    )
    grade_idx = build_grade_index(
        grade_rows, gcfg["firstDataRow"], gcfg["groupCol"], gcfg["fioCol"]
    )

    header_row_no = gcfg["headerRow"]
    header_cells = grade_rows[header_row_no - 1] if header_row_no - 1 < len(grade_rows) else []
    first_assign_idx0 = col_idx(gcfg["firstAssignmentCol"]) - 1
    free_idx0, next_n = scan_assignment_headers(header_cells, first_assign_idx0)

    target_col_letter = col_letter(free_idx0 + 1)
    header_text = f"{prefix} №{next_n}"

    matched = []  # [{login, group, fio, row}]
    unmatched = []  # [{login, reason, group?, fio?}]
    for login in logins:
        info = login_idx.get(norm(login))
        if not info:
            unmatched.append({"login": login, "reason": "no_login_in_sheet"})
            continue
        key = (norm(info["group"]), short_fio(info["fio"]))
        row = grade_idx.get(key)
        if not row:
            unmatched.append(
                {
                    "login": login,
                    "reason": "no_grade_row",
                    "group": info["group"],
                    "fio": info["fio"],
                }
            )
            continue
        matched.append({"login": login, "group": info["group"], "fio": info["fio"], "row": row})

    # ячейки на запись: заголовок + баллы участникам
    writes = [{"a1": f"{target_col_letter}{header_row_no}", "value": header_text}]
    for m in matched:
        writes.append({"a1": f"{target_col_letter}{m['row']}", "value": points})

    return {
        "column": target_col_letter,
        "header": header_text,
        "headerRow": header_row_no,
        "points": points,
        "number": next_n,
        "matched": matched,
        "unmatched": unmatched,
        "writes": writes,
    }


# ----------------------------------------------------------------- gspread I/O (ленивый импорт)


def _open_spreadsheet(cfg, stream):
    """Авторизация сервисным аккаунтом и открытие таблицы потока. Возвращает
    gspread.Spreadsheet. Импорт gspread/google-auth — внутри, чтобы модуль грузился
    без них."""
    from pathlib import Path

    import gspread
    from google.oauth2.service_account import Credentials

    sid = (cfg.get("streams") or {}).get(str(stream))
    if not sid:
        raise RuntimeError(f"Для потока {stream} не задан id таблицы в gsheets.streams")

    sa_file = cfg.get("serviceAccountFile") or "secrets/service-account.json"
    sa_path = Path(sa_file)
    if not sa_path.is_absolute():
        # относительно корня проекта (backend/..)
        sa_path = Path(__file__).resolve().parent.parent / sa_file
    if not sa_path.exists():
        raise RuntimeError(f"Не найден ключ сервисного аккаунта: {sa_path}")

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds = Credentials.from_service_account_file(str(sa_path), scopes=scopes)
    client = gspread.authorize(creds)
    return client.open_by_key(sid)


def export_grades(cfg, stream, logins, dry_run=True):
    """Главная точка входа. Читает оба листа, строит план (plan_export) и, если
    dry_run=False, записывает ячейки. Возвращает отчёт с добавленным ключом
    'committed'. Поднимает исключения при проблемах доступа/конфигурации.
    """
    if not cfg or not cfg.get("enabled"):
        raise RuntimeError("Интеграция с Google Sheets выключена (gsheets.enabled=false)")

    ss = _open_spreadsheet(cfg, stream)
    login_ws = ss.worksheet(cfg.get("loginSheet", "Данные для входа"))
    grade_ws = ss.worksheet(cfg.get("gradeSheet", "Оценки"))

    login_rows = login_ws.get_all_values()
    grade_rows = grade_ws.get_all_values()

    plan = plan_export(login_rows, grade_rows, logins, cfg)
    plan["stream"] = stream
    plan["spreadsheetTitle"] = ss.title
    plan["committed"] = False

    if not dry_run and plan["writes"]:
        # Один батч-запрос: каждой ячейке своё значение (заголовок + баллы).
        batch = [{"range": w["a1"], "values": [[w["value"]]]} for w in plan["writes"]]
        grade_ws.batch_update(batch, value_input_option="USER_ENTERED")
        plan["committed"] = True

    return plan
