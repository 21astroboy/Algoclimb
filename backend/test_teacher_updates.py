"""Keep reconnect bursts cheap without dropping final teacher answer history."""

import unittest
from unittest.mock import AsyncMock, Mock, patch

import main

TASK = {
    "id": "teacher-load",
    "type": "choice",
    "title": "Test",
    "prompt": "Pick B",
    "options": ["A", "B"],
    "answer": 1,
    "level": 1,
}


class TeacherUpdateTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_burst_does_not_send_full_state_per_student(self):
        game = main.Game()
        game.send = AsyncMock()
        game.broadcast_teacher = AsyncMock()
        connections = [object() for _ in range(60)]
        with patch.dict(main.config["qrRotation"], enabled=False):
            for idx, ws in enumerate(connections):
                await game.handle_student(ws, {"type": "join", "nick": f"Class {idx}"}, "127.0.0.1")
            game.session.update(status="running", test=True)
            game.order = [TASK]
            game.round = 0
            for idx, ws in enumerate(connections):
                await game.on_student_disconnect(ws)
                await game.handle_student(
                    object(), {"type": "join", "nick": f"Class {idx}"}, "127.0.0.1"
                )
        self.assertEqual(len(game.students), 60)
        self.assertTrue(game._teacher_dirty)
        game.broadcast_teacher.assert_not_awaited()
        joined = [c.args[1] for c in game.send.call_args_list if c.args[1]["type"] == "joined"]
        self.assertEqual(len(joined), 120)

    async def test_full_history_is_only_built_and_sent_after_finish(self):
        game = main.Game()
        game.send = AsyncMock()
        with patch.dict(main.config["qrRotation"], enabled=False):
            await game.handle_student(object(), {"type": "join", "nick": "Student"}, "127.0.0.1")
        game.session.update(status="running", test=True)
        game.order = [TASK]
        game.round = 0
        game.by_nick["Student"]["answers"][0] = {
            "answered": True,
            "correct": True,
            "points": 100,
            "ansText": "B",
            "ms": 100,
        }
        teacher = object()
        game.teachers.add(teacher)
        game.session_details = Mock(wraps=game.session_details)
        await game.broadcast_teacher()
        live = game.send.call_args.args[1]
        self.assertEqual(live["details"], [])
        self.assertEqual(live["leaderboard"][0]["answers"], [])
        game.session_details.assert_not_called()
        game.session["status"] = "finished"
        await game.broadcast_teacher()
        final = game.send.call_args.args[1]
        self.assertEqual(final["details"][0]["responses"][0]["answer"], "B")
        self.assertTrue(final["leaderboard"][0]["answers"][0]["correct"])
        game.session_details.assert_called_once()


if __name__ == "__main__":
    unittest.main()
