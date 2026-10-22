"""Boundary and malformed-answer regressions, independent of private task banks."""

import time
import unittest
from unittest.mock import AsyncMock, patch

import main
from validation import valid_answer

CHOICE = {
    "id": "test-choice",
    "type": "choice",
    "options": ["A", "B"],
    "answer": 1,
    "level": 1,
    "title": "Test",
    "prompt": "Pick B",
}


class AnswerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.game = main.Game()
        self.game.session.update(status="running", test=True)
        self.game.order = [CHOICE]
        self.game.round = 0
        self.game.round_perm = [1, 0]
        self.game.round_deadline = int(time.time() * 1000) + 10000
        self.game.send = AsyncMock()
        self.game.maybe_end_round = AsyncMock()
        self.ws = object()
        self.student = {
            "nick": "Test",
            "kicked": False,
            "answers": {},
            "score": 0,
            "correct": 0,
            "streak": 0,
            "bestStreak": 0,
        }
        self.game.students[self.ws] = self.student
        self.game.by_nick["Test"] = self.student

    async def answer(self, payload):
        await self.game.handle_student(
            self.ws, {"type": "answer", "taskId": CHOICE["id"], "payload": payload}, "127.0.0.1"
        )

    def assert_unused(self):
        self.assertEqual(self.game.round_answered, set())
        self.assertEqual(self.student["answers"], {})
        self.assertEqual(self.student["score"], 0)

    async def test_exact_deadline_is_rejected_without_consuming_attempt(self):
        self.game.round_deadline = 100000
        with patch.object(main.time, "time", return_value=100):
            await self.answer({"choice": 0})
        self.assertEqual(self.game.send.call_args.args[1]["reason"], "expired")
        self.assert_unused()

    async def test_paused_answer_can_be_retried(self):
        self.game.paused = True
        await self.answer({"choice": 0})
        self.assertEqual(self.game.send.call_args.args[1]["reason"], "paused")
        self.assert_unused()
        self.game.paused = False
        await self.answer({"choice": 0})
        self.assertTrue(self.student["answers"][0]["correct"])

    async def test_invalid_payload_does_not_consume_attempt(self):
        for payload in (None, [], "A", {}, {"choice": -1}, {"choice": 2}, {"choice": True}):
            with self.subTest(payload=payload):
                await self.answer(payload)
                self.assertEqual(self.game.send.call_args.args[1]["reason"], "invalid_payload")
                self.assert_unused()
        await self.answer({"choice": 0})
        score = self.student["score"]
        self.assertGreater(score, 0)
        await self.answer({"choice": 1})
        self.assertEqual(self.student["score"], score)
        self.assertEqual(self.student["correct"], 1)

    async def test_valid_wrong_answer_spends_attempt(self):
        await self.answer({"choice": 1})
        self.assertFalse(self.student["answers"][0]["correct"])
        self.assertEqual(self.game.round_answered, {"Test"})
        await self.answer({"choice": 0})
        self.assertEqual(self.student["score"], 0)
        self.assertEqual(self.student["correct"], 0)


class PayloadTests(unittest.TestCase):
    def test_graph_shapes(self):
        task = {"type": "graph", "nodes": ["A", "B", "C"]}
        for edges in (None, "A-B", [["A"]], [[{}, "B"]], [["X", "B"]], [[True, "A"]]):
            with self.subTest(edges=edges):
                self.assertFalse(valid_answer(task, {"edges": edges}))
        self.assertTrue(valid_answer(task, {"edges": []}))
        self.assertTrue(valid_answer(task, {"edges": [["A", "B"]]}))

    def test_order_sort_and_blank_shapes(self):
        order = {"type": "order", "nodes": ["A", "B"]}
        self.assertFalse(valid_answer(order, {"order": [["A"]]}))
        self.assertTrue(valid_answer(order, {"order": ["B", "A"]}))
        sort = {"type": "sort", "array": [1, 2]}
        for values in ([True, 2], [float("nan"), 2], [float("inf"), 2], [1], [{}, 2]):
            self.assertFalse(valid_answer(sort, {"array": values}))
        self.assertTrue(valid_answer(sort, {"array": [2, 1]}))
        blank = {"type": "blank", "blanks": [{"answer": "да"}]}
        for values in ([["да"]], [None], ["x" * 2001], []):
            self.assertFalse(valid_answer(blank, {"blanks": values}))
        self.assertTrue(valid_answer(blank, {"blanks": ["да"]}))


if __name__ == "__main__":
    unittest.main()
