"""
AlgoClimb — FastAPI-бэкенд (порт server.js).

Синхронная модель игры: весь класс отвечает на один вопрос; раунд закрывается,
когда все ответили ИЛИ истёк таймер. Очки — за скорость, сложность и серию.
Протокол WebSocket/HTTP полностью совпадает с Node-версией, поэтому фронтенд
(public/) используется без изменений.

Запуск:  uvicorn server_py.main:app --host 0.0.0.0 --port 3000
         (или через ./algoclimb — см. README-DEPLOY.md)
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import random
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response

import bank
import db
import gsheets
from analytics import analytics_sheets, stats_data
from security import Security, ip_allowed, is_loopback

BASE = Path(__file__).resolve().parent  # backend/
PROJECT = BASE.parent  # корень проекта
PUBLIC = PROJECT / "frontend"  # статика (было public/)

# ---------------------------------------------------------------- конфиг + env
# CONFIG_PATH — явный путь к config.json (для деплоя удобно подложить свой).
# Если реального config.json нет — берём config.example.json из репозитория.
_config_path = Path(
    (os.environ.get("CONFIG_PATH") or "").strip() or (BASE / "config" / "config.json")
)
if not _config_path.exists():
    _config_path = BASE / "config" / "config.example.json"
config = json.loads(_config_path.read_text(encoding="utf-8"))
config.setdefault("qrRotation", {})
config.setdefault("debug", {"enabled": False})
config.setdefault("ipAllowlist", {"enabled": False, "cidrs": []})
config.setdefault("gsheets", {"enabled": False})
if os.environ.get("QR_ROTATION") == "1":
    config["qrRotation"]["enabled"] = True
if os.environ.get("QR_ROTATION") == "0":
    config["qrRotation"]["enabled"] = False
if os.environ.get("QR_INTERVAL"):
    config["qrRotation"]["intervalSec"] = int(os.environ["QR_INTERVAL"])
if os.environ.get("DEBUG") == "1":
    config["debug"]["enabled"] = True
if os.environ.get("DEBUG") == "0":
    config["debug"]["enabled"] = False
if os.environ.get("GSHEETS") == "1":
    config["gsheets"]["enabled"] = True
if os.environ.get("GSHEETS") == "0":
    config["gsheets"]["enabled"] = False

PORT = int(os.environ.get("PORT") or config.get("port", 3000))
HOST_IP = (os.environ.get("HOST_IP") or "").strip()
PUBLIC_URL = (os.environ.get("PUBLIC_URL") or "").strip().rstrip("/")

TIME = config.get("timeLimits") or {"choice": 10, "graph": 25}
SCORE = config.get("scoring") or {"base": 100, "minFraction": 0.4}
REVEAL_MS = config.get("revealMs", 1800)
AC = config.get("antiCheat") or {"fastMs": 1500, "suspectThreshold": 4}


def gen_key():
    c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(c) for _ in range(8))


TEACHER_KEY = (os.environ.get("TEACHER_KEY") or config.get("teacherKey") or "").strip() or gen_key()
sec = Security(config)


# Объяснения к задачам (после игры). Приватный файл — подкладывается так же, как банк:
# EXPLANATIONS_PATH → secrets/explanations.json → backend/data/explanations.json. Нет файла — {}.
def _explanations_candidates():
    env = (os.environ.get("EXPLANATIONS_PATH") or "").strip()
    if env:
        yield Path(env)
    yield PROJECT / "secrets" / "explanations.json"
    yield BASE / "data" / "explanations.json"


EXPLAIN = {}
for _ep in _explanations_candidates():
    try:
        if _ep.exists():
            EXPLAIN = json.loads(_ep.read_text(encoding="utf-8"))
            break
    except Exception:
        EXPLAIN = {}

CUSTOM_FILE = BASE / "data" / "runtime" / "custom-tasks.json"


def time_limit_for(task):
    quick = task["type"] in ("choice", "blank")
    return (TIME["choice"] if quick else TIME["graph"]) * 1000


def local_ips():
    out = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        out.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in out:
                out.append(ip)
    except Exception:
        pass
    return out


def shuffle(arr):
    a = list(arr)
    random.shuffle(a)
    return a


# ================================================================ игровой движок
class Game:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.current_stream = config.get("stream", 1)
        self.session = {"id": None, "status": "lobby", "test": False}
        self.students = {}  # ws -> student
        self.by_nick = {}  # nick -> student
        self.teachers = set()
        self.order = []
        self.round = -1
        self.round_deadline = 0
        self.round_perm = None
        self.round_answered = set()
        self.intermission = False
        self.paused = False
        self.pause_remain = 0
        self.qr_svg = None
        self.join_url = None
        self._timer = None
        self._reveal = None
        self.custom_specs = []
        self.load_custom_tasks()

    # ---------- пользовательские задачи ----------
    def load_custom_tasks(self):
        try:
            self.custom_specs = json.loads(CUSTOM_FILE.read_text(encoding="utf-8"))
            if not isinstance(self.custom_specs, list):
                self.custom_specs = []
        except Exception:
            self.custom_specs = []
        for spec in self.custom_specs:
            t = bank.build_custom_task(spec)
            if t and t["id"] not in bank.BY_ID:
                bank.TASKS.append(t)
                bank.BY_ID[t["id"]] = t

    def save_custom_tasks(self):
        try:
            CUSTOM_FILE.parent.mkdir(parents=True, exist_ok=True)
            CUSTOM_FILE.write_text(
                json.dumps(self.custom_specs, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as e:
            print("Не удалось сохранить пользовательские задачи:", e)

    # ---------- отбор задач ----------
    def select_tasks(self):
        demo = config.get("demo") or {}
        pool = bank.active_tasks(config.get("activeTasks"))
        if not demo.get("enabled"):
            return list(pool)
        n = max(1, demo.get("count", 5))
        if len(pool) <= n:
            return shuffle(pool)
        picked = []
        if demo.get("onePerType"):
            for tp in dict.fromkeys(t["type"] for t in pool):
                sub = shuffle([t for t in pool if t["type"] == tp])
                if sub:
                    picked.append(sub[0])
        rest = shuffle([t for t in pool if t not in picked])
        for t in rest:
            if len(picked) >= n:
                break
            picked.append(t)
        return shuffle(picked)[:n]

    # ---------- QR ----------
    def build_qr(self):
        if PUBLIC_URL:
            base = PUBLIC_URL + "/"
        else:
            ip = HOST_IP or (local_ips()[0] if local_ips() else "localhost")
            base = f"http://{ip}:{PORT}/"
        self.join_url = (
            (base + "?t=" + sec.current_token()) if config["qrRotation"].get("enabled") else base
        )
        try:
            import segno

            buf = io.BytesIO()
            # Растровый PNG, а не SVG: при масштабировании SVG на экране между
            # модулями появляются тонкие швы (анти-алиасинг) — QR выглядит
            # «порезанным» и не читается камерой. PNG с border=4 (тихая зона)
            # и крупным scale даёт чёткие чёрно-белые модули.
            segno.make(self.join_url, error="m").save(buf, kind="png", scale=12, border=4)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            self.qr_svg = (
                f'<img src="data:image/png;base64,{b64}" alt="QR" '
                'style="width:100%;height:100%;display:block;'
                'image-rendering:pixelated">'
            )
        except Exception as e:
            print("[qr] segno недоступен — на экране будет только ссылка.", e)

    # ---------- рассылки ----------
    async def send(self, ws, msg):
        # Таймаут обязателен: без него один «залипший» сокет (телефон с плохим
        # Wi-Fi, забитый TCP-буфер) блокирует отправку под общим game.lock и
        # подвешивает весь раунд для остальных. 5с — отваливаем медленного.
        try:
            await asyncio.wait_for(ws.send_text(json.dumps(msg, ensure_ascii=False)), timeout=5)
        except Exception:
            pass

    async def broadcast_students(self, make_msg):
        # Рассылка всем студентам ПАРАЛЛЕЛЬНО, а не по очереди, чтобы медленный
        # клиент не тормозил доставку остальным. make_msg(s) -> dict | None.
        targets = [(ws, s) for ws, s in list(self.students.items()) if not s["kicked"]]
        coros = []
        for ws, s in targets:
            msg = make_msg(s)
            if msg is not None:
                coros.append(self.send(ws, msg))
        if coros:
            await asyncio.gather(*coros)

    def connected_nicks(self):
        return {s["nick"] for s in self.students.values() if not s["kicked"]}

    def is_connected(self, nick):
        return any(s["nick"] == nick for s in self.students.values())

    def roster_arr(self):
        return [
            {"nick": s["nick"], "icon": s["icon"]} for s in self.by_nick.values() if not s["kicked"]
        ]

    def leaderboard(self):
        rows = []
        for s in self.by_nick.values():
            if s["kicked"]:
                continue
            answers = [
                ({"correct": a["correct"], "answered": a["answered"]} if a else None)
                for a in (s["answers"].get(i) for i in range(len(self.order)))
            ]
            rows.append(
                {
                    "nick": s["nick"],
                    "icon": s["icon"],
                    "score": s["score"],
                    "correct": s["correct"],
                    "tabLeaves": s["tabLeaves"],
                    "fastAnswers": s.get("fastAnswers", 0),
                    "connected": self.is_connected(s["nick"]),
                    "answeredThisRound": s["nick"] in self.round_answered,
                    "answers": answers,
                }
            )
        rows.sort(key=lambda r: (-r["score"], -r["correct"]))
        for i, r in enumerate(rows):
            r["rank"] = i + 1
        return rows

    def answer_key_data(self):
        pool = bank.active_tasks(config.get("activeTasks"))
        return [
            {
                "id": t["id"],
                "title": t["title"],
                "prompt": t["prompt"],
                "topic": t.get("topic"),
                "type": t["type"],
                "level": t.get("level", 1),
                "answer": bank.answer_text(t),
            }
            for t in pool
        ]

    def session_details(self):
        out = []
        for ri, task in enumerate(self.order):
            responses = []
            for s in self.by_nick.values():
                if s["kicked"]:
                    continue
                a = s["answers"].get(ri)
                responses.append(
                    {
                        "nick": s["nick"],
                        "icon": s["icon"],
                        "answered": bool(a and a["answered"]),
                        "correct": bool(a and a["correct"]),
                        "ms": (a["ms"] if (a and a["answered"]) else None),
                        "points": (a["points"] if a else 0),
                        "answer": (a.get("ansText", "") if (a and a["answered"]) else None),
                    }
                )
            is_gr = task["type"] in ("graph", "order")
            out.append(
                {
                    "index": ri,
                    "id": task["id"],
                    "title": task["title"],
                    "prompt": task["prompt"],
                    "type": task["type"],
                    "correctAnswer": bank.answer_text(task),
                    "nodes": (task.get("nodes") or []) if is_gr else None,
                    "answerGraph": bank.answer_edges(task) if is_gr else None,
                    "responses": responses,
                }
            )
        return out

    async def broadcast_teacher(self):
        task = self.order[self.round] if self.round >= 0 else None
        running = self.session["status"] == "running"
        payload = {
            "type": "state",
            "session": {
                "status": self.session["status"],
                "stream": self.current_stream,
                "total": len(self.order),
            },
            "test": bool(self.session["test"]),
            "round": self.round,
            "roundTotal": len(self.order),
            "currentType": task["type"] if task else None,
            "currentId": task["id"] if task else None,
            "currentTitle": task["title"] if task else None,
            "currentAnswer": bank.answer_text(task) if task else None,
            "deadline": self.round_deadline
            if (running and not self.intermission and not self.paused)
            else 0,
            "limit": time_limit_for(task) if task else 0,
            "serverTime": int(time.time() * 1000),
            "answeredCount": len(self.round_answered),
            "activeCount": len(self.connected_nicks()),
            "intermission": self.intermission,
            "paused": self.paused,
            "token": sec.current_token() if config["qrRotation"].get("enabled") else None,
            "qrSvg": self.qr_svg,
            "joinUrl": self.join_url,
            "roster": self.roster_arr(),
            "leaderboard": self.leaderboard(),
            "details": self.session_details() if self.order else [],
        }
        for ws in list(self.teachers):
            await self.send(ws, payload)

    async def send_current_task(self, s, ws):
        if self.round < 0 or not self.order[self.round]:
            return
        task = self.order[self.round]
        pub = bank.public_task(task)
        if task["type"] == "choice" and self.round_perm:
            pub["options"] = [task["options"][i] for i in self.round_perm]
        await self.send(
            ws,
            {
                "type": "task",
                "index": self.round,
                "total": len(self.order),
                "task": pub,
                "deadline": self.round_deadline,
                "serverTime": int(time.time() * 1000),
                "limit": time_limit_for(task),
            },
        )
        a = s["answers"].get(self.round)
        if a and a["answered"]:
            await self.send(
                ws,
                {
                    "type": "answered",
                    "correct": a["correct"],
                    "points": a["points"],
                    "picked": a.get("picked"),
                },
            )
        if self.paused:
            await self.send(ws, {"type": "paused"})

    # ---------- таймеры ----------
    def _cancel_timers(self):
        for t in (self._timer, self._reveal):
            if t:
                t.cancel()
        self._timer = None
        self._reveal = None

    def _schedule(self, attr, delay_ms, coro_factory):
        async def run():
            try:
                await asyncio.sleep(delay_ms / 1000)
            except asyncio.CancelledError:
                return
            async with self.lock:
                await coro_factory()

        task = asyncio.create_task(run())
        setattr(self, attr, task)

    # ---------- игровой цикл ----------
    async def begin_round(self, idx):
        self.round = idx
        task = self.order[idx]
        self.round_answered = set()
        self.round_perm = (
            shuffle(list(range(len(task["options"])))) if task["type"] == "choice" else None
        )
        self.round_deadline = int(time.time() * 1000) + time_limit_for(task)
        self.paused = False
        self.pause_remain = 0
        await asyncio.gather(
            *(
                self.send_current_task(s, ws)
                for ws, s in list(self.students.items())
                if not s["kicked"]
            )
        )
        if self._timer:
            self._timer.cancel()
        self._schedule("_timer", time_limit_for(task) + 400, lambda: self.end_round("timeout"))
        await self.broadcast_teacher()

    async def end_round(self, reason):
        if self.round < 0 or self.intermission:
            return
        if self._timer:
            self._timer.cancel()
            self._timer = None
        for s in self.by_nick.values():
            if s["kicked"]:
                continue
            a = s["answers"].get(self.round)
            if not a or not a["answered"]:
                s["answers"][self.round] = {
                    "taskId": self.order[self.round]["id"],
                    "correct": False,
                    "points": 0,
                    "answered": False,
                }
                s["streak"] = 0
        self.intermission = True

        def _roundover(s):
            a = s["answers"].get(self.round)
            return {
                "type": "roundover",
                "correct": bool(a and a["correct"]),
                "answered": bool(a and a["answered"]),
            }

        await self.broadcast_students(_roundover)
        await self.broadcast_teacher()
        self._schedule("_reveal", REVEAL_MS, self._advance)

    async def _advance(self):
        self.intermission = False
        if self.round + 1 >= len(self.order):
            await self.finish_game()
        else:
            await self.begin_round(self.round + 1)

    async def maybe_end_round(self):
        if self.paused:
            return
        nicks = list(self.connected_nicks())
        if nicks and all(n in self.round_answered for n in nicks):
            await self.end_round("all")

    # ---------- управление раундом ----------
    async def pause_round(self):
        if (
            self.session["status"] != "running"
            or self.round < 0
            or self.intermission
            or self.paused
        ):
            return
        self.paused = True
        self.pause_remain = max(0, self.round_deadline - int(time.time() * 1000))
        if self._timer:
            self._timer.cancel()
            self._timer = None
        await self.broadcast_students(lambda s: {"type": "paused"})
        await self.broadcast_teacher()

    async def resume_round(self):
        if (
            self.session["status"] != "running"
            or self.round < 0
            or self.intermission
            or not self.paused
        ):
            return
        self.paused = False
        self.round_deadline = int(time.time() * 1000) + self.pause_remain
        self._schedule("_timer", self.pause_remain + 400, lambda: self.end_round("timeout"))
        await self.broadcast_students(
            lambda s: {
                "type": "resumed",
                "deadline": self.round_deadline,
                "serverTime": int(time.time() * 1000),
                "limit": time_limit_for(self.order[self.round]),
            }
        )
        await self.broadcast_teacher()

    async def skip_round(self):
        if self.session["status"] != "running" or self.round < 0 or self.intermission:
            return
        self.paused = False
        if self._timer:
            self._timer.cancel()
            self._timer = None
        await self.end_round("skip")

    async def add_round_time(self, ms):
        if self.session["status"] != "running" or self.round < 0 or self.intermission:
            return
        ms = max(0, min(120000, int(ms)))
        if self.paused:
            self.pause_remain += ms
            await self.broadcast_teacher()
            return
        self.round_deadline += ms
        self._schedule(
            "_timer",
            max(0, self.round_deadline - int(time.time() * 1000)) + 400,
            lambda: self.end_round("timeout"),
        )
        for ws, s in list(self.students.items()):
            if s["kicked"]:
                continue
            await self.send(
                ws,
                {
                    "type": "addtime",
                    "deadline": self.round_deadline,
                    "serverTime": int(time.time() * 1000),
                },
            )
        await self.broadcast_teacher()

    async def finish_game(self):
        self.session["status"] = "finished"
        ranked = self.leaderboard()
        if not self.session["test"]:
            db.set_session_status(self.session["id"], "finished")
            for i, r in enumerate(ranked):
                db.record_result(self.session["id"], r["nick"], 0, 1, r["score"], i + 1)

        def _sessionend(s):
            place = next((i + 1 for i, r in enumerate(ranked) if r["nick"] == s["nick"]), 0)
            review = []
            for ri, task in enumerate(self.order):
                a = s["answers"].get(ri)
                review.append(
                    {
                        "title": task["title"],
                        "prompt": task["prompt"],
                        "type": task["type"],
                        "answered": bool(a and a["answered"]),
                        "correct": bool(a and a["correct"]),
                        "yourAnswer": (a.get("ansText", "") if (a and a["answered"]) else None),
                        "correctAnswer": bank.answer_text(task),
                        "explain": EXPLAIN.get(task["id"], ""),
                    }
                )
            return {
                "type": "sessionend",
                "place": place,
                "score": s["score"],
                "correct": s["correct"],
                "total": len(self.order),
                "bestStreak": s.get("bestStreak", 0),
                "review": review,
            }

        await self.broadcast_students(_sessionend)
        await self.broadcast_teacher()

    # ---------- обработка сообщений студента ----------
    async def handle_student(self, ws, msg, ip):
        if msg.get("type") == "join":
            nick = (msg.get("nick") or "").strip()[:24]
            if not nick:
                return await self.send(ws, {"type": "rejected", "reason": "Пустой ник."})
            dbg = config["debug"].get("enabled") and is_loopback(ip)
            existing = self.by_nick.get(nick)
            # Переподключение уже допущенного ника НЕ требует свежего кода входа.
            # Код/nonce из QR проверяем только при первом входе — иначе при разрыве
            # связи (блокировка экрана телефона, смена Wi-Fi, ротация QR) студент
            # получал бы отказ и вылетал из игры. Состояние (очки, ответы) при
            # обрыве сокета сохраняется в by_nick, поэтому вернуть его безопасно.
            is_reconnect = existing is not None and not existing["kicked"]
            if not dbg and not is_reconnect:
                if not sec.token_ok(msg.get("token")):
                    return await self.send(
                        ws,
                        {
                            "type": "rejected",
                            "reason": "Неверный или устаревший код. Отсканируйте свежий QR.",
                        },
                    )
                if config["qrRotation"].get("enabled") and not sec.consume_nonce(msg.get("nonce")):
                    return await self.send(
                        ws,
                        {
                            "type": "rejected",
                            "reason": "Сессия входа устарела. Обновите страницу и войдите снова.",
                        },
                    )
            if existing:
                if existing["kicked"]:
                    return await self.send(
                        ws, {"type": "rejected", "reason": "Вас удалили из сессии."}
                    )
                s = existing
                self.students[ws] = s
            else:
                if self.session["status"] != "lobby":
                    return await self.send(
                        ws, {"type": "rejected", "reason": "Сессия уже началась."}
                    )
                s = {
                    "nick": nick,
                    "icon": msg.get("icon") or "👾",
                    "ip": ip,
                    "joinedAt": int(time.time() * 1000),
                    "score": 0,
                    "correct": 0,
                    "streak": 0,
                    "bestStreak": 0,
                    "tabLeaves": 0,
                    "fastAnswers": 0,
                    "kicked": False,
                    "answers": {},
                }
                self.by_nick[nick] = s
                self.students[ws] = s
            await self.send(
                ws,
                {
                    "type": "joined",
                    "nick": s["nick"],
                    "icon": s["icon"],
                    "status": self.session["status"],
                },
            )
            if self.session["status"] == "running":
                # Всегда возвращаем текущий вопрос (в т.ч. при переподключении),
                # чтобы вернувшийся студент не завис на экране лобби. Если идёт
                # пауза между вопросами — следом шлём roundover, чтобы показать
                # «итоги/следующий вопрос», а не живой таймер.
                await self.send_current_task(s, ws)
                if self.intermission:
                    await self.send(ws, {"type": "roundover"})
            await self.broadcast_teacher()
            return

        s = self.students.get(ws)
        if not s or s["kicked"]:
            return

        if msg.get("type") == "answer":
            if self.session["status"] != "running" or self.round < 0 or self.intermission:
                return
            task = self.order[self.round]
            if not task or task["id"] != msg.get("taskId"):
                return
            if s["nick"] in self.round_answered:
                return
            self.round_answered.add(s["nick"])

            payload = msg.get("payload") or {}
            picked = payload.get("choice") if isinstance(payload.get("choice"), int) else None
            if task["type"] == "choice" and self.round_perm and picked is not None:
                payload = {"choice": self.round_perm[picked]}
            correct = bool(bank.run_check(task, payload))
            now = int(time.time() * 1000)
            limit = time_limit_for(task)
            frac = max(0, min(1, (self.round_deadline - now) / limit))
            points = base_points = speed_bonus = streak_bonus = 0
            if correct:
                s["correct"] += 1
                s["streak"] = s.get("streak", 0) + 1
                if s["streak"] > s["bestStreak"]:
                    s["bestStreak"] = s["streak"]
                lvl = task.get("level", 1)
                base_points = round(SCORE["base"] * lvl * SCORE["minFraction"])
                speed_bonus = round(SCORE["base"] * lvl * (1 - SCORE["minFraction"]) * frac)
                step = SCORE.get("streakStep", 25)
                cap = SCORE.get("streakMax", 100)
                streak_bonus = min(cap, max(0, s["streak"] - 1) * step)
                points = base_points + speed_bonus + streak_bonus
                s["score"] += points
            else:
                s["streak"] = 0

            raw_payload = msg.get("payload") or {}
            ty = task["type"]
            if ty == "choice" and picked is not None:
                ans_text = task["options"][payload["choice"]]
            elif ty == "graph":
                ans_text = (
                    ", ".join(f"{e[0]}–{e[1]}" for e in (raw_payload.get("edges") or []))
                    or "(пусто)"
                )
            elif ty == "order":
                ans_text = " → ".join(str(x) for x in (raw_payload.get("order") or [])) or "(пусто)"
            elif ty == "sort":
                ans_text = "[" + ", ".join(str(x) for x in (raw_payload.get("array") or [])) + "]"
            elif ty == "blank":
                ans_text = (
                    " | ".join(
                        "∅" if (v == "" or v is None) else str(v)
                        for v in (raw_payload.get("blanks") or [])
                    )
                    or "(пусто)"
                )
            else:
                ans_text = ""
            ans_ms = now - (self.round_deadline - limit)
            s["answers"][self.round] = {
                "taskId": task["id"],
                "correct": correct,
                "points": points,
                "answered": True,
                "picked": picked,
                "ansText": ans_text,
                "ms": ans_ms,
            }
            if not self.session["test"]:
                db.record_answer(self.session["id"], s["nick"], task["id"], correct, ans_ms)

            if correct and 0 <= ans_ms < AC.get("fastMs", 1500):
                s["fastAnswers"] = s.get("fastAnswers", 0) + 1
                if not self.session["test"]:
                    db.record_event(self.session["id"], s["nick"], "fast")
                for t in list(self.teachers):
                    await self.send(
                        t,
                        {
                            "type": "flag",
                            "nick": s["nick"],
                            "kind": "fast",
                            "count": s["fastAnswers"],
                        },
                    )

            await self.send(
                ws,
                {
                    "type": "answered",
                    "correct": correct,
                    "points": points,
                    "basePoints": base_points,
                    "speedBonus": speed_bonus,
                    "streakBonus": streak_bonus,
                    "streak": s["streak"],
                    "picked": picked,
                },
            )
            await self.broadcast_teacher()
            await self.maybe_end_round()
            return

        if msg.get("type") == "tableave":
            s["tabLeaves"] += 1
            if not self.session["test"]:
                db.record_event(self.session["id"], s["nick"], "tableave")
            for t in list(self.teachers):
                await self.send(
                    t,
                    {
                        "type": "flag",
                        "nick": s["nick"],
                        "kind": "tableave",
                        "count": s["tabLeaves"],
                    },
                )
            await self.broadcast_teacher()

    async def on_student_disconnect(self, ws):
        if ws in self.students:
            del self.students[ws]
        await self.broadcast_teacher()

    # ---------- обработка сообщений преподавателя ----------
    async def handle_teacher(self, ws, msg):
        t = msg.get("type")
        if t == "getStats":
            try:
                await self.send(ws, {"type": "stats", **stats_data(msg.get("stream"), AC)})
            except Exception as e:
                await self.send(
                    ws,
                    {
                        "type": "stats",
                        "sessions": [],
                        "tasks": [],
                        "backend": db.backend,
                        "error": str(e),
                    },
                )
            return
        if t == "wipeData":
            try:
                db.wipe_all()
                await self.send(ws, {"type": "wiped", "ok": True})
                await self.send(ws, {"type": "stats", **stats_data(None, AC)})
            except Exception as e:
                await self.send(ws, {"type": "wiped", "ok": False, "error": str(e)})
            return
        if t == "addTask":
            task = bank.build_custom_task(msg.get("task"))
            if not task:
                return await self.send(
                    ws,
                    {
                        "type": "taskAdded",
                        "ok": False,
                        "error": "Некорректная задача: проверьте обязательные поля.",
                    },
                )
            if task["id"] in bank.BY_ID:
                return await self.send(
                    ws,
                    {
                        "type": "taskAdded",
                        "ok": False,
                        "error": "Задача с таким кодом уже существует.",
                    },
                )
            bank.TASKS.append(task)
            bank.BY_ID[task["id"]] = task
            self.custom_specs.append({**msg["task"], "id": task["id"]})
            self.save_custom_tasks()
            for w in list(self.teachers):
                await self.send(w, {"type": "catalog", "items": bank.catalog_data()})
                await self.send(w, {"type": "answerkey", "items": self.answer_key_data()})
            return await self.send(
                ws, {"type": "taskAdded", "ok": True, "id": task["id"], "title": task["title"]}
            )
        if t == "deleteTask" and msg.get("id"):
            tid = msg["id"]
            found = bank.BY_ID.get(tid)
            if not found or not found.get("custom"):
                return await self.send(
                    ws,
                    {
                        "type": "taskAdded",
                        "ok": False,
                        "error": "Удалять можно только собственные задачи.",
                    },
                )
            bank.TASKS[:] = [x for x in bank.TASKS if x["id"] != tid]
            bank.BY_ID.pop(tid, None)
            self.custom_specs = [sp for sp in self.custom_specs if sp.get("id") != tid]
            self.save_custom_tasks()
            for w in list(self.teachers):
                await self.send(w, {"type": "catalog", "items": bank.catalog_data()})
                await self.send(w, {"type": "answerkey", "items": self.answer_key_data()})
            return await self.send(ws, {"type": "taskAdded", "ok": True, "deleted": tid})
        if t == "start" and self.session["status"] == "lobby":
            ids = msg.get("taskIds")
            if isinstance(ids, list) and ids:
                seen = set()
                order = []
                for i in ids:
                    if i not in seen:
                        seen.add(i)
                        if i in bank.BY_ID:
                            order.append(bank.BY_ID[i])
                self.order = order
            else:
                self.order = self.select_tasks()
            if not self.order:
                return
            if not config.get("paramize") or config["paramize"].get("enabled") is not False:
                self.order = [bank.paramize_task(t) for t in self.order]
            self.session["test"] = bool(msg.get("test"))
            if self.session["test"]:
                self.session["id"] = "test-" + str(int(time.time() * 1000))
            else:
                self.session["id"] = db.create_session(self.current_stream)
                db.set_session_status(self.session["id"], "running")
                for nick, s in self.by_nick.items():
                    db.record_attendance(self.session["id"], nick, s["icon"], s["ip"])
            self.session["status"] = "running"
            self.intermission = False
            await self.begin_round(0)
            return
        if t == "finish" and self.session["status"] == "running":
            self._cancel_timers()
            self.intermission = False
            await self.finish_game()
            return
        if t == "pause":
            return await self.pause_round()
        if t == "resume":
            return await self.resume_round()
        if t == "skip":
            return await self.skip_round()
        if t == "addTime":
            return await self.add_round_time(
                msg["ms"] if isinstance(msg.get("ms"), (int, float)) else 15000
            )
        if t == "kick" and msg.get("nick"):
            s = self.by_nick.get(msg["nick"])
            if s:
                s["kicked"] = True
                self.round_answered.discard(s["nick"])
                for w in [w for w, st in list(self.students.items()) if st is s]:
                    await self.send(w, {"type": "kicked"})
                    self.students.pop(w, None)
                    try:
                        await w.close()
                    except Exception:
                        pass
                self.by_nick.pop(msg["nick"], None)
                await self.broadcast_teacher()
                if self.session["status"] == "running" and not self.intermission:
                    await self.maybe_end_round()
            return
        if t == "setStream" and self.session["status"] == "lobby":
            try:
                n = int(msg.get("stream"))
            except (TypeError, ValueError):
                return
            if 0 < n < 100000:
                self.current_stream = n
                try:
                    if self.session["id"] and not self.session["test"]:
                        db.set_session_stream(self.session["id"], n)
                except Exception:
                    pass
                await self.broadcast_teacher()
            return
        if t == "exportGrades":
            gcfg = config.get("gsheets") or {}
            if not gcfg.get("enabled"):
                return await self.send(
                    ws,
                    {
                        "type": "gradesExport",
                        "ok": False,
                        "error": "Выгрузка в Google Sheets выключена (gsheets.enabled).",
                    },
                )
            logins = [s["nick"] for s in self.by_nick.values() if not s["kicked"]]
            if not logins:
                return await self.send(
                    ws,
                    {"type": "gradesExport", "ok": False, "error": "Нет участников для выгрузки."},
                )
            dry = msg.get("dryRun", True) is not False  # по умолчанию «предпросмотр»
            try:
                report = await asyncio.to_thread(
                    gsheets.export_grades, gcfg, self.current_stream, logins, dry
                )
                await self.send(
                    ws, {"type": "gradesExport", "ok": True, "dryRun": dry, "report": report}
                )
            except Exception as e:
                await self.send(ws, {"type": "gradesExport", "ok": False, "error": str(e)})
            return
        if t == "reset":
            self._cancel_timers()
            self.session = {"id": None, "status": "lobby", "test": False}
            self.students.clear()
            self.by_nick.clear()
            self.order = []
            self.round = -1
            self.round_answered = set()
            self.round_perm = None
            self.intermission = False
            self.paused = False
            self.pause_remain = 0
            await self.broadcast_teacher()
            return


game = Game()

# Фоновые задачи (ротация QR, чистка nonce). Храним ссылки, чтобы их не собрал GC.
_BG_TASKS: set[asyncio.Task] = set()

# ================================================================ FastAPI
API_DESCRIPTION = """
**AlgoClimb** — соревновательная викторина по алгоритмам (в духе Kahoot).
Сервер на FastAPI, состояние игры — в памяти одного процесса (asyncio.Lock),
поэтому запускать **только один воркер** uvicorn.

Эта страница (`/docs`) описывает HTTP-ручки. Сама игра общается по **WebSocket** —
их Swagger не рисует, поэтому протокол описан ниже.

---

### Роли и экраны
| Адрес | Кто | Что |
|-------|-----|-----|
| `GET /` | студент | экран игрока (`student.html`) |
| `GET /teacher` | преподаватель | пульт управления (`teacher.html`), вход по ключу |
| `GET /answers` | преподаватель | ключ ответов по банку |
| `GET /debug` | — | лаунчер со ссылками (удобно тестить с одной машины) |

### Ключ преподавателя
Защищает пульт, ключ ответов и экспорт. Печатается в терминале при старте
(или задаётся `TEACHER_KEY` / `teacherKey` в конфиге). Студенты его не видят.

---

### WebSocket преподавателя — `ws(s)://<host>/teacher?key=<TEACHER_KEY>`
После подключения сервер шлёт `answerkey`, `catalog`, `taskTemplates`, затем `state`.
Команды от преподавателя (JSON-текст):

```jsonc
{"type":"start", "taskIds":["c1_...","c2_..."], "test":false} // test:true — НЕ писать в БД
{"type":"next"}        // следующий вопрос
{"type":"pause"}       // пауза / снятие паузы
{"type":"reset"}       // сброс в лобби
{"type":"kick", "nick":"Вася"}   // удалить игрока
```

### WebSocket студента — `ws(s)://<host>/?role=student`
```jsonc
// 1) вход
{"type":"join", "nick":"Вася", "icon":"🦊", "token":"ABC123", "nonce":"<из /api/nonce>"}
// 2) сервер отвечает одним из: joined | rejected
// 3) во время игры сервер шлёт: task | answered | roundover | paused | sessionend
// 4) ответ на вопрос
{"type":"answer", "taskId":"c1_...", "payload":{"choice":0}}   // payload зависит от типа задачи
```

В **debug**-режиме (`DEBUG=1`) вход с localhost не требует `token`/`nonce`.
При включённой ротации QR нужен свежий `token` (из QR) и одноразовый `nonce` (из `/api/nonce`).
"""

tags_metadata = [
    {"name": "Вход и доступ", "description": "Выдача одноразовых nonce, проверка доступа."},
    {"name": "Экспорт", "description": "Выгрузка аналитики (нужен ключ преподавателя)."},
    {"name": "Страницы", "description": "HTML-экраны студента, преподавателя и отладки."},
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Старт: печатаем адреса/ключ и поднимаем фоновые задачи (ротация QR, чистка nonce).
    game.build_qr()
    print(f"\n  AlgoClimb (FastAPI) запущен · хранилище: {db.backend} · банк: {bank.BANK_SOURCE}")
    print(
        f"  КЛЮЧ ПРЕПОДАВАТЕЛЯ: {TEACHER_KEY}  (введите на экране учителя; НЕ показывайте студентам)"
    )
    print(f"  Преподаватель: http://localhost:{PORT}/teacher")
    for ip in local_ips():
        print(f"  Студенты:      http://{ip}:{PORT}/")

    async def qr_loop():
        while config["qrRotation"].get("enabled"):
            await asyncio.sleep(sec._interval_ms() / 1000)
            async with game.lock:
                game.build_qr()
                await game.broadcast_teacher()

    async def nonce_loop():
        while True:
            await asyncio.sleep(60)
            sec.sweep()

    # Держим ссылки на фоновые задачи, иначе сборщик мусора может их прервать.
    if config["qrRotation"].get("enabled"):
        _BG_TASKS.add(asyncio.create_task(qr_loop()))
    _BG_TASKS.add(asyncio.create_task(nonce_loop()))

    yield

    # Остановка: гасим фоновые задачи, чтобы не висли при перезапуске.
    for t in _BG_TASKS:
        t.cancel()
    _BG_TASKS.clear()


# Swagger (/docs, /redoc, /openapi.json) показываем только в debug-режиме или при
# явном DOCS=1 — чтобы на реальном занятии студенты не видели описание API.
_show_docs = config["debug"].get("enabled") or os.environ.get("DOCS") == "1"

app = FastAPI(
    title="AlgoClimb API",
    version="1.0.0",
    description=API_DESCRIPTION,
    openapi_tags=tags_metadata,
    contact={"name": "AlgoClimb"},
    lifespan=lifespan,
    docs_url="/docs" if _show_docs else None,
    redoc_url="/redoc" if _show_docs else None,
    openapi_url="/openapi.json" if _show_docs else None,
)


def client_ip(scope_client, headers):
    xff = headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip().replace("::ffff:", "")
    return (scope_client[0] if scope_client else "").replace("::ffff:", "")


# ---------------------------------------------------------------- HTTP-маршруты
@app.get(
    "/api/nonce",
    tags=["Вход и доступ"],
    summary="Выдать одноразовый nonce для входа студента",
    description=(
        "Возвращает свежий `nonce` (живёт ~2 минуты, сгорает после первого входа) и "
        "`serverTime` для синхронизации таймеров. Экран студента дёргает это перед `join`. "
        "Доступ ограничен IP-allowlist'ом (если включён); с localhost в debug — всегда разрешён."
    ),
    responses={
        200: {
            "description": "Nonce выдан",
            "content": {
                "application/json": {
                    "example": {"nonce": "x7Kq9fLp2mAb", "serverTime": 1738000000000}
                }
            },
        },
        403: {"description": "Доступ только из сети вуза"},
    },
)
async def api_nonce(request: Request):
    if not ip_allowed(config, client_ip(request.scope.get("client"), request.headers)) and not (
        config["debug"].get("enabled")
        and is_loopback(client_ip(request.scope.get("client"), request.headers))
    ):
        return PlainTextResponse("Доступ только из сети вуза", status_code=403)
    return JSONResponse(
        {"nonce": sec.issue_nonce(), "serverTime": int(time.time() * 1000)},
        headers={"Cache-Control": "no-store"},
    )


@app.get(
    "/export/analytics.xlsx",
    tags=["Экспорт"],
    summary="Выгрузить аналитику в Excel (.xlsx)",
    description=(
        "Отдаёт файл аналитики за занятие. Нужен `key` — ключ преподавателя. "
        "Необязательный `stream` фильтрует по номеру потока."
    ),
    responses={
        200: {
            "description": "XLSX-файл",
            "content": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {}},
        },
        403: {"description": "Нужен ключ преподавателя"},
        500: {"description": "Ошибка экспорта"},
    },
)
async def export_xlsx(
    key: str = Query("", description="Ключ преподавателя"),
    stream: str | None = Query(None, description="Номер потока (необязательно)"),
):
    if key.strip() != TEACHER_KEY:
        return PlainTextResponse("Нужен ключ преподавателя", status_code=403)
    try:
        from analytics import build_xlsx

        buf = build_xlsx(analytics_sheets(stream, AC))
        fname = f"algoclimb-аналитика-{time.strftime('%Y-%m-%d')}.xlsx"
        from urllib.parse import quote

        return Response(
            content=buf,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"},
        )
    except Exception as e:
        return PlainTextResponse("Ошибка экспорта: " + str(e), status_code=500)


@app.get(
    "/debug",
    response_class=HTMLResponse,
    tags=["Страницы"],
    summary="Лаунчер отладки",
    description=(
        "HTML со ссылками на экраны студента/преподавателя/ключа ответов. "
        "При `DEBUG=1` и заходе с localhost показывает ключ преподавателя."
    ),
)
async def debug_page(request: Request):
    ip = client_ip(request.scope.get("client"), request.headers)
    show_key = bool(config["debug"].get("enabled") and is_loopback(ip))
    on = config["debug"].get("enabled")
    key_block = (
        f'<div class="key"><span class="lab">Ключ преподавателя</span><code id="k">{TEACHER_KEY}</code>'
        "<button onclick=\"navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('k').textContent)\">копировать</button></div>"
        if (on and show_key)
        else '<p class="muted">Ключ преподавателя показывается только при включённом debug и заходе с этой машины. Его печатает терминал сервера.</p>'
    )
    off_warn = (
        ""
        if on
        else (
            '<div class="warn">Режим отладки <b>выключен</b>. Запустите <code>DEBUG=1</code>, '
            "чтобы заходить студентом с localhost без кода.</div>"
        )
    )
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AlgoClimb — отладка</title>
<style>
  :root{{--bg:#08111f;--panel:#102544;--panel2:#0c1c34;--line:#1d3a63;--accent:#ffd23f;--blue:#5aa9ff;--text:#e8eef7;--muted:#8195b4}}
  *{{box-sizing:border-box}}body{{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
    background:radial-gradient(1200px 700px at 70% -10%,#14385f,#0c1d36 45%,#08111f);color:var(--text);min-height:100vh}}
  .wrap{{max-width:760px;margin:0 auto;padding:26px}}
  .logo{{font-weight:800;font-size:24px;margin-bottom:2px}}.logo b{{color:var(--accent)}}
  .tag{{font-size:13px;color:var(--muted);margin-bottom:20px}}
  .grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
  a.card{{display:block;text-decoration:none;color:var(--text);background:linear-gradient(180deg,var(--panel),var(--panel2));
    border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;transition:.15s}}
  a.card:hover{{border-color:var(--accent);transform:translateY(-2px)}}
  .card .h{{font-weight:800;font-size:17px;margin-bottom:4px}}
  .card .d{{font-size:13px;color:var(--muted);line-height:1.4}}
  .card.wide{{grid-column:1/-1}}
  .key{{margin:20px 0 6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#0c1c34;border:1px solid var(--line);border-radius:12px;padding:12px 14px}}
  .key .lab{{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800}}
  .key code{{font-size:20px;letter-spacing:2px;color:var(--accent);font-weight:800}}
  .key button{{margin-left:auto;background:var(--accent);color:#10243f;border:none;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer}}
  .muted{{color:var(--muted);font-size:13px}}
  .warn{{background:#3a2a16;border:1px solid #6b4b2b;border-radius:10px;padding:12px 14px;color:#ffd9a0;font-size:13px;margin:16px 0}}
  .hint{{margin-top:18px;font-size:13px;color:var(--muted);line-height:1.5}}
  code{{background:#0a1830;border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:#bfe0ff}}
</style></head><body><div class="wrap">
  <div class="logo">Algo<b>Climb</b> · отладка</div>
  <div class="tag">Открывай экраны на этой машине по разным адресам. Ссылки открываются в новой вкладке.</div>
  {off_warn}
  <div class="grid">
    <a class="card" href="/teacher" target="_blank"><div class="h">🎛 Преподаватель</div><div class="d">Управление игрой, старт, аналитика, ключ ответов. Вход по ключу.</div></a>
    <a class="card" href="/" target="_blank"><div class="h">🧑‍🎓 Студент</div><div class="d">Экран игрока. В debug заходит с localhost без кода.</div></a>
    <a class="card wide" href="/answers" target="_blank"><div class="h">🔑 Ключ ответов</div><div class="d">Правильные ответы по банку (для преподавателя).</div></a>
  </div>
  {key_block}
</div></body></html>"""
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def _serve(rel):
    p = (PUBLIC / rel).resolve()
    if not str(p).startswith(str(PUBLIC.resolve())) or not p.is_file():
        return PlainTextResponse("not found", status_code=404)
    return Response(
        content=p.read_bytes(), media_type=_MIME.get(p.suffix, "application/octet-stream")
    )


@app.get(
    "/",
    tags=["Страницы"],
    summary="Экран студента",
    description="HTML экрана игрока (`student.html`). Дальше общение идёт по WebSocket `/`.",
)
async def root_page():
    return _serve("student.html")


@app.get(
    "/teacher",
    tags=["Страницы"],
    summary="Пульт преподавателя",
    description="HTML пульта (`teacher.html`). Управление идёт по WebSocket `/teacher?key=...`.",
)
async def teacher_page():
    return _serve("teacher.html")


@app.get(
    "/answers",
    tags=["Страницы"],
    summary="Ключ ответов",
    description="HTML со списком правильных ответов по банку задач (`answers.html`).",
)
async def answers_page():
    return _serve("answers.html")


@app.get("/{path:path}", include_in_schema=False)
async def static_files(path: str):
    return _serve(path)


# ---------------------------------------------------------------- WebSocket
@app.websocket("/teacher")
async def teacher_ws(ws: WebSocket):
    await ws.accept()
    key = (ws.query_params.get("key") or "").strip()
    if key != TEACHER_KEY:
        await game.send(ws, {"type": "rejected", "reason": "Неверный ключ преподавателя."})
        await ws.close()
        return
    game.teachers.add(ws)
    await game.send(ws, {"type": "answerkey", "items": game.answer_key_data()})
    await game.send(ws, {"type": "catalog", "items": bank.catalog_data()})
    await game.send(ws, {"type": "taskTemplates", "graph": bank.graph_template_list()})
    async with game.lock:
        await game.broadcast_teacher()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            async with game.lock:
                await game.handle_teacher(ws, msg)
    except WebSocketDisconnect:
        game.teachers.discard(ws)
    except Exception:
        game.teachers.discard(ws)


@app.websocket("/")
async def student_ws(ws: WebSocket):
    await ws.accept()
    ip = client_ip(ws.scope.get("client"), ws.headers)
    if (
        config["ipAllowlist"].get("enabled")
        and not ip_allowed(config, ip)
        and not (config["debug"].get("enabled") and is_loopback(ip))
    ):
        await game.send(
            ws, {"type": "rejected", "reason": "Подключение разрешено только из сети вуза."}
        )
        await ws.close()
        return
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            async with game.lock:
                await game.handle_student(ws, msg, ip)
    except WebSocketDisconnect:
        async with game.lock:
            await game.on_student_disconnect(ws)
    except Exception:
        async with game.lock:
            await game.on_student_disconnect(ws)
