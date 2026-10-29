"""Isolated reliability benchmark: real WebSockets, SQLite writes and connection loss.

Starts its own server on loopback with generated public fixtures and temporary data.
Never connects to an existing application or reads a private question bank.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import resource
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parents[1]


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {"samples": 0, "p50_ms": None, "p95_ms": None, "p99_ms": None, "max_ms": None}
    return {
        "samples": len(ordered),
        **{
            f"p{p}_ms": round(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * p / 100))], 2)
            for p in (50, 95, 99)
        },
        "max_ms": round(ordered[-1], 2),
    }


def fixtures(count):
    templates = [
        {"type": "choice", "options": ["FIFO", "LIFO"], "answer": 1},
        {
            "type": "graph",
            "nodes": ["A", "B", "C"],
            "requiredEdges": [["A", "B"], ["B", "C"], ["A", "C"]],
        },
        {
            "type": "order",
            "nodes": ["A", "B", "C", "D"],
            "edges": [["A", "B"], ["A", "C"], ["B", "D"]],
            "start": "A",
            "mode": "bfs",
        },
        {"type": "sort", "array": [3, 1, 2], "algo": "bubble", "steps": 1, "expected": [1, 2, 3]},
        {"type": "blank", "template": "Stack: ___", "blanks": [{"answer": "LIFO"}]},
    ]
    return [
        {
            **templates[i % 5],
            "id": f"bench_{i:03d}",
            "level": 1,
            "topic": "Public benchmark",
            "title": f"Benchmark {i + 1}",
            "prompt": f"Public reliability fixture {i + 1}",
        }
        for i in range(count)
    ]


def answer(task):
    kind = task["type"]
    if kind == "choice":
        return {"choice": task["options"].index("LIFO")}
    if kind == "graph":
        return {"edges": [["A", "B"], ["B", "C"], ["A", "C"]]}
    if kind == "order":
        return {"order": ["A", "B", "C", "D"]}
    if kind == "sort":
        return {"array": [1, 2, 3]}
    return {"blanks": ["LIFO"]}


def http_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


async def send(ws, kind, **fields):
    await ws.send(json.dumps({"type": kind, **fields}))


class Student:
    def __init__(self, idx, run):
        self.idx = idx
        self.run = run
        self.nick = f"Benchmark participant with a long name {idx:03d}"
        self.first_join = asyncio.Event()
        self.jobs = set()
        self.received = set()
        self.confirmed = set()
        self.awarded_points = {}
        self.pending = {}
        self.forced = set()
        self.intentional = False
        self.lost_at = None
        self.end = None
        self.restores = []
        self.latencies = []
        self.interrupted_answers = set()
        self.restored_latencies = []
        self.unexpected_drops = 0
        self.reconnect_attempts = 0
        self.wire_submissions = 0
        self.errors = []

    async def submit(self, ws, message):
        task = message["task"]
        tid = task["id"]
        try:
            await asyncio.sleep(
                self.run.args.answer_delay if self.idx else self.run.args.recovery_grace
            )
            if tid in self.confirmed:
                return
            round_idx = message["index"]
            # Deterministic losses, away from the final round. Student 0 holds the
            # round open long enough for interrupted clients to recover and answer.
            before = self.idx % 5 == 1 and round_idx % 7 == 3
            after = self.idx % 7 == 2 and round_idx % 11 == 5
            fault = self.run.args.disconnects and (before or after) and tid not in self.forced
            if fault and before:
                self.interrupt(ws, tid)
                return
            self.pending[tid] = time.perf_counter()
            await send(ws, "answer", taskId=tid, payload=answer(task))
            self.wire_submissions += 1
            if fault and after:
                self.interrupt(ws, tid)
        except websockets.ConnectionClosed:
            pass  # The receive loop records the disconnect and restores this client.
        except Exception as error:
            self.errors.append(f"submit: {type(error).__name__}: {error}")

    def interrupt(self, ws, tid):
        self.forced.add(tid)
        if tid in self.pending:
            self.interrupted_answers.add(tid)
        self.intentional = True
        self.lost_at = time.perf_counter()
        ws.transport.abort()

    async def consume(self, ws):
        async for raw in ws:
            message = json.loads(raw)
            kind = message.get("type")
            if kind == "joined":
                self.first_join.set()
            elif kind == "rejected":
                self.errors.append("join rejected: " + message.get("reason", "unknown"))
                return
            elif kind == "task":
                tid = message["task"]["id"]
                self.received.add(tid)
                if self.lost_at is not None:
                    self.restores.append((time.perf_counter() - self.lost_at) * 1000)
                    self.lost_at = None
                if tid not in self.confirmed:
                    job = asyncio.create_task(self.submit(ws, message))
                    self.jobs.add(job)
                    job.add_done_callback(self.jobs.discard)
            elif kind == "answered":
                # The server restores the current task before its saved answer.
                # There is at most one unacknowledged round for this synchronous game.
                tid = self.run.task_ids[max(self.received_index())]
                if tid not in self.confirmed:
                    self.confirmed.add(tid)
                    self.awarded_points[tid] = message["points"]
                    if tid in self.pending:
                        elapsed = (time.perf_counter() - self.pending.pop(tid)) * 1000
                        (
                            self.restored_latencies
                            if tid in self.interrupted_answers
                            else self.latencies
                        ).append(elapsed)
                if not message["correct"]:
                    self.errors.append(f"incorrect fixture answer: {tid}")
            elif kind == "answerRejected":
                self.errors.append(f"answer rejected: {message['taskId']}: {message['reason']}")
            elif kind == "sessionend":
                self.end = message
                return

    def received_index(self):
        return [self.run.task_ids.index(tid) for tid in self.received]

    async def run_client(self):
        while not self.run.finished.is_set() and self.end is None:
            self.intentional = False
            try:
                async with websockets.connect(
                    self.run.ws_url + "/", open_timeout=10, ping_interval=None, max_queue=128
                ) as ws:
                    fields = {"nick": self.nick, "icon": "🦉"}
                    if not self.first_join.is_set() and self.run.args.qr:
                        fields["nonce"] = (
                            await asyncio.to_thread(http_json, self.run.http_url + "/api/nonce")
                        )["nonce"]
                        fields["token"] = self.run.token
                    await send(ws, "join", **fields)
                    await self.consume(ws)
                    if self.end is not None or self.errors:
                        return
                    if not self.intentional:
                        self.unexpected_drops += 1
                        self.lost_at = time.perf_counter()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if not self.first_join.is_set():
                    self.errors.append(f"initial connection: {type(error).__name__}: {error}")
                    return
                if not self.intentional:
                    self.unexpected_drops += 1
                    self.lost_at = time.perf_counter()
            finally:
                for job in list(self.jobs):
                    job.cancel()
                await asyncio.gather(*self.jobs, return_exceptions=True)
                self.jobs.clear()
            if self.end is None:
                self.reconnect_attempts += 1
                await asyncio.sleep(self.run.args.outage)


class Run:
    def __init__(self, args, root, port):
        self.args, self.root = args, root
        self.http_url = f"http://127.0.0.1:{port}"
        self.ws_url = f"ws://127.0.0.1:{port}"
        self.token = None
        self.task_ids = [t["id"] for t in fixtures(args.rounds)]
        self.finished = asyncio.Event()
        self.teacher_finished = asyncio.Event()
        self.students = [Student(i, self) for i in range(args.students)]
        self.health_latencies = []
        self.health_errors = []
        self.teacher_errors = []

    async def teacher_reader(self, ws):
        try:
            async for raw in ws:
                message = json.loads(raw)
                if message.get("type") == "state":
                    self.token = message.get("token")
                    if message["session"]["status"] == "finished":
                        self.teacher_finished.set()
                elif message.get("type") == "rejected":
                    self.teacher_errors.append(message.get("reason", "teacher rejected"))
                    return
        except Exception as error:
            if not self.finished.is_set():
                self.teacher_errors.append(f"{type(error).__name__}: {error}")

    async def health_monitor(self):
        while not self.finished.is_set():
            started = time.perf_counter()
            try:

                def health():
                    with urllib.request.urlopen(self.http_url + "/healthz", timeout=3) as response:
                        return response.status

                if await asyncio.to_thread(health) != 200:
                    raise RuntimeError("non-200 health status")
                self.health_latencies.append((time.perf_counter() - started) * 1000)
            except Exception as error:
                self.health_errors.append(f"{type(error).__name__}: {error}")
            await asyncio.sleep(0.2)

    async def execute(self, key):
        async with websockets.connect(
            self.ws_url + "/teacher?key=" + key, max_queue=128, ping_interval=None
        ) as teacher:
            # Consume the initial catalog/state before taking a potentially rotating code.
            while True:
                message = json.loads(await asyncio.wait_for(teacher.recv(), timeout=10))
                if message.get("type") == "state":
                    self.token = message.get("token")
                    break
            reader = asyncio.create_task(self.teacher_reader(teacher))
            monitor = asyncio.create_task(self.health_monitor())
            clients = [asyncio.create_task(student.run_client()) for student in self.students]
            try:
                await asyncio.wait_for(
                    asyncio.gather(*(s.first_join.wait() for s in self.students)), timeout=25
                )
                print(
                    f"Joined {len(self.students)} students; idle for {self.args.idle}s", flush=True
                )
                await asyncio.sleep(self.args.idle)
                await send(teacher, "start", taskIds=self.task_ids, test=False)
                await asyncio.wait_for(asyncio.gather(*clients), timeout=self.args.timeout)
                await asyncio.wait_for(self.teacher_finished.wait(), timeout=5)
            finally:
                self.finished.set()
                for task in [*clients, reader, monitor]:
                    task.cancel()
                await asyncio.gather(*clients, reader, monitor, return_exceptions=True)

    def report(self, duration, error):
        counts = dict.fromkeys(("attendance", "answers", "results"), 0)
        stored_scores = {}
        if (self.root / "runtime/algoclimb.db").exists():
            with sqlite3.connect(self.root / "runtime/algoclimb.db") as conn:
                counts = {
                    table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    for table in counts
                }
                stored_scores = dict(conn.execute("SELECT nick, total FROM results"))
        expected = self.args.students * self.args.rounds
        finished = [s for s in self.students if s.end is not None]
        correct_reviews = sum(
            bool(s.end)
            and s.end["correct"] == self.args.rounds
            and len(s.end["review"]) == self.args.rounds
            and all(r["answered"] and r["correct"] for r in s.end["review"])
            for s in self.students
        )
        consistent_scores = sum(
            s.end is not None
            and len(s.awarded_points) == self.args.rounds
            and sum(s.awarded_points.values()) == s.end["score"] == stored_scores.get(s.nick)
            for s in self.students
        )
        errors = [error] if error else []
        errors += self.teacher_errors + self.health_errors
        errors += [f"student {s.idx}: {e}" for s in self.students for e in s.errors]
        confirmed = sum(len(s.confirmed) for s in self.students)
        received = sum(len(s.received) for s in self.students)
        planned = sum(len(s.forced) for s in self.students)
        restored = sum(len(s.restores) for s in self.students)
        drops = sum(s.unexpected_drops for s in self.students)
        passed = (
            not errors
            and len(finished) == self.args.students
            and correct_reviews == self.args.students
            and consistent_scores == self.args.students
            and confirmed == expected
            and received == expected
            and drops == 0
            and restored == planned
            and counts
            == {
                "attendance": self.args.students,
                "answers": expected,
                "results": self.args.students,
            }
        )
        latencies = distribution([v for s in self.students for v in s.latencies])
        restores = distribution([v for s in self.students for v in s.restores])
        health = distribution(self.health_latencies)
        budgets = {
            "answer_p99_under_1000ms": latencies["p99_ms"] is not None
            and latencies["p99_ms"] < 1000,
            "restore_max_under_3000ms": not planned
            or (restores["max_ms"] is not None and restores["max_ms"] < 3000),
            "health_p99_under_500ms": health["p99_ms"] is not None and health["p99_ms"] < 500,
        }
        return {
            "passed": passed and all(budgets.values()),
            "functional_checks_passed": passed,
            "latency_budgets": budgets,
            "scope": "isolated loopback server; synthetic clients; not a Wi-Fi guarantee",
            "students": self.args.students,
            "rounds": self.args.rounds,
            "qr_rotation": self.args.qr,
            "idle_seconds": self.args.idle,
            "duration_seconds": round(duration, 2),
            "students_finished": len(finished),
            "complete_correct_reviews": correct_reviews,
            "consistent_scores": consistent_scores,
            "unique_tasks_received": received,
            "expected_answers": expected,
            "unique_answers_confirmed": confirmed,
            "wire_submissions": sum(s.wire_submissions for s in self.students),
            "intentional_disconnects": planned,
            "successful_restorations": restored,
            "reconnect_attempts": sum(s.reconnect_attempts for s in self.students),
            "unexpected_disconnects": drops,
            "sqlite_records": counts,
            "answer_confirmation": latencies,
            "interrupted_answer_confirmation": distribution(
                [v for s in self.students for v in s.restored_latencies]
            ),
            "connection_restore": restores,
            "health_response": health,
            "errors": errors,
        }


async def benchmark(args):
    with tempfile.TemporaryDirectory(prefix="algoclimb-reliability-") as folder:
        root = Path(folder)
        config = json.loads((ROOT / "backend/config/config.example.json").read_text())
        config.update(
            timeLimits={"choice": 5, "graph": 5},
            revealMs=75,
            paramize={"enabled": False},
            antiCheat={"fastMs": 0, "suspectThreshold": 4},
            qrRotation={"enabled": args.qr, "intervalSec": 1, "graceWindows": 2},
        )
        (root / "config.json").write_text(json.dumps(config))
        (root / "bank.json").write_text(json.dumps(fixtures(args.rounds)))
        (root / "explanations.json").write_text("{}")
        key = secrets.token_urlsafe(18)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {
            **os.environ,
            "CONFIG_PATH": str(root / "config.json"),
            "TASK_BANK_PATH": str(root / "bank.json"),
            "EXPLANATIONS_PATH": str(root / "explanations.json"),
            "RUNTIME_DIR": str(root / "runtime"),
            "TEACHER_KEY": key,
            "DEBUG": "0",
            "GSHEETS": "0",
            "QR_ROTATION": "1" if args.qr else "0",
        }
        with (root / "server.log").open("w+") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "main:app",
                    "--app-dir",
                    str(ROOT / "backend"),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--ws",
                    "wsproto",
                    "--no-access-log",
                ],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            run = Run(args, root, port)
            error = None
            started = time.perf_counter()
            usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
            try:
                for _ in range(100):
                    try:

                        def ready():
                            with urllib.request.urlopen(run.http_url + "/healthz", timeout=0.2):
                                return True

                        await asyncio.to_thread(ready)
                        break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError("Test server exited during startup") from None
                        await asyncio.sleep(0.05)
                await run.execute(key)
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
            finally:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    await asyncio.to_thread(process.wait)
            report = run.report(time.perf_counter() - started, error)
            usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu_seconds = (
                usage_after.ru_utime
                + usage_after.ru_stime
                - usage_before.ru_utime
                - usage_before.ru_stime
            )
            report["server_cpu_seconds"] = round(cpu_seconds, 2)
            report["server_cpu_average_percent_of_one_core"] = round(
                cpu_seconds / report["duration_seconds"] * 100, 2
            )
            report["server_peak_rss_mb"] = round(
                usage_after.ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024), 2
            )
            # Bound diagnostics and redact the generated teacher key.
            if not report["passed"]:
                log.seek(0)
                report["server_log_tail"] = log.read()[-12000:].replace(key, "[local test key]")
            return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--students", type=int, default=72)
    parser.add_argument("--rounds", type=int, default=30)
    parser.add_argument("--idle", type=float, default=5)
    parser.add_argument("--disconnects", action="store_true")
    parser.add_argument("--qr", action="store_true", help="Rotate admission QR every second")
    parser.add_argument("--outage", type=float, default=0.25)
    parser.add_argument("--answer-delay", type=float, default=0.1)
    parser.add_argument("--recovery-grace", type=float, default=1)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 2 <= args.students <= 500 or not 1 <= args.rounds <= 100:
        parser.error("Use 2–500 students and 1–100 rounds")
    if min(args.idle, args.outage, args.answer_delay) < 0 or not 0 < args.recovery_grace < 4:
        parser.error(
            "Durations must be nonnegative; recovery grace must be between 0 and 4 seconds"
        )
    report = asyncio.run(benchmark(args))
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    print(serialized)
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
