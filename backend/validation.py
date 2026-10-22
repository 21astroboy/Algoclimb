"""Validate answer structure before consuming an attempt or grading it."""

import math


def valid_answer(task, payload):
    if not isinstance(payload, dict):
        return False
    kind = task["type"]
    if kind == "choice":
        value = payload.get("choice")
        return type(value) is int and 0 <= value < len(task["options"])
    if kind in ("graph", "order"):
        nodes = task.get("nodes") or list(
            {v for edge in task.get("requiredEdges", []) for v in edge}
        )
        if kind == "order":
            values = payload.get("order")
            return (
                isinstance(values, list)
                and len(values) <= len(nodes)
                and all(type(v) in (str, int) and v in nodes for v in values)
            )
        edges = payload.get("edges")
        return (
            isinstance(edges, list)
            and len(edges) <= len(nodes) * max(0, len(nodes) - 1) // 2
            and all(
                isinstance(edge, list)
                and len(edge) == 2
                and all(type(v) in (str, int) and v in nodes for v in edge)
                for edge in edges
            )
        )
    if kind == "sort":
        values = payload.get("array")
        return (
            isinstance(values, list)
            and len(values) == len(task["array"])
            and all(type(v) is int or (type(v) is float and math.isfinite(v)) for v in values)
        )
    if kind == "blank":
        values = payload.get("blanks")
        return (
            isinstance(values, list)
            and len(values) == len(task["blanks"])
            and all(isinstance(v, str) and len(v) <= 2000 for v in values)
        )
    return False
