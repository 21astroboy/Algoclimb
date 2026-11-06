# Writing question banks

[English](task-bank.md) · [Русский](task-bank.ru.md) · [README](../README.md)

A bank is a UTF-8 JSON **array of task objects**. Content can be English, Russian or
another language; the app does not translate it. `choice` and `blank` fit any subject;
`graph`, `order` and `sort` add interactive exercises for algorithms and graph theory.

## Files and loading

Store your bank at `secrets/task-bank.json` and optional explanations at
`secrets/explanations.json`. With Docker these are mounted into the app; rebuild or
restart the app after editing the bank. Keep private banks, answer keys and service-account
credentials out of Git.

Bank lookup: `TASK_BANK_PATH`, `secrets/task-bank.json`, `backend/data/task-bank.json`,
then the public `backend/data/task-bank.example.json` fallback. Explanations use
`EXPLANATIONS_PATH`, then `secrets/explanations.json` or `backend/data/explanations.json`.
An existing malformed file is an error, not a reason to rely on the next fallback.

## Common fields

| Field | Meaning |
| --- | --- |
| `id` | Unique stable string; used to match answers and explanations. |
| `type` | `choice`, `graph`, `order`, `sort` or `blank`. |
| `title` | Short title shown in the session builder. |
| `prompt` | Instructions: state exactly what the student must submit. |
| `topic` | Arbitrary topic string; creates a filter in the builder. |
| `level` | Difficulty 1–3; affects points for correct answers. |
| `timeLimit` | Optional positive time limit in seconds, overriding the type default. |
| `block` | Optional string grouping questions into a reusable set. |
| `hint` | Optional author hint; also used by some generated answer descriptions. Put essential instructions in `prompt`. |
| `figure` | Optional inline SVG string displayed above the question; use trusted bank content. |

The JSON below shows one object at a time. Put objects inside `[` and `]`, separated
by commas, to create a complete bank. Do not add comments or trailing commas to JSON.

## 1. Multiple choice — `choice`

Students tap **one** option. `answer` is the **zero-based** index in the original bank;
options are shuffled when a round begins. It is not a multiple-select question.

```json
{
  "id": "demo_stack",
  "type": "choice",
  "topic": "asd",
  "level": 1,
  "title": "Stack",
  "prompt": "Which access rule does a stack follow?",
  "options": [
    "FIFO — first in, first out",
    "LIFO — last in, first out",
    "Random access by index",
    "Sorted on every insertion"
  ],
  "answer": 1
}
```

Here the correct index is `1`: LIFO. Use it for definitions, complexity, counting,
or interpreting a short code snippet. A wrong but structurally valid selection spends
the attempt; malformed payloads do not.

## 2. Build or select a graph — `graph`

### Exact edge set

Students drag between vertices to add edges; the final edge set must match
`requiredEdges`. Edge order and orientation do not matter for these **undirected** graphs.
No extra edge is allowed. A triangle requires A–B, B–C and A–C.

```json
{
  "id": "demo_triangle",
  "type": "graph",
  "topic": "graphs",
  "level": 1,
  "title": "Build a triangle",
  "prompt": "Connect A, B and C so that every pair of vertices is joined.",
  "nodes": [
    "A",
    "B",
    "C"
  ],
  "requiredEdges": [
    [
      "A",
      "B"
    ],
    [
      "B",
      "C"
    ],
    [
      "A",
      "C"
    ]
  ]
}
```

### A graph with a property

Use `graphKind` instead of `requiredEdges` when several constructions should count as
correct. `example` illustrates one valid solution in the answer key; it does **not**
restrict the grader to that solution.

```json
{
  "id": "demo_tree4",
  "type": "graph",
  "topic": "graphs",
  "level": 2,
  "title": "A tree on four vertices",
  "prompt": "Build any tree on A, B, C and D: a connected graph with exactly three edges and no cycles.",
  "nodes": [
    "A",
    "B",
    "C",
    "D"
  ],
  "graphKind": "anyTree",
  "example": [
    [
      "A",
      "B"
    ],
    [
      "B",
      "C"
    ],
    [
      "C",
      "D"
    ]
  ],
  "hint": "A tree with n vertices has n − 1 edges and no cycles."
}
```

Both A–B–C–D and the star A–B, A–C, A–D satisfy `anyTree`.

| `graphKind` | What the current checker accepts | `graphArg` |
| --- | --- | --- |
| `anyTree` | Connected graph with n−1 edges. | — |
| `anyPath` | A connected path through all vertices. | — |
| `anyCycle` | A connected cycle through all vertices. | — |
| `anyComplete` | Every pair of vertices is joined. | — |
| `anyCompleteBipartite` | Connected complete bipartite graph; either part is nonempty. | — |
| `anyComponents` | Exactly k components **without isolated vertices**. | k |
| `anyBinaryTree` | A tree with maximum degree 3; no root or child direction is checked. | — |
| `anyCycleChord` | Connected n+1-edge graph with two degree-3 vertices and all others degree 2. | — |
| `anyEulerian` | Connected graph with positive even degree at every vertex. | — |
| `anyStar` | A star on all supplied vertices. | — |
| `anyForest` | A forest with k components; isolated vertices are allowed. | k |
| `anyRegular` | Connected k-regular graph. | k |

These are simple undirected graphs. Use distinct vertex labels. In particular,
`anyBinaryTree` does not check a rooted binary search tree, and `anyCycleChord`
checks the degree/edge conditions above rather than a separately verified Hamiltonian cycle.

### Minimum spanning tree (weighted graph)

With `weighted: true` and `refEdges`, students select edges from the supplied graph.
Each reference edge is `[from, to, weight]`. The answer must be a spanning tree with
the minimum total weight; alternative minimum trees are accepted.

```json
{
  "id": "mst_triangle",
  "type": "graph",
  "topic": "graphs",
  "level": 2,
  "title": "Minimum spanning tree",
  "prompt": "Select a minimum spanning tree of the weighted graph.",
  "nodes": [
    "A",
    "B",
    "C"
  ],
  "weighted": true,
  "refEdges": [
    [
      "A",
      "B",
      2
    ],
    [
      "B",
      "C",
      3
    ],
    [
      "A",
      "C",
      8
    ]
  ]
}
```

For this example, A–B and B–C have total weight **5**. A–C is too expensive.
Provide a connected reference graph; do not use `requiredEdges` for an MST exercise.

## 3. Traversal order — `order`

Students select vertices in their visit order. Supply `nodes`, the undirected `edges`,
a `start` vertex and `mode: "bfs"` or `"dfs"`. Every vertex must appear exactly once,
starting at `start`. Use a connected graph: the checker expects a single traversal
covering all supplied vertices.

```json
{
  "id": "demo_bfs",
  "type": "order",
  "topic": "graphs",
  "level": 1,
  "title": "Breadth-first search (BFS)",
  "prompt": "Run BFS from A. Select the vertices in their visit order.",
  "nodes": [
    "A",
    "B",
    "C",
    "D",
    "E"
  ],
  "edges": [
    [
      "A",
      "B"
    ],
    [
      "A",
      "C"
    ],
    [
      "B",
      "D"
    ],
    [
      "C",
      "D"
    ],
    [
      "C",
      "E"
    ]
  ],
  "start": "A",
  "mode": "bfs",
  "hint": "Use a queue: visit A, then its neighbors, then the next layer."
}
```

A valid BFS answer is **A → B → C → D → E**. Another is
**A → C → B → D → E**, because neighbor order is not fixed. The checker validates
the traversal, not one hard-coded reference sequence. DFS similarly accepts valid
neighbor choices, but requires following the depth-first stack before backtracking.

Do not describe an alphabetical tie-break as mandatory unless you also extend the
checker: it currently accepts other valid neighbor orders.

## 4. Sorting steps — `sort`

Students rearrange the supplied numbers into the array state **after the requested
number of steps**, rather than always sorting the entire array.

```json
{
  "id": "demo_bubble",
  "type": "sort",
  "topic": "asd",
  "level": 1,
  "title": "Bubble sort: one pass",
  "prompt": "Arrange the values as they appear after ONE left-to-right pass of ascending bubble sort.",
  "array": [
    5,
    2,
    8,
    1,
    9,
    3
  ],
  "algo": "bubble",
  "steps": 1,
  "expected": [
    2,
    5,
    1,
    8,
    3,
    9
  ],
  "hint": "Compare adjacent values from left to right. The largest value moves to the end."
}
```

After one left-to-right bubble pass, `[5, 2, 8, 1, 9, 3]` becomes
**`[2, 5, 1, 8, 3, 9]`**. A completely sorted array is incorrect for this prompt.

- `algo: "bubble"`: one step is one left-to-right pass through the remaining unsorted part.
- `algo: "insertion"`: one step inserts the next value into the sorted prefix.
  For `[4, 1, 3, 2]`, one step gives `[1, 4, 3, 2]`, two give `[1, 3, 4, 2]`.
- `steps`: number of passes/insertions; `expected`: the exact resulting array.
  For hand-written banks, supply `expected`; it is the array compared by the grader.
- With `paramize.enabled: true`, the server can replace sort arrays with random ones
  and recompute `expected` per session. Set it to `false` for reproducible authored examples.

## 5. Fill in the blanks — `blank`

Each `___` in `template` becomes one field, matched to the corresponding entry in
`blanks`. A field with `options` is a dropdown; without it, students type text.

```json
{
  "id": "demo_blank",
  "type": "blank",
  "topic": "asd",
  "level": 1,
  "title": "Fill in the blanks: stack",
  "prompt": "Complete the description of a stack.",
  "template": "A stack follows the ___ rule. The ___ operation adds an item.",
  "blanks": [
    {
      "answer": "LIFO",
      "alts": [
        "last in first out"
      ]
    },
    {
      "answer": "push",
      "options": [
        "push",
        "pop",
        "peek"
      ]
    }
  ]
}
```

The accepted pair is **LIFO, push**. All blanks must be correct for the task to count
as correct; there is no per-blank partial credit.

Free text ignores letter case and normalizes surrounding/repeated whitespace.
`alts` adds accepted variants; it is not fuzzy matching or arbitrary code evaluation.
Dropdowns use exact option strings. Keep `answer` among `options` and keep the number
of `___` markers equal to the number of `blanks`.

A second example outside computer science: `"The number of permutations of three objects is ___."`
with `"blanks": [{"answer": "6", "alts": ["3!", "six"]}]`.

## Figures, formulas and explanations

Use `$...$` or `$$...$$` for KaTeX formulas in question text, for example
`"How many edges does $K_5$ have?"`. `figure` can contain an SVG string with a
`viewBox`, for example a Venn diagram. Escape double quotes inside JSON strings.
Figures illustrate the prompt and do not automatically define grading rules.

Explanations are separate from the bank, keyed by task ID:

```json
{
  "demo_stack": "A stack removes the most recently inserted item first.",
  "demo_triangle": "Three vertices have three unordered pairs, so the triangle needs three edges."
}
```

They appear in the student's final question review. Answer keys and explanations
belong on the server; never embed a private bank in public frontend assets.

## Before using a new bank

1. Check JSON syntax: `python -m json.tool secrets/task-bank.json > /dev/null`.
2. Check unique IDs, known types, referenced vertices, answer indices and blank counts.
3. Read each prompt alongside its checker semantics above. State the start vertex,
   number of sorting steps, or graph property explicitly.
4. Restart the app, select the tasks and run a **Practice** session from a phone.
5. Try one correct and one incorrect answer; inspect the teacher key and final review.

JSON syntax validation does not validate the full task schema. Use the
[public demo bank](../backend/data/task-bank.example.json) and the
[English screenshot fixture](../tools/fixtures/screenshot-bank.en.json) as working references.
