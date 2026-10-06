#!/usr/bin/env python3
"""
Нагрузочный тест AlgoClimb по WebSocket.

Зачем: проверить, тянет ли ОДИН воркер uvicorn ~120 студентов одновременно
(подключение + вход + ответы), или студенты начинают отваливаться. Если на
слабой машине тест даёт отвалы/большие задержки, а на мощной — нет, значит
проблема в ресурсах VPS (нужно докупать). Если отвалы и там, и там — дело в софте.

Безопасно для БД: тест запускает игру в РЕЖИМЕ test (start с test:true),
поэтому сервер НИЧЕГО не пишет в базу (ни сессию, ни ответы, ни посещаемость).

Требования: python3 + библиотека websockets (входит в uvicorn[standard],
т.е. уже есть в окружении сервера). Опционально psutil — для CPU/RAM сервера.

Примеры:
    # локально, debug-сервер на 3000, ключ преподавателя ABC123
    python3 tools/loadtest.py --url http://localhost:3000 --key ABC123 --students 120

    # с замером CPU/RAM серверного процесса (нужен psutil и PID uvicorn)
    python3 tools/loadtest.py --url http://localhost:3000 --key ABC123 --students 120 --pid 12345
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from urllib.parse import urlsplit

try:
    import websockets
except ImportError as err:
    raise SystemExit("Нужна библиотека websockets:  pip install websockets") from err

ICONS = ["🦊", "🐼", "🐧", "🐙", "🦁", "🐸", "🦉", "🐝", "🐲", "🦄"]


def ws_base(url: str) -> str:
    """http(s)://host:port  ->  ws(s)://host:port"""
    u = urlsplit(url)
    scheme = "wss" if u.scheme in ("https", "wss") else "ws"
    netloc = u.netloc or u.path  # на случай, если передали без схемы
    return f"{scheme}://{netloc}"


class Stats:
    def __init__(self):
        self.joined = 0
        self.rejected = 0
        self.connect_errors = 0
        self.unexpected_drops = 0
        self.answers_sent = 0
        self.answers_confirmed = 0
        self.latencies_ms: list[float] = []
        self.reject_reasons: dict[str, int] = {}


async def student(idx: int, ws_url: str, stats: Stats, joined_evt_cb, done_evt: asyncio.Event):
    nick = f"LoadBot{idx:03d}"
    icon = ICONS[idx % len(ICONS)]
    url = f"{ws_url}/?role=student"
    pending_recv: dict[str, float] = {}  # taskId -> время отправки ответа (для latency)
    try:
        async with websockets.connect(url, open_timeout=20, max_queue=64) as ws:
            await ws.send(json.dumps({"type": "join", "nick": nick, "icon": icon}))
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=90)
                except TimeoutError:
                    stats.unexpected_drops += 1
                    return
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "joined":
                    stats.joined += 1
                    joined_evt_cb()
                elif t == "rejected":
                    stats.rejected += 1
                    r = msg.get("reason", "?")
                    stats.reject_reasons[r] = stats.reject_reasons.get(r, 0) + 1
                    return
                elif t == "task":
                    task = msg.get("task") or {}
                    tid = task.get("id")
                    # Отвечаем на ЛЮБОЙ тип — лишь бы попасть в round_answered.
                    payload = _answer_payload(task)
                    sent = time.perf_counter()
                    pending_recv[tid] = sent
                    await ws.send(
                        json.dumps({"type": "answer", "taskId": tid, "payload": payload})
                    )
                    stats.answers_sent += 1
                elif t == "answered":
                    stats.answers_confirmed += 1
                    # latency: по последнему отправленному ответу
                    if pending_recv:
                        tid = next(reversed(pending_recv))
                        dt = (time.perf_counter() - pending_recv.pop(tid)) * 1000
                        stats.latencies_ms.append(dt)
                elif t == "sessionend":
                    return
    except Exception:
        if done_evt.is_set():
            return  # игра кончилась, закрытие сокета — норма
        stats.connect_errors += 1


def _answer_payload(task: dict) -> dict:
    ty = task.get("type")
    if ty == "choice":
        return {"choice": 0}
    if ty == "sort":
        return {"array": list(task.get("array") or [])}
    if ty == "order":
        return {"order": list(task.get("order") or [])}
    if ty == "blank":
        return {"blanks": []}
    if ty == "graph":
        return {"edges": []}
    return {}


async def run_teacher(ws_url: str, key: str, want_tasks: int):
    """Подключается преподавателем, возвращает (ws, список choice-taskIds)."""
    ws = await websockets.connect(f"{ws_url}/teacher?key={key}", open_timeout=20)
    catalog = []
    deadline = time.time() + 10
    while time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        msg = json.loads(raw)
        if msg.get("type") == "catalog":
            catalog = msg.get("items") or []
        if msg.get("type") == "rejected":
            raise SystemExit("Преподаватель отклонён: неверный --key")
        if catalog:
            break
    choice_ids = [c["id"] for c in catalog if c.get("type") == "choice"][:want_tasks]
    if not choice_ids:
        choice_ids = [c["id"] for c in catalog][:want_tasks]
    return ws, choice_ids


def _sample_proc(pid: int | None):
    if not pid:
        return None
    try:
        import psutil
    except ImportError:
        return None
    try:
        return psutil.Process(pid)
    except Exception:
        return None


async def main():
    ap = argparse.ArgumentParser(description="Нагрузочный тест AlgoClimb (WebSocket)")
    ap.add_argument("--url", required=True, help="http(s)://host:port сервера")
    ap.add_argument("--key", required=True, help="ключ преподавателя")
    ap.add_argument("--students", type=int, default=120)
    ap.add_argument("--tasks", type=int, default=5, help="сколько вопросов прогнать")
    ap.add_argument("--spawn-rate", type=int, default=60, help="подключений в секунду")
    ap.add_argument("--hold", type=float, default=8.0,
                    help="сколько секунд дать студентам отвечать перед finish")
    ap.add_argument("--pid", type=int, default=None, help="PID uvicorn для замера CPU/RAM")
    args = ap.parse_args()

    ws_url = ws_base(args.url)
    stats = Stats()
    done_evt = asyncio.Event()

    joined_count = {"n": 0}

    def on_join():
        joined_count["n"] += 1

    print(f"→ Преподаватель подключается к {ws_url}/teacher …")
    teacher_ws, task_ids = await run_teacher(ws_url, args.key, args.tasks)
    print(f"  выбрано вопросов (choice): {len(task_ids)} → {task_ids}")

    proc = _sample_proc(args.pid)
    cpu_samples, mem_samples = [], []
    if proc:
        proc.cpu_percent(None)  # первый вызов — базовый

    # 1) поднимаем студентов пачками
    print(f"→ Поднимаем {args.students} студентов (~{args.spawn_rate}/сек) …")
    tasks = []
    t_connect0 = time.perf_counter()
    for i in range(args.students):
        tasks.append(asyncio.create_task(student(i, ws_url, stats, on_join, done_evt)))
        if args.spawn_rate and (i + 1) % args.spawn_rate == 0:
            await asyncio.sleep(1.0)

    # ждём, пока большинство войдёт (до 30 сек)
    wait_until = time.perf_counter() + 30
    while time.perf_counter() < wait_until:
        if stats.joined + stats.rejected >= args.students:
            break
        await asyncio.sleep(0.3)
    connect_s = time.perf_counter() - t_connect0
    print(f"  вошло: {stats.joined}/{args.students}  отклонено: {stats.rejected}  за {connect_s:.1f}с")

    # 2) стартуем игру в режиме test (БЕЗ записи в БД)
    print("→ Старт игры в режиме test (в БД ничего не пишется) …")
    await teacher_ws.send(
        json.dumps({"type": "start", "taskIds": task_ids, "test": True})
    )

    # 3) крутим, пока студенты не доиграют; параллельно снимаем CPU/RAM
    async def monitor():
        while not done_evt.is_set():
            if proc:
                try:
                    cpu_samples.append(proc.cpu_percent(None))
                    mem_samples.append(proc.memory_info().rss / 1e6)
                except Exception:
                    pass
            await asyncio.sleep(1.0)

    mon = asyncio.create_task(monitor())

    # даём студентам время поотвечать, затем принудительно завершаем игру,
    # чтобы прогон не висел на 17-сек таймере из-за одного отставшего.
    await asyncio.sleep(args.hold)
    print(f"→ Прошло {args.hold:.0f}с — преподаватель шлёт finish …")
    try:
        await teacher_ws.send(json.dumps({"type": "finish"}))
    except Exception:
        pass

    # ждём завершения всех студентов (sessionend), с запасом
    try:
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=12)
    except TimeoutError:
        print("  (часть студентов не прислала sessionend вовремя)")
    done_evt.set()
    mon.cancel()
    try:
        await teacher_ws.send(json.dumps({"type": "reset"}))
        await teacher_ws.close()
    except Exception:
        pass

    # 4) отчёт
    lat = stats.latencies_ms
    lat.sort()

    def pct(p):
        if not lat:
            return 0.0
        k = min(len(lat) - 1, round(p / 100 * (len(lat) - 1)))
        return lat[k]

    print("\n================  РЕЗУЛЬТАТ  ================")
    print(f"Студентов запрошено:        {args.students}")
    print(f"Успешно вошли (joined):     {stats.joined}")
    print(f"Отклонены сервером:         {stats.rejected}  {stats.reject_reasons or ''}")
    print(f"Ошибки подключения:         {stats.connect_errors}")
    print(f"Неожиданные обрывы:         {stats.unexpected_drops}")
    print(f"Ответов отправлено:         {stats.answers_sent}")
    print(f"Ответов подтверждено:       {stats.answers_confirmed}")
    if lat:
        print("\nЗадержка ответ→подтверждение (мс):")
        print(f"  медиана: {statistics.median(lat):.0f}   p90: {pct(90):.0f}   "
              f"p99: {pct(99):.0f}   макс: {lat[-1]:.0f}")
    if cpu_samples:
        print("\nСерверный процесс (по PID):")
        print(f"  CPU%: средн {statistics.mean(cpu_samples):.0f}  макс {max(cpu_samples):.0f}")
        print(f"  RAM:  средн {statistics.mean(mem_samples):.0f}МБ  макс {max(mem_samples):.0f}МБ")

    drops = stats.rejected + stats.connect_errors + stats.unexpected_drops
    print("\nВЕРДИКТ:")
    if drops == 0 and stats.joined == args.students:
        print("  ✅ Все студенты вошли и доиграли без обрывов — сервер тянет эту нагрузку.")
    else:
        print(f"  ⚠ Потери: {drops} (отказы/ошибки/обрывы). Разбирайся по разбивке выше.")
    print("============================================\n")


if __name__ == "__main__":
    asyncio.run(main())
