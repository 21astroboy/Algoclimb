"""Prevent the benchmark from passing partial or inconsistent sessions."""

import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from tools.reliability_test import Run


class VerdictTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / "runtime").mkdir()
        self.db = root / "runtime/algoclimb.db"
        args = SimpleNamespace(students=2, rounds=1, qr=False, idle=0)
        self.run = Run(args, root, 12345)
        tid = self.run.task_ids[0]
        with sqlite3.connect(self.db) as conn:
            conn.executescript(
                "CREATE TABLE attendance(nick); CREATE TABLE answers(nick); CREATE TABLE results(nick,total);"
            )
            for student in self.run.students:
                student.received.add(tid)
                student.confirmed.add(tid)
                student.awarded_points[tid] = 100
                student.end = {
                    "score": 100,
                    "correct": 1,
                    "review": [{"answered": True, "correct": True}],
                }
                student.latencies.append(1)
                conn.execute("INSERT INTO attendance VALUES(?)", (student.nick,))
                conn.execute("INSERT INTO answers VALUES(?)", (student.nick,))
                conn.execute("INSERT INTO results VALUES(?,100)", (student.nick,))
        self.run.health_latencies.append(1)

    def verdict(self):
        return self.run.report(1, None)["passed"]

    def test_complete_session_passes(self):
        self.assertTrue(self.verdict())

    def test_missing_acknowledgement_fails_despite_complete_final_review(self):
        self.run.students[0].confirmed.clear()
        self.assertFalse(self.verdict())

    def test_missing_persistence_fails(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute("DELETE FROM answers WHERE nick=?", (self.run.students[0].nick,))
        self.assertFalse(self.verdict())

    def test_inconsistent_final_score_fails(self):
        self.run.students[0].end["score"] = 200
        self.assertFalse(self.verdict())

    def test_unrecovered_or_unexpected_disconnect_fails(self):
        student = self.run.students[0]
        student.forced.add(self.run.task_ids[0])
        self.assertFalse(self.verdict())
        student.restores.append(250)
        self.assertTrue(self.verdict())
        student.unexpected_drops += 1
        self.assertFalse(self.verdict())

    def test_slow_confirmation_fails(self):
        self.run.students[0].latencies = [2000] * 20
        self.assertFalse(self.verdict())


if __name__ == "__main__":
    unittest.main()
