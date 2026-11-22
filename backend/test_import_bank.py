"""Reject invalid one-session banks before they can affect a running class."""

import copy
import json
import unittest
from pathlib import Path

import catalog
from import_bank import validate_tasks


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tasks = json.loads(
            (Path(__file__).parents[1] / "tools/fixtures/screenshot-bank.en.json").read_text()
        )

    def test_all_five_types_and_no_mutation_of_author_data(self):
        original = copy.deepcopy(self.tasks)
        self.tasks[-2].pop("expected")
        validated = validate_tasks(self.tasks)
        self.assertEqual(
            {t["type"] for t in validated}, {"choice", "graph", "order", "sort", "blank"}
        )
        self.assertEqual(validated[-2]["expected"], original[-2]["expected"])
        self.assertNotIn("expected", self.tasks[-2])

    def test_invalid_and_duplicate_tasks_are_rejected(self):
        for change in [
            {"answer": 999},
            {"level": True},
            {"section": "unknown"},
            {"figure": "<svg><script>alert(1)</script></svg>"},
            {"figure": '<svg><image href="https://example.org"/></svg>'},
        ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_tasks([{**self.tasks[0], **change}])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_tasks([self.tasks[0], self.tasks[0]])
        with self.assertRaisesRegex(ValueError, "expected"):
            validate_tasks([{**self.tasks[-2], "expected": [1, 2, 3]}])
        with self.assertRaisesRegex(ValueError, "connected"):
            validate_tasks([{**self.tasks[4], "edges": [["A", "B"]]}])

    def test_legacy_sections_and_explicit_future_subjects(self):
        self.assertEqual(catalog.section_for({"block": "oop3"}), "oop")
        self.assertEqual(catalog.section_for({"block": "comb4"}), "graphs")
        self.assertEqual(catalog.section_for({"id": "c1_sort_bubble", "block": "comb1"}), "graphs")
        self.assertEqual(catalog.section_for({"topic": "asd"}), "algorithms")
        self.assertEqual(catalog.section_for({"section": "db"}), "db")
        self.assertEqual(catalog.section_for({"section": "nn"}), "nn")
