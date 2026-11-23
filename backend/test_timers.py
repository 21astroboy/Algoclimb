"""Regression tests for timer callbacks cancelling themselves during transitions."""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import bank
import main


class TimerTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_time_limit_drives_deadline_and_restoration(self):
        import tempfile
        from pathlib import Path

        game = main.Game()
        task = {**bank.TASKS[0], "timeLimit": 17}
        game.session.update(status="running", test=True, timeLimits={task["type"]: 60})
        game.order = [task]
        game.broadcast_students = AsyncMock()
        game.broadcast_teacher = AsyncMock()
        try:
            before = main.now_ms()
            await game.begin_round(0)
            self.assertAlmostEqual(game.round_deadline - before, 60000, delta=1000)
            with tempfile.TemporaryDirectory() as directory:
                restored = main.Game()
                restored.room_id = game.room_id = "timing-test"
                restored._snapshot_file = game._snapshot_file = Path(directory) / "state.json"
                game.save_snapshot()
                restored.load_snapshot()
                self.assertEqual(restored.time_limit_for(restored.order[0]), 60000)
                self.assertEqual(restored.round_deadline, game.round_deadline)
                restored._cancel_timers()
        finally:
            game._cancel_timers()

    async def test_timeout_reaches_next_round_without_watchdog(self):
        game = main.Game()
        game.session.update(status="running", test=True)
        game.order = [bank.TASKS[0], bank.TASKS[0]]
        game.round = 0
        advanced = asyncio.Event()

        async def broadcast(_make_msg):
            # Real socket sends yield to the event loop, exposing self-cancellation.
            await asyncio.sleep(0)

        async def begin_round(idx):
            game.round = idx
            advanced.set()

        game.broadcast_students = broadcast
        game.broadcast_teacher = AsyncMock()
        game.begin_round = begin_round
        with patch.object(main, "REVEAL_MS", 1):
            try:
                game._schedule("_timer", 0, lambda: game.end_round("timeout"))
                await asyncio.wait_for(advanced.wait(), timeout=1)
                self.assertEqual(game.round, 1)
                self.assertIsNone(game._timer)
            finally:
                game._cancel_timers()

    async def test_callback_can_cancel_all_timers_and_still_complete(self):
        game = main.Game()
        completed = asyncio.Event()

        async def finish():
            game._cancel_timers()
            await asyncio.sleep(0)
            completed.set()

        game._schedule("_reveal", 0, finish)
        try:
            await asyncio.wait_for(completed.wait(), timeout=1)
        finally:
            game._cancel_timers()

    async def test_cancelled_timer_does_not_fire(self):
        game = main.Game()
        callback = AsyncMock()
        game._schedule("_timer", 20, callback)
        game._cancel_timers()
        await asyncio.sleep(0.04)
        callback.assert_not_awaited()

    async def test_replacing_timer_cancels_the_previous_deadline(self):
        game = main.Game()
        old_callback = AsyncMock()
        completed = asyncio.Event()
        new_callback = AsyncMock(side_effect=completed.set)
        game._schedule("_timer", 10, old_callback)
        game._schedule("_timer", 50, new_callback)
        try:
            await asyncio.wait_for(completed.wait(), timeout=1)
            old_callback.assert_not_awaited()
            new_callback.assert_awaited_once()
        finally:
            game._cancel_timers()


if __name__ == "__main__":
    unittest.main()
