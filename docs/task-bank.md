# Writing a question bank

The interface is English. Question text, titles, options, answers and explanations
can be written in Russian, English or any other language. Save JSON files as UTF-8.

## File layout

The app is not tied to a subject: its content is fully defined by the task bank — a JSON file
that the teacher prepares. The UI builds filters for topics, types, levels, and sets from
whatever is present in the bank.

The bank is loaded from the first available source, in priority order: the path in the
`TASK_BANK_PATH` variable, then `secrets/task-bank.json`, then `backend/data/task-bank.json`.
If none is found, the demo bank `backend/data/task-bank.example.json` is used. The private bank
is mounted from `secrets/` and is not part of the repository or the Docker image.

Each task is an object with the following fields:

| Field | Purpose |
|-------|---------|
| `id` | unique task identifier |
| `type` | question type (see below) |
| `topic` | topic; an arbitrary string that a filter is built from |
| `level` | difficulty `1`–`3`; affects scoring |
| `title` | short title |
| `prompt` | task text |
| `hint` | hint (optional) |
| `block` | membership in a task set (optional) |

Five question types are supported. Two of them are universal and fit any subject:

- **`choice`** — pick one option out of several.
- **`blank`** — fill in a gap: free text with accepted answers, or a pick from a dropdown.

The other three are specialized for algorithms and graph theory: **`graph`** (build a graph),
**`order`** (traversal order), and **`sort`** (sorting). For quizzes in other disciplines,
`choice` and `blank` are enough.

Task explanations are stored separately — in an `explanations.json` file (the source is set by
`EXPLANATIONS_PATH`, otherwise `secrets/explanations.json` or
`backend/data/explanations.json`). It is a JSON object where the key is a task `id` and the
value is the explanation text. The file is optional: if it is missing, no explanation is shown.
An explanation is shown to students after the session ends only for the tasks the teacher
described in it.

### Example bank

A bank is a JSON array of tasks. The two universal types (`choice` and `blank`) are enough for
any subject; topics and sets are arbitrary strings that the UI turns into filters. A two-task
example about databases:

```json
[
  {
    "id": "sql_join_inner",
    "type": "choice",
    "topic": "SQL: joins",
    "level": 1,
    "title": "INNER JOIN",
    "prompt": "What does an INNER JOIN of two tables return?",
    "options": [
      "Only rows whose key matches in both tables",
      "All rows from the left table",
      "All rows from both tables without a condition",
      "Rows that have no match"
    ],
    "answer": 0
  },
  {
    "id": "sql_group_by",
    "type": "blank",
    "topic": "SQL: aggregation",
    "level": 2,
    "title": "Count per city",
    "prompt": "Fill in the gaps to count the number of users in each city.",
    "hint": "An aggregate function plus grouping.",
    "block": "SQL: basics",
    "template": "SELECT city, ___(*) FROM users ___ BY city;",
    "blanks": [
      { "answer": "COUNT", "alts": ["count"] },
      { "answer": "GROUP", "options": ["GROUP", "ORDER", "HAVING"] }
    ]
  }
]
```

How to read it:

- Common fields on every task are `id`, `type`, `topic`, `level`, `title`, `prompt`; `hint` and
  `block` are optional.
- **`choice`:** `options` is the list of choices, `answer` is the index of the correct one
  (zero-based).
- **`blank`:** in `template`, each gap is marked with `___` (three underscores), and the
  `blanks` array describes them in order. A gap with an `options` list becomes a dropdown;
  without `options` it is free text, where `answer` is the reference value and `alts` are
  additional accepted variants (case and extra whitespace are ignored). The number of `___`
  must match the length of `blanks`.

The specialized `graph`, `order`, and `sort` types use extra fields (nodes, edges, a start
node, an array, and so on) — ready samples of each live in the demo bank
`backend/data/task-bank.example.json`.

Explanations for these tasks are wired up in `explanations.json` by `id`:

```json
{
  "sql_join_inner": "An INNER JOIN keeps only pairs of rows whose key matches in both tables.",
  "sql_group_by": "COUNT(*) counts the rows in each group, and GROUP BY city forms the groups by city."
}
```


See the [public demo bank](../backend/data/task-bank.example.json) for graph, traversal
and sorting examples. Private banks belong in `secrets/`, never in Git.
