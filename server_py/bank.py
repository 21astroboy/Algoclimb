"""
Банк задач для Python-бэкенда AlgoClimb.

Задачи загружаются из декларативного JSON (task-bank.json — приватный, в .gitignore;
если его нет, берётся task-bank.example.json). Проверки ответов реализованы обобщённо:
для каждого ВИДА задачи один алгоритм, а не отдельная функция на каждую из 265 задач.

Правильные ответы НИКОГДА не отправляются студенту — см. public_task().
Это точный порт логики из tasks.js (Node).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- загрузка банка
def _load_bank_file():
    priv = ROOT / "task-bank.json"
    demo = ROOT / "task-bank.example.json"
    if priv.exists():
        return json.loads(priv.read_text(encoding="utf-8")), "task-bank.json"
    if demo.exists():
        return json.loads(demo.read_text(encoding="utf-8")), "task-bank.example.json"
    raise RuntimeError(
        "AlgoClimb: не найден банк задач. Ожидается task-bank.json "
        "(или task-bank.example.json). Сгенерируйте его из Node-банка "
        "(node export-bank.js) или скопируйте пример."
    )


TASKS, BANK_SOURCE = _load_bank_file()
BY_ID = {t["id"]: t for t in TASKS}


# ---------------------------------------------------------------- графовые утилиты
def edge_key(a, b):
    return "-".join(sorted([str(a), str(b)]))


def edge_set(edges):
    return {edge_key(e[0], e[1]) for e in (edges or [])}


def _parse_graph(payload, nodes):
    """Разобрать ответ студента в простой граф над nodes. None при ребре вне набора/петле."""
    nset = set(nodes)
    seen = set()
    adj = {v: set() for v in nodes}
    for e in payload.get("edges") or []:
        a, b = e[0], e[1]
        if a not in nset or b not in nset or a == b:
            return None
        k = edge_key(a, b)
        if k not in seen:
            seen.add(k)
            adj[a].add(b)
            adj[b].add(a)
    return {"adj": adj, "keys": seen, "m": len(seen), "nodes": list(nodes)}


def _components(g):
    par = {v: v for v in g["nodes"]}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    for v in g["nodes"]:
        for w in g["adj"][v]:
            ra, rb = find(v), find(w)
            if ra != rb:
                par[ra] = rb
    return len({find(v) for v in g["nodes"]})


def _degs(g):
    return [len(g["adj"][v]) for v in g["nodes"]]


def _color(g):
    """2-раскраска; None если граф не двудольный."""
    c = {}
    for s in g["nodes"]:
        if s in c:
            continue
        c[s] = 0
        q = [s]
        while q:
            u = q.pop(0)
            for w in g["adj"][u]:
                if w not in c:
                    c[w] = c[u] ^ 1
                    q.append(w)
                elif c[w] == c[u]:
                    return None
    return c


def _prop_check(kind, nodes, arg, payload):
    g = _parse_graph(payload, nodes)
    if g is None:
        return False
    n = len(nodes)
    m = g["m"]
    d = _degs(g)
    comps = _components(g)
    if kind == "anyCycle":
        return m == n and all(x == 2 for x in d) and comps == 1
    if kind == "anyPath":
        return m == n - 1 and d.count(1) == 2 and d.count(2) == n - 2 and comps == 1
    if kind == "anyTree":
        return m == n - 1 and comps == 1
    if kind == "anyComplete":
        return m == n * (n - 1) // 2
    if kind == "anyCompleteBipartite":
        if comps != 1:
            return False
        c = _color(g)
        if c is None:
            return False
        X = sum(1 for v in g["nodes"] if c[v] == 0)
        Y = len(g["nodes"]) - X
        return X > 0 and Y > 0 and m == X * Y
    if kind == "anyComponents":
        if any(x == 0 for x in d):
            return False
        return comps == arg
    if kind == "anyBinaryTree":
        return m == n - 1 and comps == 1 and all(x <= 3 for x in d)
    if kind == "anyCycleChord":
        if m != n + 1 or comps != 1:
            return False
        return d.count(3) == 2 and d.count(2) == n - 2
    if kind == "anyEulerian":
        return all(x > 0 and x % 2 == 0 for x in d) and comps == 1
    if kind == "anyStar":
        if m != n - 1 or comps != 1:
            return False
        return d.count(n - 1) == 1 and d.count(1) == n - 1
    if kind == "anyForest":
        return m == n - arg and comps == arg
    if kind == "anyRegular":
        return comps == 1 and all(x == arg for x in d)
    return False


def _mst_weight(ref_edges, nodes):
    par = {v: v for v in nodes}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    total = 0
    for a, b, w in sorted(ref_edges, key=lambda e: e[2]):
        ra, rb = find(a), find(b)
        if ra != rb:
            par[ra] = rb
            total += w
    return total


def _mst_check(task, payload):
    ref = task["refEdges"]
    nodes = task["nodes"]
    W = {edge_key(a, b): w for a, b, w in ref}
    mstW = _mst_weight(ref, nodes)
    edges = payload.get("edges") or []
    if not all(edge_key(e[0], e[1]) in W for e in edges):
        return False
    if len(edges) != len(nodes) - 1:
        return False
    par = {v: v for v in nodes}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    total = 0
    for e in edges:
        ra, rb = find(e[0]), find(e[1])
        if ra == rb:
            return False
        par[ra] = rb
        total += W[edge_key(e[0], e[1])]
    if len({find(v) for v in nodes}) != 1:
        return False
    return total == mstW


def _kruskal(ref_edges, nodes):
    par = {v: v for v in nodes}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    out = []
    for a, b, w in sorted(ref_edges, key=lambda e: e[2]):
        ra, rb = find(a), find(b)
        if ra != rb:
            par[ra] = rb
            out.append([a, b, w])
    return out


# ---------------------------------------------------------------- обходы графа
def _adj_of(nodes, edges):
    adj = {v: set() for v in nodes}
    for e in edges or []:
        if e[0] in adj and e[1] in adj and e[0] != e[1]:
            adj[e[0]].add(e[1])
            adj[e[1]].add(e[0])
    return adj


def _seq_ok(seq, nodes):
    return (
        isinstance(seq, list)
        and len(seq) == len(nodes)
        and len(set(seq)) == len(nodes)
        and all(v in nodes for v in seq)
    )


def _valid_dfs(task, payload):
    nodes, edges, start = task["nodes"], task["edges"], task["start"]
    adj = _adj_of(nodes, edges)
    seq = (payload or {}).get("order") or []
    if not _seq_ok(seq, nodes) or seq[0] != start:
        return False
    visited = {start}
    stack = [start]
    i = 1
    while i < len(seq):
        if not stack:
            return False
        u = stack[-1]
        has_unvisited = any(w not in visited for w in adj[u])
        if has_unvisited:
            v = seq[i]
            if v in visited or v not in adj[u]:
                return False
            visited.add(v)
            stack.append(v)
            i += 1
        else:
            stack.pop()
    return len(visited) == len(nodes)


def _valid_bfs(task, payload):
    nodes, edges, start = task["nodes"], task["edges"], task["start"]
    adj = _adj_of(nodes, edges)
    seq = (payload or {}).get("order") or []
    if not _seq_ok(seq, nodes) or seq[0] != start:
        return False
    visited = {start}
    queue = [start]
    i = 1
    while queue:
        u = queue.pop(0)
        nbrs = [w for w in adj[u] if w not in visited]
        block = seq[i : i + len(nbrs)]
        if len(block) != len(nbrs):
            return False
        bs = set(block)
        if len(bs) != len(nbrs) or not all(w in bs for w in nbrs):
            return False
        for v in block:
            visited.add(v)
            queue.append(v)
        i += len(nbrs)
    return i == len(seq) and len(visited) == len(nodes)


def sample_order(nodes, edges, start, mode):
    adj = _adj_of(nodes, edges)
    order = []
    visited = set()
    if mode == "bfs":
        q = [start]
        visited.add(start)
        while q:
            u = q.pop(0)
            order.append(u)
            for w in sorted(adj[u]):
                if w not in visited:
                    visited.add(w)
                    q.append(w)
    else:

        def dfs(u):
            visited.add(u)
            order.append(u)
            for w in sorted(adj[u]):
                if w not in visited:
                    dfs(w)

        dfs(start)
    return order


# ---------------------------------------------------------------- сортировка
def simulate_sort(arr, algo, steps):
    a = list(arr)
    n = len(a)
    if algo == "insertion":
        for s in range(min(steps, n - 1)):
            j = s + 1
            while j > 0 and a[j - 1] > a[j]:
                a[j - 1], a[j] = a[j], a[j - 1]
                j -= 1
    else:  # bubble
        for s in range(min(steps, n - 1)):
            for j in range(n - 1 - s):
                if a[j] > a[j + 1]:
                    a[j], a[j + 1] = a[j + 1], a[j]
    return a


def _arr_eq(x, y):
    return (
        isinstance(x, list)
        and isinstance(y, list)
        and len(x) == len(y)
        and all(str(v) == str(y[i]) for i, v in enumerate(x))
    )


def gen_sort_array(length):
    hi = max(length * 3, 12)
    for _ in range(60):
        s = set()
        while len(s) < length:
            s.add(random.randint(1, hi))
        arr = list(s)
        random.shuffle(arr)
        is_sorted = all(arr[i - 1] <= arr[i] for i in range(1, len(arr)))
        if not is_sorted:
            return arr
    return None


# ---------------------------------------------------------------- пропуски
def _norm(s):
    return " ".join(str("" if s is None else s).strip().lower().split())


def _blank_ok(blank, val):
    if isinstance(blank.get("options"), list) and blank["options"]:
        return str(val) == str(blank["answer"])
    accept = {_norm(x) for x in [blank["answer"], *blank.get("alts", [])]}
    return _norm(val) in accept


def _blank_check(task, payload):
    vals = (payload or {}).get("blanks") or []
    blanks = task["blanks"]
    if not isinstance(vals, list) or len(vals) != len(blanks):
        return False
    return all(_blank_ok(b, vals[i]) for i, b in enumerate(blanks))


# ---------------------------------------------------------------- единый диспетчер проверки
def run_check(task, payload):
    payload = payload or {}
    ty = task["type"]
    if ty == "choice":
        return payload.get("choice") == task["answer"]
    if ty == "graph":
        if task.get("weighted") and task.get("refEdges"):
            return _mst_check(task, payload)
        if task.get("requiredEdges") is not None:
            return edge_set(payload.get("edges")) == edge_set(task["requiredEdges"])
        return _prop_check(task["graphKind"], task["nodes"], task.get("graphArg"), payload)
    if ty == "order":
        return (_valid_bfs if task["mode"] == "bfs" else _valid_dfs)(task, payload)
    if ty == "sort":
        return _arr_eq(payload.get("array") or [], task["expected"])
    if ty == "blank":
        return _blank_check(task, payload)
    return False


# ---------------------------------------------------------------- публичная версия задачи
def public_task(task):
    t = task
    base = {
        "id": t["id"],
        "type": t["type"],
        "title": t["title"],
        "prompt": t["prompt"],
        "topic": t.get("topic"),
    }
    if t["type"] == "choice":
        base["options"] = list(t["options"])
    if t["type"] == "graph":
        base["nodes"] = (
            list(t["nodes"])
            if t.get("nodes")
            else sorted({x for e in t.get("requiredEdges", []) for x in e})
        )
        if t.get("weighted") and t.get("refEdges"):
            base["weighted"] = True
            base["refEdges"] = [[a, b, w] for a, b, w in t["refEdges"]]
    if t["type"] == "order":
        base["nodes"] = list(t["nodes"])
        base["edges"] = [[e[0], e[1]] for e in t["edges"]]
        base["start"] = t["start"]
        base["mode"] = t["mode"]
    if t["type"] == "sort":
        base["array"] = list(t["array"])
        base["algo"] = t["algo"]
        base["steps"] = t["steps"]
    if t["type"] == "blank":
        base["template"] = t["template"]
        base["blanks"] = [
            {"options": list(b["options"])}
            if isinstance(b.get("options"), list) and b["options"]
            else {}
            for b in t["blanks"]
        ]
    return base


# ---------------------------------------------------------------- ответ для преподавателя
def answer_text(t):
    ty = t["type"]
    if ty == "choice":
        return t["options"][t["answer"]]
    if ty == "graph":
        if t.get("weighted") and t.get("refEdges"):
            mst = _kruskal(t["refEdges"], t["nodes"])
            w = sum(e[2] for e in mst)
            return (
                "Минимальный остов (суммарный вес "
                + str(w)
                + "): "
                + ", ".join(f"{e[0]}–{e[1]} ({e[2]})" for e in mst)
            )
        if t.get("requiredEdges") is not None:
            return "Рёбра: " + ", ".join(f"{e[0]}–{e[1]}" for e in t["requiredEdges"])
        base = (
            ("Любой граф с нужным свойством. " + t["hint"])
            if t.get("hint")
            else "Любой граф с нужным свойством."
        )
        ex = t.get("example")
        extra = (" Пример: " + ", ".join(f"{e[0]}–{e[1]}" for e in ex) + ".") if ex else ""
        return base + extra
    if ty == "order":
        ex = " → ".join(str(v) for v in sample_order(t["nodes"], t["edges"], t["start"], t["mode"]))
        return (
            ("BFS" if t["mode"] == "bfs" else "DFS")
            + " из "
            + str(t["start"])
            + " — например: "
            + ex
            + " (принимается любой корректный порядок обхода)"
        )
    if ty == "sort":
        exp = ", ".join(
            str(v) for v in (t.get("expected") or simulate_sort(t["array"], t["algo"], t["steps"]))
        )
        algo = "сортировки вставками" if t["algo"] == "insertion" else "пузырьковой сортировки"
        return f"После {t['steps']} шаг(ов) {algo}: [{exp}]"
    if ty == "blank":
        parts = []
        for i, b in enumerate(t["blanks"]):
            alts = (" (или: " + ", ".join(b["alts"]) + ")") if b.get("alts") else ""
            parts.append(f"{i + 1}) {b['answer']}{alts}")
        return "; ".join(parts)
    return ""


def answer_edges(t):
    ty = t["type"]
    if ty == "order":
        return {
            "nodes": list(t.get("nodes") or []),
            "edges": [[e[0], e[1]] for e in (t.get("edges") or [])],
            "weighted": False,
        }
    if ty != "graph":
        return None
    if t.get("weighted") and t.get("refEdges"):
        return {
            "nodes": list(t.get("nodes") or []),
            "edges": _kruskal(t["refEdges"], t["nodes"]),
            "weighted": True,
        }
    if t.get("requiredEdges") is not None:
        return {
            "nodes": list(t.get("nodes") or []),
            "edges": [[e[0], e[1]] for e in t["requiredEdges"]],
            "weighted": False,
        }
    if t.get("example"):
        return {
            "nodes": list(t.get("nodes") or []),
            "edges": [[e[0], e[1]] for e in t["example"]],
            "weighted": False,
        }
    return None


# ---------------------------------------------------------------- параметризация (анти-чит)
def paramize_task(t):
    if not t or t.get("custom"):
        return t
    if t["type"] == "sort" and t.get("paramize") is not False:
        length = len(t.get("array") or [])
        if length >= 3:
            arr = gen_sort_array(length)
            if arr:
                nt = dict(t)
                nt["array"] = arr
                nt["expected"] = simulate_sort(arr, t["algo"], t["steps"])
                return nt
    return t


# ---------------------------------------------------------------- конструктор задач (интерфейс преподавателя)
GRAPH_TEMPLATES = {
    "tree": ("Любое дерево (n−1 ребро, связно)", "anyTree"),
    "cycle": ("Цикл через все вершины", "anyCycle"),
    "path": ("Простой путь через все вершины", "anyPath"),
    "complete": ("Полный граф (все пары соединены)", "anyComplete"),
    "star": ("Звезда (один центр)", "anyStar"),
    "bipartite": ("Полный двудольный граф", "anyCompleteBipartite"),
    "binarytree": ("Двоичное дерево (степени ≤ 3)", "anyBinaryTree"),
}


def graph_template_list():
    out = [{"key": k, "label": v[0]} for k, v in GRAPH_TEMPLATES.items()]
    out.append({"key": "exact", "label": "Точный граф (по списку рёбер)"})
    return out


def _to_num_or_str(x):
    s = str(x).strip()
    if s == "":
        return None
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return s


def build_custom_task(spec):
    import time

    if not isinstance(spec, dict):
        return None
    tid = str(
        spec.get("id")
        or ("custom_" + str(int(time.time() * 1000)) + "_" + str(random.randint(0, 999)))
    )
    topic = spec.get("topic") if spec.get("topic") in ("asd", "graphs") else "graphs"
    try:
        level = int(spec.get("level"))
    except (TypeError, ValueError):
        level = 1
    if level not in (1, 2, 3):
        level = 1
    title = str(spec.get("title") or "").strip()
    prompt = str(spec.get("prompt") or "").strip()
    if not title or not prompt:
        return None
    base = {
        "id": tid,
        "topic": topic,
        "level": level,
        "title": title,
        "prompt": prompt,
        "custom": True,
    }
    if spec.get("hint"):
        base["hint"] = str(spec["hint"]).strip()

    kind = spec.get("kind")
    if kind == "choice":
        options = [str(o) for o in (spec.get("options") or []) if str(o)]
        try:
            answer = int(spec.get("answer"))
        except (TypeError, ValueError):
            return None
        if len(options) < 2 or not (0 <= answer < len(options)):
            return None
        return {**base, "type": "choice", "options": options, "answer": answer}
    if kind == "order":
        nodes = [str(n).strip() for n in (spec.get("nodes") or []) if str(n).strip()]
        edges = [[str(e[0]).strip(), str(e[1]).strip()] for e in (spec.get("edges") or [])]
        edges = [e for e in edges if e[0] in nodes and e[1] in nodes and e[0] != e[1]]
        start = str(spec.get("start") or "").strip()
        mode = "dfs" if spec.get("mode") == "dfs" else "bfs"
        if len(nodes) < 2 or start not in nodes or not edges:
            return None
        return {
            **base,
            "type": "order",
            "nodes": nodes,
            "edges": edges,
            "start": start,
            "mode": mode,
        }
    if kind == "sort":
        arr = [x for x in (_to_num_or_str(v) for v in (spec.get("array") or [])) if x is not None]
        algo = "insertion" if spec.get("algo") == "insertion" else "bubble"
        try:
            steps = max(1, min(20, int(float(spec.get("steps"))) or 1))
        except (TypeError, ValueError):
            steps = 1
        if len(arr) < 3:
            return None
        return {
            **base,
            "type": "sort",
            "array": arr,
            "algo": algo,
            "steps": steps,
            "expected": simulate_sort(arr, algo, steps),
        }
    if kind == "blank":
        template = str(spec.get("template") or "")
        marks = template.count("___")
        blanks = []
        for b in spec.get("blanks") or []:
            b = b or {}
            out = {"answer": str(b.get("answer") if b.get("answer") is not None else "").strip()}
            alts = [str(x).strip() for x in (b.get("alts") or []) if str(x).strip()]
            if alts:
                out["alts"] = alts
            opts = [str(x).strip() for x in (b.get("options") or []) if str(x).strip()]
            if opts:
                out["options"] = opts
            blanks.append(out)
        if not marks or marks != len(blanks):
            return None
        if any(not b["answer"] for b in blanks):
            return None
        if any(b.get("options") and b["answer"] not in b["options"] for b in blanks):
            return None
        return {**base, "type": "blank", "template": template, "blanks": blanks}
    if kind == "graph":
        nodes = [str(n).strip() for n in (spec.get("nodes") or []) if str(n).strip()]
        if len(nodes) < 2:
            return None
        if spec.get("template") == "exact":
            req = [
                [str(e[0]).strip(), str(e[1]).strip()] for e in (spec.get("requiredEdges") or [])
            ]
            req = [e for e in req if e[0] in nodes and e[1] in nodes and e[0] != e[1]]
            if not req:
                return None
            return {**base, "type": "graph", "nodes": nodes, "requiredEdges": req}
        tpl = GRAPH_TEMPLATES.get(spec.get("template"))
        if not tpl:
            return None
        return {**base, "type": "graph", "nodes": nodes, "graphKind": tpl[1]}
    return None


def catalog_data():
    return [
        {
            "id": t["id"],
            "title": t["title"],
            "prompt": t["prompt"],
            "topic": t.get("topic"),
            "type": t["type"],
            "level": t.get("level", 1),
            "custom": bool(t.get("custom")),
        }
        for t in TASKS
    ]


def active_tasks(ids):
    if not ids:
        return list(TASKS)
    return [BY_ID[i] for i in ids if i in BY_ID]
