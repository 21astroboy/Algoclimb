/*
 * Банк задач. Каждая задача знает, как проверить ответ на сервере.
 * Правильные ответы НИКОГДА не отправляются клиенту (см. publicTask).
 *
 * Поля:
 *   id     — уникальный код (используется в config.activeTasks для выбора набора на лекцию)
 *   type   — "choice" | "graph"
 *   topic  — "asd" (алгоритмы и структуры данных) | "graphs" (теория графов)
 *   level  — 1..3 (сложность, для удобства сортировки/выбора)
 *   title, prompt
 *
 * Типы:
 *   "choice" — один правильный вариант (answer = индекс в options)
 *   "graph"  — построить неориентированный граф (порядок и направление рёбер не важны)
 *
 * Добавляй свои задачи по образцу. Чтобы выбрать, какие идут на конкретной лекции,
 * перечисли их id в config.json -> activeTasks (пустой список = все задачи).
 */

function edgeKey(a, b) { return [a, b].sort().join('-'); }
function edgeSet(edges) { return new Set((edges || []).map(e => edgeKey(e[0], e[1]))); }
function sameSet(a, b) { return a.size === b.size && [...a].every(x => b.has(x)); }
const choice = (i) => function (p) { return p.choice === i; };
const buildGraph = (req) => function (p) { return sameSet(edgeSet(p.edges), edgeSet(req)); };

// Принимает ЛЮБОЕ корректное остовное дерево исходного графа:
// рёбра — подмножество исходных, ровно (вершин−1) штук, связно и без циклов.
const spanningTreeOf = (orig) => {
  const origSet = edgeSet(orig);
  const nodes = new Set(orig.flat());
  return function (p) {
    const edges = p.edges || [];
    if (!edges.every(e => origSet.has(edgeKey(e[0], e[1])))) return false;
    if (edges.length !== nodes.size - 1) return false;
    const parent = {};
    [...nodes].forEach(v => (parent[v] = v));
    const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [a, b] of edges) {
      const ra = find(a), rb = find(b);
      if (ra === rb) return false;      // цикл
      parent[ra] = rb;
    }
    return new Set([...nodes].map(find)).size === 1; // связно
  };
};

/* ---------- проверки по СВОЙСТВАМ графа (принимают любой корректный ответ) ----------
 * Эти генераторы проверяют структуру ответа, а не совпадение с эталоном.
 * Каждый принимает список вершин nodes (метки), над которыми строится граф.       */

// Разобрать ответ студента в простой граф над набором nodes.
// Возвращает null, если есть ребро вне набора, петля или вершина не из набора.
function _g(p, nodes) {
  const N = new Set(nodes), seen = new Set(), adj = {};
  nodes.forEach(v => (adj[v] = new Set()));
  for (const e of (p.edges || [])) {
    const a = e[0], b = e[1];
    if (!N.has(a) || !N.has(b) || a === b) return null;
    const k = edgeKey(a, b);
    if (!seen.has(k)) { seen.add(k); adj[a].add(b); adj[b].add(a); }
  }
  return { adj, keys: seen, m: seen.size, nodes: [...nodes] };
}
function _comps(g) {
  const par = {}; g.nodes.forEach(v => (par[v] = v));
  const find = x => (par[x] === x ? x : (par[x] = find(par[x])));
  for (const k of g.keys) { const i = k.indexOf('-'); par[find(k.slice(0, i))] = find(k.slice(i + 1)); }
  return new Set(g.nodes.map(find)).size;
}
const _degs = g => g.nodes.map(v => g.adj[v].size);
function _color(g) {            // 2-раскраска; null если граф не двудольный
  const c = {};
  for (const s of g.nodes) {
    if (c[s] !== undefined) continue;
    c[s] = 0; const q = [s];
    while (q.length) { const u = q.shift();
      for (const w of g.adj[u]) {
        if (c[w] === undefined) { c[w] = c[u] ^ 1; q.push(w); }
        else if (c[w] === c[u]) return null;
      } }
  }
  return c;
}

// любой простой цикл, проходящий через ВСЕ вершины (2-регулярный связный граф)
const anyCycle = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  return g.m === nodes.length && _degs(g).every(d => d === 2) && _comps(g) === 1;
};
// простой путь через ВСЕ вершины без замыкания (две вершины степени 1, остальные 2)
const anyPath = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  if (g.m !== nodes.length - 1) return false;
  const d = _degs(g);
  return d.filter(x => x === 1).length === 2
    && d.filter(x => x === 2).length === nodes.length - 2
    && _comps(g) === 1;
};
// любое дерево на всех вершинах (n−1 ребро + связно)
const anyTree = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  return g.m === nodes.length - 1 && _comps(g) === 1;
};
// полный граф на всех вершинах
const anyComplete = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  const n = nodes.length;
  return g.m === n * (n - 1) / 2;
};
// любой ПОЛНЫЙ двудольный граф (связный, двудольный, рёбер = |X|·|Y|, обе доли непусты)
const anyCompleteBipartite = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  if (_comps(g) !== 1) return false;
  const c = _color(g); if (!c) return false;
  const X = g.nodes.filter(v => c[v] === 0).length, Y = g.nodes.length - X;
  return X > 0 && Y > 0 && g.m === X * Y;
};
// ровно k компонент связности, без изолированных вершин
const anyComponents = (nodes, k) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  if (_degs(g).some(d => d === 0)) return false;
  return _comps(g) === k;
};
// любое двоичное дерево: дерево + максимальная степень ≤ 3
const anyBinaryTree = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  return g.m === nodes.length - 1 && _comps(g) === 1 && _degs(g).every(d => d <= 3);
};
// гамильтонов цикл + одна хорда (две вершины степени 3, остальные 2, рёбер n+1)
const anyCycleChord = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  const n = nodes.length;
  if (g.m !== n + 1 || _comps(g) !== 1) return false;
  const d = _degs(g);
  return d.filter(x => x === 3).length === 2 && d.filter(x => x === 2).length === n - 2;
};
// эйлеров цикл: связный, все степени чётные и больше нуля
const anyEulerian = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  const d = _degs(g);
  return d.every(x => x > 0 && x % 2 === 0) && _comps(g) === 1;
};
// звезда: одна центральная вершина соединена со всеми остальными (n−1 ребро,
// одна вершина степени n−1, остальные степени 1), центр заранее не фиксирован
const anyStar = (nodes) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  const n = nodes.length;
  if (g.m !== n - 1 || _comps(g) !== 1) return false;
  const d = _degs(g);
  return d.filter(x => x === n - 1).length === 1
    && d.filter(x => x === 1).length === n - 1;
};
// лес из ровно k деревьев (ацикличный граф с k компонентами; изолированные вершины
// тоже считаются деревом-компонентой)
const anyForest = (nodes, k) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  return g.m === nodes.length - k && _comps(g) === k;
};
// d-регулярный связный граф (все вершины одной степени d)
const anyRegular = (nodes, d) => (p) => {
  const g = _g(p, nodes); if (!g) return false;
  return _comps(g) === 1 && _degs(g).every(x => x === d);
};

// Остовное дерево МИНИМАЛЬНОГО веса на взвешенном графе refEdges = [[a,b,w],...].
// Принимает любой набор рёбер из refEdges, образующий остов суммарного веса = весу MST.
const mstOf = (refEdges, nodes) => {
  const W = new Map(refEdges.map(([a, b, w]) => [edgeKey(a, b), w]));
  const sorted = [...refEdges].sort((x, y) => x[2] - y[2]);
  const par = {}; nodes.forEach(v => (par[v] = v));
  const find = x => (par[x] === x ? x : (par[x] = find(par[x])));
  let mstW = 0;
  for (const [a, b, w] of sorted) { const ra = find(a), rb = find(b); if (ra !== rb) { par[ra] = rb; mstW += w; } }
  return (p) => {
    const edges = p.edges || [];
    if (!edges.every(e => W.has(edgeKey(e[0], e[1])))) return false;
    if (edges.length !== nodes.length - 1) return false;
    const pp = {}; nodes.forEach(v => (pp[v] = v));
    const f = x => (pp[x] === x ? x : (pp[x] = f(pp[x])));
    let total = 0;
    for (const e of edges) {
      const ra = f(e[0]), rb = f(e[1]);
      if (ra === rb) return false;            // цикл
      pp[ra] = rb; total += W.get(edgeKey(e[0], e[1]));
    }
    if (new Set(nodes.map(f)).size !== 1) return false; // связно
    return total === mstW;
  };
};

/* ---------- ОБХОД ГРАФА: проверка корректного порядка BFS / DFS ----------
 * Граф задаётся вершинами nodes и рёбрами edges (неориентированный) и ПОКАЗЫВАЕТСЯ
 * студенту целиком — это условие, а не ответ. Студент кликает вершины в порядке
 * посещения; ответ = { order:[...] }. Проверки принимают ЛЮБОЙ корректный порядок
 * обхода (соседей можно посещать в любом порядке). start — стартовая вершина.   */
function _adjOf(nodes, edges) {
  const adj = {}; nodes.forEach(v => (adj[v] = new Set()));
  for (const e of (edges || [])) { if (adj[e[0]] && adj[e[1]] && e[0] !== e[1]) { adj[e[0]].add(e[1]); adj[e[1]].add(e[0]); } }
  return adj;
}
function _seqOk(seq, nodes) {
  return Array.isArray(seq) && seq.length === nodes.length
    && new Set(seq).size === nodes.length && seq.every(v => nodes.includes(v));
}
// корректный порядок обхода в глубину (preorder) из стартовой вершины
const validDFSOrder = (nodes, edges, start) => {
  const adj = _adjOf(nodes, edges);
  return (p) => {
    const seq = (p && p.order) || [];
    if (!_seqOk(seq, nodes) || seq[0] !== start) return false;
    const visited = new Set([start]); const stack = [start]; let i = 1;
    while (i < seq.length) {
      if (!stack.length) return false;
      const u = stack[stack.length - 1];
      let hasUnvisited = false;
      for (const w of adj[u]) if (!visited.has(w)) { hasUnvisited = true; break; }
      if (hasUnvisited) {
        const v = seq[i];
        if (visited.has(v) || !adj[u].has(v)) return false;
        visited.add(v); stack.push(v); i++;
      } else stack.pop();
    }
    return visited.size === nodes.length;
  };
};
// корректный порядок обхода в ширину из стартовой вершины
const validBFSOrder = (nodes, edges, start) => {
  const adj = _adjOf(nodes, edges);
  return (p) => {
    const seq = (p && p.order) || [];
    if (!_seqOk(seq, nodes) || seq[0] !== start) return false;
    const visited = new Set([start]); const queue = [start]; let i = 1;
    while (queue.length) {
      const u = queue.shift();
      const nbrs = [...adj[u]].filter(w => !visited.has(w));
      const block = seq.slice(i, i + nbrs.length);
      if (block.length !== nbrs.length) return false;
      const bs = new Set(block);
      if (bs.size !== nbrs.length || !nbrs.every(w => bs.has(w))) return false;
      for (const v of block) { visited.add(v); queue.push(v); }
      i += nbrs.length;
    }
    return i === seq.length && visited.size === nodes.length;
  };
};
// один корректный порядок обхода — пример для экрана преподавателя
function sampleOrder(nodes, edges, start, mode) {
  const adj = _adjOf(nodes, edges); const order = []; const visited = new Set();
  if (mode === 'bfs') {
    const q = [start]; visited.add(start);
    while (q.length) { const u = q.shift(); order.push(u);
      [...adj[u]].sort().forEach(w => { if (!visited.has(w)) { visited.add(w); q.push(w); } }); }
  } else {
    (function dfs(u) { visited.add(u); order.push(u);
      [...adj[u]].sort().forEach(w => { if (!visited.has(w)) dfs(w); }); })(start);
  }
  return order;
}
// конструктор задачи-обхода (хранит данные и собирает check)
function orderTask(o) {
  return Object.assign({ type: 'order' }, o,
    { check: (o.mode === 'bfs' ? validBFSOrder : validDFSOrder)(o.nodes, o.edges, o.start) });
}

/* ===================== ПОШАГОВАЯ СОРТИРОВКА (тип sort) ===================== */
// Симуляция нескольких «шагов» сортировки. Шаг bubble = один проход внешнего цикла
// (соседние обмены до конца неотсортированной части). Шаг insertion = вставка очередного
// элемента на своё место в отсортированном префиксе. Возвращает состояние массива.
function simulateSort(arr, algo, steps) {
  const a = arr.slice(); const n = a.length;
  if (algo === 'insertion') {
    for (let s = 0; s < steps && s < n - 1; s++) {
      let j = s + 1;
      while (j > 0 && a[j - 1] > a[j]) { [a[j - 1], a[j]] = [a[j], a[j - 1]]; j--; }
    }
  } else { // bubble
    for (let s = 0; s < steps && s < n - 1; s++) {
      for (let j = 0; j < n - 1 - s; j++) {
        if (a[j] > a[j + 1]) [a[j], a[j + 1]] = [a[j + 1], a[j]];
      }
    }
  }
  return a;
}
function _arrEq(x, y) {
  return Array.isArray(x) && Array.isArray(y) && x.length === y.length
    && x.every((v, i) => String(v) === String(y[i]));
}
// конструктор задачи-сортировки. expected (результат после steps шагов) — для проверки,
// студенту НЕ отправляется.
function sortTask(o) {
  const expected = o.expected ? o.expected.slice() : simulateSort(o.array, o.algo, o.steps);
  return Object.assign({ type: 'sort' }, o, {
    expected,
    check: (p) => _arrEq((p && p.array) || [], expected)
  });
}

/* ---------- Параметризация чисел (анти-чит) ----------
   Цель: на каждую игру у sort-задачи свежий массив, поэтому пересланный/готовый
   из ИИ ответ не подходит — нужно реально считать. Условие sort-задач не содержит
   вшитых чисел (массив показывается плитками отдельно), поэтому замена безопасна:
   меняем array и пересчитываем expected; title/prompt/hint остаются валидны. */
function _randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function genSortArray(len) {
  const hi = Math.max(len * 3, 12);
  for (let tries = 0; tries < 60; tries++) {
    const set = new Set();
    while (set.size < len) set.add(_randInt(1, hi));
    const arr = [...set];
    for (let i = arr.length - 1; i > 0; i--) {        // перемешать
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const sorted = arr.every((x, i) => i === 0 || arr[i - 1] <= x);
    if (!sorted) return arr;                            // не отдаём уже отсортированный
  }
  return null;
}
// Возвращает параметризованную КОПИЮ задачи (свежие числа) либо исходную задачу.
// Банк не мутируется — sortTask() собирает новый объект. Кастомные задачи не трогаем
// (их prompt может содержать конкретные числа). Хук t.paramize(rng) — для будущих
// генераторов под отдельные типы.
function paramizeTask(t) {
  if (!t || t.custom) return t;
  if (typeof t.paramize === 'function') {
    try { const v = t.paramize(); if (v) return v; } catch (e) {}
    return t;
  }
  if (t.type === 'sort' && t.paramize !== false) {
    const len = (t.array || []).length;
    if (len >= 3) {
      const arr = genSortArray(len);
      if (arr) return sortTask(Object.assign({}, t, { array: arr, expected: null }));
    }
  }
  return t;
}

/* ===================== ЗАПОЛНЕНИЕ ПРОПУСКОВ (тип blank) ===================== */
// template — строка с маркерами «___» (три подчёркивания) по числу пропусков.
// blanks[i] = { answer, alts?:[...], options?:[...] }. Если есть options — это выбор из
// списка (правильный = answer, обязан быть среди options); иначе ввод текста
// (принимается answer и любой alts, без учёта регистра и крайних пробелов).
function _norm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }
function _blankOk(blank, val) {
  if (Array.isArray(blank.options) && blank.options.length) return String(val) === String(blank.answer);
  const accept = new Set([blank.answer, ...(blank.alts || [])].map(_norm));
  return accept.has(_norm(val));
}
function blankTask(o) {
  return Object.assign({ type: 'blank' }, o, {
    check: (p) => {
      const vals = (p && p.blanks) || [];
      if (!Array.isArray(vals) || vals.length !== o.blanks.length) return false;
      return o.blanks.every((b, i) => _blankOk(b, vals[i]));
    }
  });
}

// ------------------------------------------------------------------
// Банк задач вынесен в отдельный файл task-bank.js (в .gitignore, чтобы
// студенты не нашли ответы в публичном репозитории). Здесь мы передаём
// в него конструкторы проверок и получаем готовый массив задач.
// Если приватного банка нет — используется демо-набор task-bank.example.js.
// ------------------------------------------------------------------
const TASK_HELPERS = { choice, buildGraph, anyCycle, anyPath, anyTree, anyComplete, anyCompleteBipartite, anyComponents, anyBinaryTree, anyCycleChord, anyEulerian, anyStar, anyForest, mstOf, orderTask, sortTask, blankTask };
let _loadBank;
try { _loadBank = require('./task-bank'); }
catch (e1) {
  try { _loadBank = require('./task-bank.example'); }
  catch (e2) {
    throw new Error('AlgoClimb: не найден банк задач. Создайте task-bank.js (образец — task-bank.example.js). Исходная ошибка: ' + e1.message);
  }
}
const TASKS = _loadBank(TASK_HELPERS);

// Версия задачи для отправки клиенту — без правильных ответов!
function publicTask(t) {
  const base = { id: t.id, type: t.type, title: t.title, prompt: t.prompt, topic: t.topic };
  // Подсказки (hint) НЕ отправляем студентам — они слишком сильно облегчают задачу.
  // hint остаётся доступен преподавателю через answerText (см. ниже).
  if (t.type === 'choice') base.options = t.options;
  if (t.type === 'graph') {
    base.nodes = t.nodes
      ? t.nodes.slice()
      : [...new Set(t.requiredEdges.flat())].sort();
    if (t.weighted && t.refEdges) {        // взвешенный граф: рёбра-«заготовки» с весами
      base.weighted = true;
      base.refEdges = t.refEdges.map(([a, b, w]) => [a, b, w]);
    }
  }
  if (t.type === 'order') {                 // обход: граф показывается целиком (это условие, не ответ)
    base.nodes = t.nodes.slice();
    base.edges = t.edges.map(e => [e[0], e[1]]);
    base.start = t.start;
    base.mode = t.mode;
  }
  if (t.type === 'sort') {                   // сортировка: исходный массив + что за шаг (без результата!)
    base.array = t.array.slice();
    base.algo = t.algo;
    base.steps = t.steps;
  }
  if (t.type === 'blank') {                  // пропуски: шаблон + тип каждого пропуска (для выбора — варианты, БЕЗ отметки верного)
    base.template = t.template;
    base.blanks = t.blanks.map(b => (Array.isArray(b.options) && b.options.length)
      ? { options: b.options.slice() }
      : {});
  }
  return base;
}

// Человекочитаемый ПРАВИЛЬНЫЙ ответ — ТОЛЬКО для экрана преподавателя.
// Никогда не отправляется студентам (см. использование на сервере).
function _kruskal(refEdges, nodes) {
  const sorted = [...refEdges].sort((a, b) => a[2] - b[2]);
  const par = {}; nodes.forEach(v => (par[v] = v));
  const find = x => (par[x] === x ? x : (par[x] = find(par[x])));
  const out = [];
  for (const [a, b, w] of sorted) { const ra = find(a), rb = find(b); if (ra !== rb) { par[ra] = rb; out.push([a, b, w]); } }
  return out;
}
function answerText(t) {
  if (t.type === 'choice') return t.options[t.answer];
  if (t.type === 'graph') {
    if (t.weighted && t.refEdges) {
      const mst = _kruskal(t.refEdges, t.nodes);
      const w = mst.reduce((s, e) => s + e[2], 0);
      return 'Минимальный остов (суммарный вес ' + w + '): ' +
        mst.map(e => e[0] + '–' + e[1] + ' (' + e[2] + ')').join(', ');
    }
    if (t.requiredEdges) return 'Рёбра: ' + t.requiredEdges.map(e => e[0] + '–' + e[1]).join(', ');
    const base = t.hint ? ('Любой граф с нужным свойством. ' + t.hint) : 'Любой граф с нужным свойством.';
    const ex = (t.example && t.example.length) ? (' Пример: ' + t.example.map(e => e[0] + '–' + e[1]).join(', ') + '.') : '';
    return base + ex;
  }
  if (t.type === 'order') {
    const ex = sampleOrder(t.nodes, t.edges, t.start, t.mode).join(' → ');
    return (t.mode === 'bfs' ? 'BFS' : 'DFS') + ' из ' + t.start + ' — например: ' + ex +
      ' (принимается любой корректный порядок обхода)';
  }
  if (t.type === 'sort') {
    const exp = (t.expected || simulateSort(t.array, t.algo, t.steps)).join(', ');
    return 'После ' + t.steps + ' шаг(ов) ' +
      (t.algo === 'insertion' ? 'сортировки вставками' : 'пузырьковой сортировки') +
      ': [' + exp + ']';
  }
  if (t.type === 'blank') {
    return t.blanks.map((b, i) => (i + 1) + ') ' + b.answer +
      ((b.alts && b.alts.length) ? ' (или: ' + b.alts.join(', ') + ')' : '')).join('; ');
  }
  return '';
}

// Конкретные рёбра «эталонного» ответа для рисунка (только графовые задачи).
// Возвращает { nodes, edges:[[a,b]|[a,b,w]], weighted } либо null, если точного ответа нет
// (для свойств-задач — «любой граф с нужным свойством», рисуем только ответ студента).
function answerEdges(t) {
  if (t.type === 'order') {                 // для разбора показываем сам граф обхода
    return { nodes: t.nodes || [], edges: (t.edges || []).map(e => [e[0], e[1]]), weighted: false };
  }
  if (t.type !== 'graph') return null;
  if (t.weighted && t.refEdges) {
    return { nodes: t.nodes || [], edges: _kruskal(t.refEdges, t.nodes), weighted: true };
  }
  if (t.requiredEdges) {
    return { nodes: t.nodes || [], edges: t.requiredEdges.map(e => [e[0], e[1]]), weighted: false };
  }
  if (t.example && t.example.length) {          // property-задача: рисуем конкретный пример
    return { nodes: t.nodes || [], edges: t.example.map(e => [e[0], e[1]]), weighted: false };
  }
  return null;
}

/* ---------- Конкретный пример для «любой граф с нужным свойством» ----------
   Для property-графов (тип graph без requiredEdges) подбираем валидный пример,
   прогоняя сам check задачи. Детерминированно (seed из id) — ключ ответа стабилен
   между запусками. Сначала осмысленные конструкции (путь, звезда, цикл, дерево,
   клики, полный двудольный), затем случайный поиск; пустой/полный — в последнюю
   очередь, чтобы пример был «красивым». */
function _seededRng(seed) {
  let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0; s = s || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function _allPairs(nodes) {
  const e = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) e.push([nodes[i], nodes[j]]);
  return e;
}
function findGraphExample(t) {
  if (!t || t.type !== 'graph' || typeof t.check !== 'function') return null;
  const nodes = (t.nodes || []).slice(); if (!nodes.length) return null;
  const pairs = _allPairs(nodes); const n = nodes.length;
  const rng = _seededRng(t.id || 'x');
  const ok = edges => { try { return !!t.check({ edges }); } catch (e) { return false; } };
  const cands = [];
  cands.push(nodes.slice(1).map((v, i) => [nodes[i], v]));                 // путь
  // полные двудольные всех разбиений — сбалансированные доли первыми (чтобы пример
  // выглядел как две доли, а не как звезда)
  const popcount = m => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
  const masks = [];
  for (let mask = 1; mask < (1 << n) - 1; mask++) masks.push(mask);
  masks.sort((a, b) => Math.abs(popcount(a) - n / 2) - Math.abs(popcount(b) - n / 2));
  for (const mask of masks.slice(0, 200)) {
    const e = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (((mask >> i) & 1) !== ((mask >> j) & 1)) e.push([nodes[i], nodes[j]]);
    cands.push(e);
  }
  cands.push(nodes.slice(1).map(v => [nodes[0], v]));                      // звезда
  { const p = nodes.slice(1).map((v, i) => [nodes[i], v]); if (n > 2) p.push([nodes[n - 1], nodes[0]]); cands.push(p); } // цикл
  { const e = []; for (let i = 0; i < n; i++) { const l = 2 * i + 1, r = 2 * i + 2; if (l < n) e.push([nodes[i], nodes[l]]); if (r < n) e.push([nodes[i], nodes[r]]); } cands.push(e); } // бинарное дерево
  for (const k of [2, 3, 4]) {                                            // k непересекающихся клик (компоненты)
    if (k >= n) continue;
    const groups = Array.from({ length: k }, () => []); nodes.forEach((v, i) => groups[i % k].push(v));
    const e = []; for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) e.push([g[i], g[j]]);
    cands.push(e);
  }
  for (let tries = 0; tries < 400; tries++) {                             // случайное дерево + добавочные рёбра
    const perm = nodes.slice();
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    const tree = []; for (let i = 1; i < perm.length; i++) { const j = Math.floor(rng() * i); tree.push([perm[i], perm[j]]); }
    cands.push(tree.slice());
    const extra = tree.slice(); const seen = new Set(tree.map(e => [e[0], e[1]].sort().join('-')));
    const add = Math.floor(rng() * pairs.length);
    for (let a = 0; a < add; a++) { const p = pairs[Math.floor(rng() * pairs.length)]; const k = [p[0], p[1]].sort().join('-'); if (!seen.has(k)) { seen.add(k); extra.push([p[0], p[1]]); } }
    cands.push(extra);
  }
  for (let tries = 0; tries < 400; tries++) { const p = 0.15 + rng() * 0.7; cands.push(pairs.filter(() => rng() < p)); } // случайные подмножества
  cands.push(pairs.slice());                                             // полный
  cands.push([]);                                                        // пустой (в последнюю очередь)
  for (const e of cands) if (ok(e)) return e.map(x => [x[0], x[1]]);
  return null;
}
// Предрасчёт примеров для всех property-графов (один раз при загрузке модуля).
for (const t of TASKS) {
  if (t.type === 'graph' && !t.requiredEdges && !(t.weighted && t.refEdges) && !t.example) {
    const ex = findGraphExample(t); if (ex) t.example = ex;
  }
}

/* ---------- КОНСТРУКТОР ЗАДАЧ (создание задач из интерфейса преподавателя) ----------
 * Преподаватель присылает «плоскую» спецификацию (без функций); сервер собирает из неё
 * полноценную задачу с функцией-проверкой. Сами проверки НИКОГДА не сериализуются —
 * правильные ответы остаются на сервере.                                            */

// Доступные шаблоны графовых задач (для выпадающего списка в конструкторе).
const GRAPH_TEMPLATES = {
  tree:       { label: 'Любое дерево (n−1 ребро, связно)',        make: anyTree },
  cycle:      { label: 'Цикл через все вершины',                  make: anyCycle },
  path:       { label: 'Простой путь через все вершины',          make: anyPath },
  complete:   { label: 'Полный граф (все пары соединены)',        make: anyComplete },
  star:       { label: 'Звезда (один центр)',                     make: anyStar },
  bipartite:  { label: 'Полный двудольный граф',                  make: anyCompleteBipartite },
  binarytree: { label: 'Двоичное дерево (степени ≤ 3)',           make: anyBinaryTree }
};
// Список шаблонов для клиента (без функций).
function graphTemplateList() {
  return Object.keys(GRAPH_TEMPLATES).map(k => ({ key: k, label: GRAPH_TEMPLATES[k].label }))
    .concat([{ key: 'exact', label: 'Точный граф (по списку рёбер)' }]);
}

function buildCustomTask(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const id = String(spec.id || ('custom_' + Date.now() + '_' + Math.floor(Math.random() * 1000)));
  const topic = (spec.topic === 'asd' || spec.topic === 'graphs') ? spec.topic : 'graphs';
  const level = [1, 2, 3].includes(+spec.level) ? +spec.level : 1;
  const title = String(spec.title || '').trim();
  const prompt = String(spec.prompt || '').trim();
  if (!title || !prompt) return null;
  const base = { id, topic, level, title, prompt, custom: true };
  if (spec.hint) base.hint = String(spec.hint).trim();

  if (spec.kind === 'choice') {
    const options = Array.isArray(spec.options) ? spec.options.map(o => String(o)).filter(o => o.length) : [];
    const answer = +spec.answer;
    if (options.length < 2 || !(answer >= 0 && answer < options.length)) return null;
    return Object.assign(base, { type: 'choice', options, answer, check: choice(answer) });
  }
  if (spec.kind === 'order') {
    const nodes = Array.isArray(spec.nodes) ? spec.nodes.map(n => String(n).trim()).filter(Boolean) : [];
    const edges = Array.isArray(spec.edges) ? spec.edges
      .map(e => [String(e[0]).trim(), String(e[1]).trim()])
      .filter(e => nodes.includes(e[0]) && nodes.includes(e[1]) && e[0] !== e[1]) : [];
    const start = String(spec.start || '').trim();
    const mode = spec.mode === 'dfs' ? 'dfs' : 'bfs';
    if (nodes.length < 2 || !nodes.includes(start) || !edges.length) return null;
    return orderTask(Object.assign(base, { nodes, edges, start, mode }));
  }
  if (spec.kind === 'sort') {
    const array = Array.isArray(spec.array)
      ? spec.array.map(x => { const s = String(x).trim(); const n = Number(s); return (s !== '' && !isNaN(n)) ? n : s; })
                  .filter(x => x !== '')
      : [];
    const algo = spec.algo === 'insertion' ? 'insertion' : 'bubble';
    const steps = Math.max(1, Math.min(20, Math.floor(+spec.steps) || 1));
    if (array.length < 3) return null;
    return sortTask(Object.assign(base, { array, algo, steps }));
  }
  if (spec.kind === 'blank') {
    const template = String(spec.template || '');
    const marks = (template.match(/___/g) || []).length;
    const blanks = Array.isArray(spec.blanks) ? spec.blanks.map(b => {
      const out = { answer: String(b && b.answer != null ? b.answer : '').trim() };
      if (Array.isArray(b.alts)) { const a = b.alts.map(x => String(x).trim()).filter(Boolean); if (a.length) out.alts = a; }
      if (Array.isArray(b.options)) { const o = b.options.map(x => String(x).trim()).filter(Boolean); if (o.length) out.options = o; }
      return out;
    }) : [];
    if (!marks || marks !== blanks.length) return null;
    if (blanks.some(b => !b.answer)) return null;
    if (blanks.some(b => b.options && !b.options.includes(b.answer))) return null;
    return blankTask(Object.assign(base, { template, blanks }));
  }
  if (spec.kind === 'graph') {
    const nodes = Array.isArray(spec.nodes) ? spec.nodes.map(n => String(n).trim()).filter(Boolean) : [];
    if (nodes.length < 2) return null;
    if (spec.template === 'exact') {
      const req = Array.isArray(spec.requiredEdges) ? spec.requiredEdges
        .map(e => [String(e[0]).trim(), String(e[1]).trim()])
        .filter(e => nodes.includes(e[0]) && nodes.includes(e[1]) && e[0] !== e[1]) : [];
      if (!req.length) return null;
      return Object.assign(base, { type: 'graph', nodes, requiredEdges: req, check: buildGraph(req) });
    }
    const tpl = GRAPH_TEMPLATES[spec.template];
    if (!tpl) return null;
    return Object.assign(base, { type: 'graph', nodes, template: spec.template, check: tpl.make(nodes) });
  }
  return null;
}

// Активный набор на лекцию: если config.activeTasks непустой — берём только эти id (в указанном порядке).
function activeTasks(ids) {
  if (!ids || ids.length === 0) return TASKS.slice();
  const byId = new Map(TASKS.map(t => [t.id, t]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

module.exports = { TASKS, publicTask, activeTasks, answerText, answerEdges, buildCustomTask, graphTemplateList, paramizeTask, genSortArray, simulateSort };
