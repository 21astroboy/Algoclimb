"""Validate a one-session bank without modifying the permanent task registry."""

import copy
import math
import xml.etree.ElementTree as ET

from catalog import SECTIONS

GRAPH_KINDS = {
    "anyCycle",
    "anyPath",
    "anyTree",
    "anyComplete",
    "anyCompleteBipartite",
    "anyComponents",
    "anyBinaryTree",
    "anyCycleChord",
    "anyEulerian",
    "anyStar",
    "anyForest",
    "anyRegular",
}


def validate_tasks(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 500:
        raise ValueError("Provide an array of 1 to 500 questions.")
    tasks = copy.deepcopy(raw)
    seen = set()
    for index, task in enumerate(tasks, 1):
        try:
            validate_task(task)
            if task["id"] in seen:
                raise ValueError("Duplicate question ID.")
            seen.add(task["id"])
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError(f"Question {index}: {exc}") from exc
    return tasks


def validate_task(t):
    if not isinstance(t, dict):
        raise ValueError("Each question must be an object.")
    for key in ("id", "title", "prompt"):
        if (
            not isinstance(t.get(key), str)
            or not t[key].strip()
            or len(t[key]) > (128 if key == "id" else 20000)
        ):
            raise ValueError(f"Invalid {key}.")
    if type(t.get("level", 1)) is not int or not 1 <= t.get("level", 1) <= 3:
        raise ValueError("Level must be 1, 2 or 3.")
    for key in ("topic", "block", "hint"):
        if key in t and (not isinstance(t[key], str) or len(t[key]) > 20000):
            raise ValueError(f"Invalid {key}.")
    if "section" in t and t["section"] not in SECTIONS:
        raise ValueError("Unknown subject section.")
    if "timeLimit" in t and (type(t["timeLimit"]) is not int or not 1 <= t["timeLimit"] <= 3600):
        raise ValueError("timeLimit must be 1 to 3600 seconds.")
    if "figure" in t:
        validate_figure(t["figure"])
    kind = t.get("type")
    if kind == "choice":
        options = t.get("options")
        if (
            not isinstance(options, list)
            or not 2 <= len(options) <= 20
            or not all(isinstance(v, str) and len(v) <= 20000 for v in options)
        ):
            raise ValueError("Provide 2 to 20 text options.")
        if type(t.get("answer")) is not int or not 0 <= t["answer"] < len(options):
            raise ValueError("answer must be a zero-based option index.")
    elif kind in ("graph", "order"):
        nodes = t.get("nodes")
        if (
            not isinstance(nodes, list)
            or not 2 <= len(nodes) <= 40
            or not all(isinstance(n, str) and 0 < len(n) <= 32 for n in nodes)
            or len(set(nodes)) != len(nodes)
        ):
            raise ValueError("Provide 2 to 40 distinct vertex labels.")
        edges = (
            t.get("edges", [])
            if kind == "order"
            else t.get("refEdges", [])
            if t.get("weighted")
            else t.get("requiredEdges", t.get("example", []))
        )
        if not isinstance(edges, list) or len(edges) > 780:
            raise ValueError("Invalid edges.")
        used = set()
        adjacency = {n: set() for n in nodes}
        for edge in edges:
            width = 3 if kind == "graph" and t.get("weighted") else 2
            if (
                not isinstance(edge, list)
                or len(edge) != width
                or edge[0] not in nodes
                or edge[1] not in nodes
                or edge[0] == edge[1]
            ):
                raise ValueError("Edges must join two different supplied vertices.")
            pair = frozenset(edge[:2])
            if pair in used:
                raise ValueError("Duplicate edge.")
            used.add(pair)
            adjacency[edge[0]].add(edge[1])
            adjacency[edge[1]].add(edge[0])
            if width == 3 and (type(edge[2]) not in (int, float) or not math.isfinite(edge[2])):
                raise ValueError("Edge weights must be finite numbers.")
        if kind == "order" or t.get("weighted"):
            reached = {nodes[0]}
            pending = [nodes[0]]
            while pending:
                for vertex in adjacency[pending.pop()] - reached:
                    reached.add(vertex)
                    pending.append(vertex)
            if len(reached) != len(nodes):
                raise ValueError("Traversal and MST reference graphs must be connected.")
        if kind == "order":
            if t.get("mode") not in ("bfs", "dfs") or t.get("start") not in nodes:
                raise ValueError("Supply a start vertex and bfs/dfs mode.")
        elif not t.get("weighted") and "requiredEdges" not in t:
            if t.get("graphKind") not in GRAPH_KINDS:
                raise ValueError("Unknown graph property.")
            if t["graphKind"] in ("anyComponents", "anyForest", "anyRegular") and (
                type(t.get("graphArg")) is not int or not 1 <= t["graphArg"] <= len(nodes)
            ):
                raise ValueError("Supply a valid integer graphArg.")
    elif kind == "sort":
        from bank import simulate_sort

        array = t.get("array")
        if (
            not isinstance(array, list)
            or not 2 <= len(array) <= 40
            or not all(type(n) in (int, float) and math.isfinite(n) for n in array)
        ):
            raise ValueError("Provide an array of 2 to 40 finite numbers.")
        if (
            t.get("algo") not in ("bubble", "insertion")
            or type(t.get("steps")) is not int
            or not 1 <= t["steps"] < len(array)
        ):
            raise ValueError("Supply bubble/insertion and a valid step count.")
        expected = simulate_sort(array, t["algo"], t["steps"])
        if "expected" in t and t["expected"] != expected:
            raise ValueError("expected does not match the requested sorting steps.")
        t["expected"] = expected
    elif kind == "blank":
        blanks = t.get("blanks")
        if (
            not isinstance(t.get("template"), str)
            or not isinstance(blanks, list)
            or not 1 <= len(blanks) <= 30
            or t["template"].count("___") != len(blanks)
        ):
            raise ValueError("Each ___ must have a corresponding blank.")
        for blank in blanks:
            if (
                not isinstance(blank, dict)
                or not isinstance(blank.get("answer"), str)
                or not blank["answer"]
                or len(blank["answer"]) > 2000
            ):
                raise ValueError("Each blank needs a text answer.")
            for key in ("alts", "options"):
                values = blank.get(key, [])
                if not isinstance(values, list) or not all(
                    isinstance(v, str) and len(v) <= 2000 for v in values
                ):
                    raise ValueError(f"Invalid blank {key}.")
            if blank.get("options") and blank["answer"] not in blank["options"]:
                raise ValueError("A dropdown answer must be one of its options.")
    else:
        raise ValueError("Unknown question type.")


def validate_figure(svg):
    if not isinstance(svg, str) or len(svg) > 100000 or "<!" in svg:
        raise ValueError("Invalid SVG figure.")
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise ValueError("Invalid SVG figure.") from exc
    allowed = {
        "svg",
        "g",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "text",
        "tspan",
        "title",
        "desc",
        "defs",
        "marker",
    }
    for node in root.iter():
        if node.tag.split("}")[-1] not in allowed:
            raise ValueError("Unsupported SVG element.")
        for key, value in node.attrib.items():
            key = key.split("}")[-1].lower()
            if (
                key.startswith("on")
                or key in ("href", "style")
                or "url(" in value.lower()
                or "javascript:" in value.lower()
            ):
                raise ValueError("Unsupported SVG attribute.")
