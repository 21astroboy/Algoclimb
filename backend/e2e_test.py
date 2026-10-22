"""Run real HTTP/WebSocket tests against an isolated server and a public task bank.

Usage: python -m e2e_test (from backend/). Never connects to the deployed server.
"""

import asyncio
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import websockets

BASE_DIR = Path(__file__).resolve().parent
KEY = "LOCAL-E2E-ONLY"


async def receive(ws, kind, predicate=lambda _: True, timeout=5):
    async def read():
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("type") == kind and predicate(msg):
                return msg

    return await asyncio.wait_for(read(), timeout)


async def send(ws, kind, **fields):
    await ws.send(json.dumps({"type": kind, **fields}))


class SessionTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="algoclimb-e2e-")
        cls.root = Path(cls.temp.name)
        cls.tasks = json.loads((BASE_DIR / "data/task-bank.example.json").read_text())
        cls.tasks.append(
            {
                "id": "test_blank",
                "type": "blank",
                "topic": "tests",
                "level": 1,
                "title": "Unicode: проверка",
                "prompt": "Стек: ___",
                "template": "Стек: ___",
                "blanks": [{"answer": "LIFO"}],
            }
        )
        (cls.root / "bank.json").write_text(json.dumps(cls.tasks))
        cfg = json.loads((BASE_DIR / "config/config.example.json").read_text())
        cfg.update(
            timeLimits={"choice": 1.5, "graph": 1.5},
            revealMs=60,
            paramize={"enabled": False},
            debug={"enabled": False},
        )
        (cls.root / "config.json").write_text(json.dumps(cfg))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.url = f"ws://127.0.0.1:{cls.port}"
        env = {
            **os.environ,
            "TEACHER_KEY": KEY,
            "QR_ROTATION": "0",
            "DEBUG": "0",
            "GSHEETS": "0",
            "CONFIG_PATH": str(cls.root / "config.json"),
            "TASK_BANK_PATH": str(cls.root / "bank.json"),
            "RUNTIME_DIR": str(cls.root / "runtime"),
            "EXPLANATIONS_PATH": str(cls.root / "no-explanations.json"),
        }
        cls.log = (cls.root / "server.log").open("w+")
        cls.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(cls.port),
                "--ws",
                "wsproto",
            ],
            cwd=BASE_DIR,
            env=env,
            stdout=cls.log,
            stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                if cls.process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{cls.port}/healthz", timeout=0.2
                    ):
                        return
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.05)
            cls.log.seek(0)
            raise RuntimeError("Test server did not start: " + cls.log.read())
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait()
        cls.log.close()
        cls.temp.cleanup()

    async def asyncSetUp(self):
        self.connections = []
        self.teacher = await self.connect("/teacher?key=" + KEY)
        await receive(self.teacher, "state")
        await send(self.teacher, "reset")
        await receive(self.teacher, "state", lambda m: m["session"]["status"] == "lobby")

    async def asyncTearDown(self):
        await send(self.teacher, "reset")
        await receive(self.teacher, "state", lambda m: m["session"]["status"] == "lobby")
        for ws in self.connections:
            await ws.close()

    async def connect(self, path="/"):
        ws = await websockets.connect(self.url + path)
        self.connections.append(ws)
        return ws

    async def join(self, nick="Alice"):
        ws = await self.connect()
        await send(ws, "join", nick=nick, icon="🦊")
        msg = await receive(ws, "joined")
        self.assertEqual(msg["nick"], nick)
        return ws

    async def start(self, student, ids, practice=True):
        await send(self.teacher, "start", taskIds=ids, test=practice)
        return (await receive(student, "task"))["task"]

    def correct(self, task):
        source = next(t for t in self.tasks if t["id"] == task["id"])
        kind = task["type"]
        if kind == "choice":
            return {"choice": task["options"].index(source["options"][source["answer"]])}
        if kind == "graph":
            return {"edges": source["requiredEdges"]}
        if kind == "order":
            return {"order": ["A", "B", "C", "D", "E"]}
        if kind == "sort":
            return {"array": source["expected"]}
        return {"blanks": ["LIFO"]}

    async def test_lifecycle_reconnect_and_persistence(self):
        student = await self.join()
        ids = ["demo_stack", "demo_triangle", "demo_bfs", "demo_bubble", "test_blank"]
        task = await self.start(student, ids, practice=False)
        self.assertNotIn("answer", task)
        self.assertTrue(any("Стек" in t["title"] for t in self.tasks))
        for idx, task_id in enumerate(ids):
            self.assertEqual(task["id"], task_id)
            if idx == 1:
                await student.close()
                student = await self.join()
                restored = await receive(student, "task")
                self.assertEqual(restored["index"], idx)
            await send(student, "answer", taskId=task_id, payload=self.correct(task))
            answer = await receive(student, "answered")
            self.assertTrue(answer["correct"], task_id)
            self.assertGreater(answer["points"], 0)
            if idx < len(ids) - 1:
                task = (await receive(student, "task"))["task"]
        end = await receive(student, "sessionend")
        self.assertEqual(end["correct"], len(ids))
        self.assertEqual(len(end["review"]), len(ids))
        self.assertIn("Стек", end["review"][0]["title"])
        with sqlite3.connect(self.root / "runtime/algoclimb.db") as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM answers").fetchone()[0], len(ids))
            self.assertEqual(conn.execute("SELECT count(*) FROM results").fetchone()[0], 1)

    async def test_pause_invalid_payload_retry_and_duplicate(self):
        student = await self.join()
        task = await self.start(student, ["demo_stack", "demo_triangle"])
        await send(self.teacher, "pause")
        await receive(student, "paused")
        await send(student, "answer", taskId=task["id"], payload=self.correct(task))
        self.assertEqual((await receive(student, "answerRejected"))["reason"], "paused")
        await send(self.teacher, "resume")
        await receive(student, "resumed")
        for payload in (None, [], {"choice": -1}, {"choice": 100}, {"choice": True}):
            await send(student, "answer", taskId=task["id"], payload=payload)
            self.assertEqual(
                (await receive(student, "answerRejected"))["reason"], "invalid_payload"
            )
        await student.send("[]")
        await student.send("null")
        await student.send("{not json")
        await send(student, "answer", taskId=task["id"], payload=self.correct(task))
        answer = await receive(student, "answered")
        self.assertEqual(answer["streak"], 1)
        await send(student, "answer", taskId=task["id"], payload=self.correct(task))
        graph = (await receive(student, "task"))["task"]
        for edges in ([["A"]], [[{}, "B"]], [["unknown", "A"]]):
            await send(student, "answer", taskId=graph["id"], payload={"edges": edges})
            self.assertEqual(
                (await receive(student, "answerRejected"))["reason"], "invalid_payload"
            )
        await send(student, "answer", taskId=graph["id"], payload=self.correct(graph))
        self.assertTrue((await receive(student, "answered"))["correct"])
        end = await receive(student, "sessionend")
        self.assertEqual(end["correct"], 2)

    async def test_deadline_and_automatic_finish(self):
        student = await self.join()
        task = await self.start(student, ["demo_stack"])
        # Pause freezes remaining time; resume supplies the actual server deadline.
        await send(self.teacher, "pause")
        await receive(student, "paused")
        await send(self.teacher, "resume")
        timing = await receive(student, "resumed")
        delay = (timing["deadline"] - timing["serverTime"]) / 1000 + 0.04
        await asyncio.sleep(delay)
        await send(student, "answer", taskId=task["id"], payload=self.correct(task))
        rejected = await receive(student, "answerRejected")
        self.assertEqual(rejected["reason"], "expired")
        end = await receive(student, "sessionend")
        self.assertEqual(end["score"], 0)
        self.assertFalse(end["review"][0]["answered"])

    async def test_teacher_key_is_required(self):
        intruder = await self.connect("/teacher?key=incorrect")
        self.assertEqual((await receive(intruder, "rejected"))["type"], "rejected")

    async def test_added_time_replaces_the_original_deadline(self):
        student = await self.join()
        task = await self.start(student, ["demo_stack"])
        await send(self.teacher, "addTime", ms=2000)
        await receive(student, "addtime")
        # The original round timeout would have fired at 1.9s (including grace).
        await asyncio.sleep(2.05)
        await send(student, "answer", taskId=task["id"], payload=self.correct(task))
        self.assertTrue((await receive(student, "answered"))["correct"])
        self.assertEqual((await receive(student, "sessionend"))["correct"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
