"""Regressions for students dropping out of a live session (reconnects, dead sockets)."""

import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

import main

TASK = {
    "id": "recovery-choice",
    "type": "choice",
    "title": "Test",
    "prompt": "Pick B",
    "options": ["A", "B"],
    "answer": 1,
    "level": 1,
}


class FakeWS:
    def __init__(self, fail=False):
        self.scope = {}
        self.sent = []
        self.fail = fail
        self.closed = False

    async def send_text(self, text):
        if self.fail:
            raise ConnectionError("peer is gone")
        self.sent.append(json.loads(text))

    async def close(self, code=1000):
        self.closed = True

    def of_type(self, kind):
        return [m for m in self.sent if m["type"] == kind]


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.game = main.Game()
        self.game.broadcast_teacher = AsyncMock()

    async def asyncTearDown(self):
        self.game._cancel_timers()
        await asyncio.gather(*self.game._closers, return_exceptions=True)

    async def join(self, ws, nick="Student", **fields):
        await self.game.handle_student(ws, {"type": "join", "nick": nick, **fields}, "10.0.0.5")
        return ws.sent[-1]

    def start_round(self):
        self.game.session.update(status="running", test=True)
        self.game.order = [TASK]
        self.game.round = 0
        self.game.round_perm = [0, 1]
        self.game.round_deadline = int(time.time() * 1000) + 30000

    async def answer(self, ws):
        await self.game.handle_student(
            ws, {"type": "answer", "taskId": TASK["id"], "payload": {"choice": 1}}, "10.0.0.5"
        )

    async def test_reconnect_needs_resume_secret_or_fresh_qr(self):
        with patch.dict(main.config["qrRotation"], enabled=True):
            first = FakeWS()
            joined = await self.join(
                first, token=main.sec.current_token(), nonce=main.sec.issue_nonce()
            )
            self.assertEqual(joined["type"], "joined")
            secret = joined["resume"]
            self.assertTrue(secret)
            await self.game.on_student_disconnect(first)

            # Knowing a classmate's nickname is no longer enough.
            intruder = FakeWS()
            self.assertEqual((await self.join(intruder))["type"], "rejected")
            self.assertNotIn(intruder, self.game.students)

            # The browser that joined restores the session with its secret.
            again = FakeWS()
            restored = await self.join(again, resume=secret)
            self.assertEqual(restored["type"], "joined")
            self.assertEqual(restored["resume"], secret)

            # A different device can still recover by scanning the current QR code.
            other = FakeWS()
            rescan = await self.join(
                other, token=main.sec.current_token(), nonce=main.sec.issue_nonce()
            )
            self.assertEqual(rescan["type"], "joined")

    async def test_automatic_resume_fails_quietly_without_matching_participant(self):
        ws = FakeWS()
        reply = await self.join(ws, nick="Nobody", resume="stale", auto=True)
        self.assertEqual(reply["type"], "rejected")
        self.assertEqual(reply["code"], "resume_failed")
        self.assertNotIn("Nobody", self.game.by_nick)

    async def test_participant_restored_from_old_snapshot_reconnects_without_secret(self):
        with patch.dict(main.config["qrRotation"], enabled=True):
            self.game.by_nick["Legacy"] = {
                "nick": "Legacy",
                "icon": "🦊",
                "ip": "",
                "joinedAt": 0,
                "score": 10,
                "correct": 1,
                "streak": 1,
                "bestStreak": 1,
                "tabLeaves": 0,
                "fastAnswers": 0,
                "kicked": False,
                "answers": {},
            }
            reply = await self.join(FakeWS(), nick="Legacy")
            self.assertEqual(reply["type"], "joined")
            self.assertTrue(reply["resume"])

    async def test_nickname_case_does_not_create_a_second_participant(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            await self.join(FakeWS(), nick="Ivan Petrov")
            self.start_round()
            ws = FakeWS()
            await self.join(ws, nick="ivan petrov")
        reply = ws.sent[0]
        self.assertEqual(reply["type"], "joined")
        self.assertEqual(ws.of_type("task")[0]["task"]["id"], TASK["id"])
        self.assertEqual(reply["nick"], "Ivan Petrov")
        self.assertEqual(list(self.game.by_nick), ["Ivan Petrov"])

    async def test_rejoin_detaches_previous_socket_of_same_participant(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            old = FakeWS()
            secret = (await self.join(old))["resume"]
            new = FakeWS()
            await self.join(new, resume=secret)
        await asyncio.gather(*self.game._closers)
        self.assertNotIn(old, self.game.students)
        self.assertIn(new, self.game.students)
        self.assertTrue(old.scope["algoclimb_dropped"])
        self.assertEqual(old.of_type("replaced"), [{"type": "replaced"}])
        self.assertTrue(old.closed)

    async def test_round_waits_for_student_who_is_reconnecting(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            a, b = FakeWS(), FakeWS()
            await self.join(a, nick="A")
            await self.join(b, nick="B")
        self.start_round()
        await self.game.on_student_disconnect(b)  # B's Wi-Fi blinks
        with patch.object(main, "RECONNECT_GRACE_MS", 200):
            await self.answer(a)
            self.assertFalse(self.game.intermission, "round closed without B")
            self.assertIsNotNone(self.game._grace)
            await asyncio.sleep(0.4)
        self.assertTrue(self.game.intermission, "round must close after the grace window")

    async def test_reconnected_student_can_still_answer_within_grace(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            a, b = FakeWS(), FakeWS()
            await self.join(a, nick="A")
            secret = (await self.join(b, nick="B"))["resume"]
            self.start_round()
            await self.game.on_student_disconnect(b)
            await self.answer(a)
            self.assertFalse(self.game.intermission)
            b2 = FakeWS()
            await self.join(b2, nick="B", resume=secret)
        self.assertEqual(b2.of_type("task")[0]["task"]["id"], TASK["id"])
        await self.answer(b2)
        self.assertTrue(self.game.by_nick["B"]["answers"][0]["correct"])
        self.assertTrue(self.game.intermission)

    async def test_failed_send_detaches_socket_so_client_resyncs(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            ws = FakeWS()
            await self.join(ws)
        ws.fail = True
        await self.game.send(ws, {"type": "task"})
        self.assertNotIn(ws, self.game.students)
        self.assertTrue(ws.scope["algoclimb_dropped"])
        self.assertIn("disconnectedAt", self.game.by_nick["Student"])

    async def test_silent_sockets_are_reaped(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            quiet, alive = FakeWS(), FakeWS()
            await self.join(quiet, nick="Quiet")
            await self.join(alive, nick="Alive")
        now = time.monotonic()
        quiet.scope["last_rx"] = now - main.STALE_AFTER_S - 1
        alive.scope["last_rx"] = now
        self.game.reap_stale()
        self.assertNotIn(quiet, self.game.students)
        self.assertIn(alive, self.game.students)

    async def test_tab_leave_is_batched_for_teacher(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            ws = FakeWS()
            await self.join(ws)
        self.start_round()
        self.game._teacher_dirty = False
        await self.game.handle_student(ws, {"type": "tableave"}, "10.0.0.5")
        self.game.broadcast_teacher.assert_not_awaited()
        self.assertTrue(self.game._teacher_dirty)

    async def test_restored_snapshot_waits_for_returning_students(self):
        with patch.dict(main.config["qrRotation"], enabled=False):
            a, b = FakeWS(), FakeWS()
            await self.join(a, nick="A")
            await self.join(b, nick="B")
        self.start_round()
        for ws in (a, b):
            await self.game.on_student_disconnect(ws)
        snapshot = json.loads(json.dumps(self.game.snapshot_dict()))
        for s in snapshot["by_nick"].values():
            s.pop("disconnectedAt", None)
        restored = main.Game()
        restored.broadcast_teacher = AsyncMock()
        with patch.object(main, "SNAPSHOT_FILE") as snap_file:
            snap_file.exists.return_value = True
            snap_file.read_text.return_value = json.dumps(snapshot)
            self.assertTrue(restored.load_snapshot())
        restored.round_deadline = int(time.time() * 1000) + 30000
        first = FakeWS()
        with patch.dict(main.config["qrRotation"], enabled=False):
            await restored.handle_student(first, {"type": "join", "nick": "A"}, "10.0.0.5")
        await restored.handle_student(
            first, {"type": "answer", "taskId": TASK["id"], "payload": {"choice": 1}}, "10.0.0.5"
        )
        self.assertFalse(restored.intermission, "first returning student closed the round")
        restored._cancel_timers()


if __name__ == "__main__":
    unittest.main(verbosity=2)
