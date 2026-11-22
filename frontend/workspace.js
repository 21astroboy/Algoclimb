'use strict';
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
let me,
  page = 'home',
  catalog = { sections: {}, tasks: [] },
  history = [],
  rooms = [],
  requests = [],
  keys = [],
  adminData;
let room,
  socket,
  state,
  report,
  reportTab = 'overview',
  selectedStudent,
  selectedQuestion,
  answerFilter = 'all',
  questionFilter = '',
  studentFilter = '',
  section = '',
  setFilter = '',
  picked = new Set(),
  geo = null,
  pendingImport = null,
  reconnectTimer,
  retry = 0;
let operation = 0;
const events = new Map();
let eventId = 0;
function button(label, callback, primary = false) {
  const id = ++eventId;
  events.set(id, callback);
  return `<button data-action="${id}" class="${primary ? 'primary' : ''}">${esc(label)}</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b)
    Promise.resolve()
      .then(() => events.get(Number(b.dataset.action))?.())
      .catch(fail);
});
function fail(e) {
  toast(e.message || String(e));
}
function toast(message) {
  $('toast').hidden = false;
  $('toast').className = 'toast';
  $('toast').textContent = message;
  setTimeout(() => ($('toast').hidden = true), 6500);
}
async function api(path, body, method) {
  const r = await fetch('/api/workspace' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error('Server unavailable. Retry in a moment.');
  }
  if (!r.ok)
    throw new Error(
      typeof data.detail === 'string' ? data.detail : 'Please check the form fields.'
    );
  return data;
}
function heading(title, sub = '', actions = '') {
  return `<div class="heading"><div><h1>${esc(title)}</h1><span class="muted">${esc(sub)}</span></div><div class="row">${actions}</div></div>`;
}
function modal(title, html) {
  $('overlay').innerHTML =
    `<div class="modalback"><div class="modal">${button('Close', closeModal)}<div class="space"></div><h2>${esc(title)}</h2>${html}</div></div>`;
}
function closeModal() {
  $('overlay').innerHTML = '';
  pruneActions();
}
function input(id, label, value = '', type = 'text') {
  return `<label for="${id}">${esc(label)}</label><input id="${id}" class="full" type="${type}" value="${esc(value)}" required>`;
}
function field(id, label, options, value) {
  return `<label for="${id}">${esc(label)}</label><select id="${id}" class="full">${options.map(([v, n]) => `<option value="${esc(v)}" ${value === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
}
function formError() {
  return '<p id="formError" class="error" hidden></p>';
}
async function formTask(fn) {
  try {
    await fn();
  } catch (e) {
    const el = $('formError');
    if (el) {
      el.hidden = false;
      el.textContent = e.message;
    } else fail(e);
  }
}
function subjectOptions() {
  return Object.entries(catalog.sections);
}
function tabs(items, current, setter) {
  return `<div class="tabs">${items.map(([v, n]) => button(n, () => setter(v), current === v)).join('')}</div>`;
}
function badge(v) {
  return `<span class="pill ${v === 'correct' || v === 'confirmed' || v === 'in_zone' ? 'correct' : v === 'incorrect' || v === 'outside' || v === 'rejected' ? 'incorrect' : 'unanswered'}">${esc(v || 'not_checked').replaceAll('_', ' ')}</span>`;
}
function table(headers, rows) {
  return `<div class="tablewrap"><table class="table"><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}" class="empty">No records yet.</td></tr>`}</tbody></table></div>`;
}
function tr(cells) {
  return `<tr>${cells.map((x) => `<td>${x}</td>`).join('')}</tr>`;
}
function metric(label, value, sub = '', action) {
  return `<div class="card ${action ? 'clickable' : ''}">${action ? button(label, action) : `<small>${esc(label)}</small>`}<div class="stat">${esc(value)}</div><small>${esc(sub)}</small></div>`;
}
function nav() {
  const items = [
    ['home', 'Overview'],
    ['library', 'Question library'],
    ['sessions', 'My sessions'],
    ['analytics', 'Analytics'],
    ['keys', 'API keys'],
    ['requests', 'Feedback & requests'],
  ];
  if (room) items.splice(2, 0, ['lobby', 'Current session']);
  if (me.role === 'admin') items.push(['admin', 'Administration']);
  return `<aside class="rail"><div class="brand">Algo<em>Climb</em></div>${items.map(([p, t]) => button(t, () => navigate(p), p === page)).join('')}<div class="profile">${esc(me.name)}<br>${esc(me.subject)}<br>${esc(me.role)} · ${Object.keys(catalog.sections).join(', ')}<br>${button(
    'Sign out',
    async () => {
      await api('/logout', {});
      if (socket) socket.close();
      location.reload();
    }
  )}</div></aside>`;
}
function pruneActions() {
  const live = new Set(
    [...document.querySelectorAll('[data-action]')].map((el) => Number(el.dataset.action))
  );
  for (const id of events.keys()) if (!live.has(id)) events.delete(id);
}
function render() {
  if (!me) return;
  $('app').innerHTML =
    `<div class="shell">${nav()}<main class="main">${({ home: homeView, library: libraryView, sessions: sessionsView, lobby: lobbyView, analytics: analyticsView, keys: keysView, requests: requestsView, admin: adminView }[page] || homeView)()}</main></div>`;
  pruneActions();
}
async function navigate(p) {
  const id = ++operation;
  if (p === 'sessions' || p === 'home' || p === 'analytics') {
    [history, rooms] = await Promise.all([api('/sessions'), api('/rooms')]);
  }
  if (p === 'keys') keys = await api('/keys');
  if (p === 'requests') requests = await api('/requests');
  if (p === 'admin') {
    [adminData, requests] = await Promise.all([api('/admin'), api('/requests')]);
  }
  if (id !== operation) return;
  page = p;
  render();
  window.scrollTo(0, 0);
}
async function refreshCatalog() {
  catalog = await api('/catalog');
}
function homeView() {
  return (
    heading(
      'Welcome, ' + me.name,
      'Prepare a class, teach and review results.',
      button('Create session', configure, true)
    ) +
    `<div class="two"><section><h2>Available subjects</h2><div class="grid">${Object.entries(
      catalog.sections
    )
      .map(
        ([id, name]) =>
          `<div class="card"><span class="tag">${catalog.tasks.filter((t) => t.section === id).length} questions</span><div class="space"></div><h2>${esc(name)}</h2><p>Shared sets and your teaching materials.</p>${button(
            'Browse sets',
            () => {
              section = id;
              setFilter = '';
              navigate('library');
            }
          )}</div>`
      )
      .join(
        ''
      )}</div><div class="space"></div><h2>Recent sessions</h2>${historyTable(history.slice(0, 5))}</section><aside class="stack"><div class="card"><h2>Your materials</h2><p>Use a JSON bank once, or save a personal set for future classes.</p>${button('Upload JSON', upload)}</div><div class="card"><h2>Prepared & live rooms</h2>${
      rooms
        .filter((r) => r.status !== 'finished')
        .map(
          (r) =>
            `<p>${esc(r.title)} · ${esc(r.status)}<br>${button('Open room', () => openRoom(r.id))}</p>`
        )
        .join('') || '<p>No open rooms.</p>'
    }</div><div class="card"><h3>Need another subject?</h3>${button('Request access', newRequest)}</div></aside></div>`
  );
}
function historyTable(rows) {
  return table(
    ['Session / set', 'Date', 'Status', 'Winner', ''],
    rows.map((s) =>
      tr([
        `<b>${esc(s.title || 'Legacy session #' + s.id)}</b><br><small>${esc((s.sets || []).map((x) => x.name).join(', '))}</small>`,
        esc(s.date),
        badge(s.status),
        esc(s.winner?.nick || '—'),
        button('Report', () => openReport(s.id)) + button('Repeat', () => repeatSession(s.id)),
      ])
    )
  );
}
function sessionsView() {
  return (
    heading(
      'My sessions',
      'Your prepared rooms and saved results.',
      button('Create session', configure, true)
    ) +
    `<div class="card"><h2>Open rooms</h2>${
      rooms
        .map(
          (r) =>
            `<p>${esc(r.title)} · ${esc(r.status)} · ${r.participants} participants ${
              button('Open', () => openRoom(r.id)) +
              (r.status !== 'running'
                ? button('Close room', () =>
                    confirmAction('Close this room? Saved results remain available.', async () => {
                      await api('/rooms/' + r.id + '/close', {});
                      if (room === r.id) {
                        room = null;
                        state = null;
                        if (socket) {
                          socket.onclose = null;
                          socket.close();
                        }
                      }
                      await navigate('sessions');
                    })
                  )
                : '')
            }</p>`
        )
        .join('') || '<p>No prepared sessions.</p>'
    }</div><div class="space"></div><div class="card">${historyTable(history)}</div>`
  );
}
function libraryView() {
  const items = catalog.tasks.filter(
    (t) =>
      (!section || t.section === section) &&
      (!questionFilter ||
        (t.title + ' ' + t.prompt).toLowerCase().includes(questionFilter.toLowerCase()))
  );
  const sets = [...new Map(items.map((t) => [t.set, t])).values()];
  return (
    heading(
      'Question library',
      'Subject → question set → questions. Topics removed.',
      button('Upload JSON', upload)
    ) +
    `<div class="toolbar">${button(
      'All subjects',
      () => {
        section = '';
        setFilter = '';
        render();
      },
      !section
    )}${Object.entries(catalog.sections)
      .map(([id, name]) =>
        button(
          name,
          () => {
            section = id;
            setFilter = '';
            render();
          },
          section === id
        )
      )
      .join(
        ''
      )}</div><div class="toolbar"><input id="questionSearch" aria-label="Search question titles" placeholder="Search question titles" value="${esc(questionFilter)}"><span>${button(
      'Search',
      () => {
        questionFilter = $('questionSearch').value;
        render();
      }
    )}</span>${button('Clear search', () => {
      questionFilter = '';
      render();
    })}</div><div class="card"><h2>Question sets</h2>${table(
      ['Set', 'Subject', 'Questions', ''],
      sets.map((t) =>
        tr([
          `<b>${esc(t.setName)}</b><br><small>${esc(t.set)}</small>`,
          esc(catalog.sections[t.section]),
          items.filter((x) => x.set === t.set).length,
          button('Preview questions', () => {
            setFilter = t.set;
            render();
          }) +
            button(
              'Select set',
              () => {
                items.filter((x) => x.set === t.set).forEach((x) => picked.add(x.id));
                setFilter = t.set;
                render();
              },
              true
            ),
        ])
      )
    )}</div><div class="space"></div><div class="card"><div class="heading"><h2>Questions · ${picked.size} selected</h2><div class="row">${button(
      'Clear selection',
      () => {
        picked.clear();
        render();
      }
    )}${button('Configure session', configure, true)}</div></div>${table(
      ['Select', 'Question', 'Type', 'Level', ''],
      items
        .filter((t) => !setFilter || t.set === setFilter)
        .map((t) =>
          tr([
            `<input type="checkbox" aria-label="Select ${esc(t.title)}" data-pick="${esc(t.id)}" ${picked.has(t.id) ? 'checked' : ''}>`,
            esc(t.title),
            esc(t.type),
            t.level,
            button('Preview', () => questionPreview(t)),
          ])
        )
    )}</div>`
  );
}
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-pick]')) {
    const id = e.target.dataset.pick;
    e.target.checked ? picked.add(id) : picked.delete(id);
  }
});
async function questionPreview(t) {
  modal(
    t.title,
    `<p>${esc(t.prompt)}</p><p>${esc(t.type)} · Level ${t.level}</p>${button(
      'Add to selection',
      () => {
        picked.add(t.id);
        closeModal();
        render();
      }
    )}`
  );
}
async function createRoom() {
  const r = await api('/rooms', {});
  return r.id;
}
async function configure() {
  modal(
    'Prepare session',
    `${input('sessionTitle', 'Session title', 'Class · ' + new Date().toLocaleDateString())}${input('classGroup', 'Group / cohort number', '1', 'number')}${field(
      'revealMode',
      'Show answer correctness',
      [
        ['after', 'After session ends'],
        ['immediate', 'After each answer'],
        ['teacher', 'Teacher only'],
      ],
      'after'
    )}<p>${pendingImport ? 'One-session bank selected.' : picked.size + ' questions selected. With no selection, available questions are used.'}</p><label class="checkrow"><input type="checkbox" id="geoEnabled"> Check attendance by location (optional)</label>${input('geoRadius', 'Attendance radius (meters)', '200', 'number')}<p class="muted">Location is requested only when you enable this option. Uncertain results can be reviewed manually.</p>${formError()}${button(
      'Open lobby',
      () =>
        formTask(async () => {
          if ($('geoEnabled').checked) {
            if (!isSecureContext || !navigator.geolocation)
              throw new Error('Location requires HTTPS and browser permission.');
            const p = await new Promise((ok, no) =>
              navigator.geolocation.getCurrentPosition(ok, no, {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 0,
              })
            );
            geo = {
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: p.coords.accuracy,
              radius: Number($('geoRadius').value),
            };
          } else geo = null;
          const title = $('sessionTitle').value;
          const group = Number($('classGroup').value);
          const reveal = $('revealMode').value;
          if (!room || state?.session.status !== 'lobby') room = await createRoom();
          await api('/rooms/' + room + '/settings', {
            title,
            reveal,
            geo,
            taskIds: [...picked],
            importId: pendingImport,
            stream: group,
          });
          const prep = { title, taskIds: [...picked], stream: group, importId: pendingImport };
          localStorage.setItem('ac.prep.' + room, JSON.stringify(prep));
          closeModal();
          await openRoom(room);
        }),
      true
    )}`
  );
}
async function upload() {
  modal(
    'Import questions',
    `${input('bankTitle', 'Set / session title')}${field('bankSubject', 'Subject', subjectOptions(), section || subjectOptions()[0]?.[0])}${field(
      'bankMode',
      'Keep this bank',
      [
        ['once', 'One session only'],
        ['permanent', 'Save to my personal library'],
      ],
      'once'
    )}<label for="bankFile">JSON file · maximum 2 MiB</label><input id="bankFile" type="file" accept=".json">${formError()}<p>Questions are validated before import. Permanent sets are personal; sharing requires administrator approval.</p>${button(
      'Validate & import',
      () =>
        formTask(async () => {
          const f = $('bankFile').files[0];
          if (!f || f.size > 2 * 1024 * 1024)
            throw new Error('Choose a JSON file no larger than 2 MiB.');
          const raw = JSON.parse(await f.text());
          const mode = $('bankMode').value;
          const r = await api('/import', {
            title: $('bankTitle').value,
            section: $('bankSubject').value,
            mode,
            tasks: Array.isArray(raw) ? raw : raw.tasks,
          });
          closeModal();
          if (mode === 'once') {
            room = r.room;
            pendingImport = r.import_id;
            await configure();
          } else {
            await refreshCatalog();
            await navigate('library');
            toast(r.count + ' questions saved.');
          }
        }),
      true
    )}`
  );
}
async function openRoom(id) {
  room = id;
  state = null;
  pendingImport = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  connectRoom();
  page = 'lobby';
  render();
}
function connectRoom() {
  clearTimeout(reconnectTimer);
  const currentRoom = room;
  socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/teacher?room=${encodeURIComponent(room)}`
  );
  const ws = socket;
  ws.onopen = () => {
    retry = 0;
    $('connection').textContent = 'Connected · changes are saved on the server';
  };
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    const m = JSON.parse(e.data);
    if (m.type === 'state') {
      state = { ...state, ...m };
      if (page === 'lobby') render();
    }
    if (m.type === 'startRejected') toast(m.error);
  };
  ws.onclose = (e) => {
    if (socket !== ws || room !== currentRoom) return;
    if (e.code === 1008) {
      $('connection').textContent = 'Access revoked or session expired. Sign in again.';
      return;
    }
    $('connection').textContent = 'Reconnecting… Your class continues on the server.';
    reconnectTimer = setTimeout(connectRoom, Math.min(10000, 500 * 2 ** Math.min(retry++, 5)));
  };
}
function send(command) {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    throw new Error('Reconnecting. Wait for the connection to restore.');
  socket.send(JSON.stringify(command));
}
function lobbyView() {
  if (!state) return heading('Opening session…', 'Connecting to your classroom.');
  const running = state.session.status === 'running',
    finished = state.session.status === 'finished';
  const checks = new Map((state.attendance || []).map((c) => [c.nick, c]));
  const prep =
    state.session.preparation || JSON.parse(localStorage.getItem('ac.prep.' + room) || '{}');
  return (
    heading(
      state.session.metadata?.title || prep.title || 'Classroom lobby',
      `${state.session.status} · Group ${state.session.stream} · ${state.roster.length} participants`,
      button('Project join screen', projectJoin)
    ) +
    (running || finished
      ? `<div class="row">${
          running
            ? button(state.paused ? 'Resume' : 'Pause', () =>
                send({ type: state.paused ? 'resume' : 'pause' })
              ) +
              button('+15 seconds', () => send({ type: 'addTime', ms: 15000 })) +
              button('Skip question', () =>
                confirmAction('Skip current question?', () => send({ type: 'skip' }))
              ) +
              button('Finish session', () =>
                confirmAction('Finish this session and save results?', () =>
                  send({ type: 'finish' })
                )
              )
            : button('Open saved report', async () => {
                await navigate('sessions');
              })
        }<b>Question ${state.round + 1} / ${state.roundTotal} · ${state.answeredCount} answered</b></div><div class="space"></div><div class="card"><h2>Competition map</h2><div class="mountain-live">${state.leaderboard.map((s) => `<div class="lane"><span class="climber" style="left:${Math.min(67, (s.correct / Math.max(1, state.roundTotal)) * 67)}%" title="${esc(s.nick)}">${s.rank}. ${esc(s.nick)} · ${s.correct}/${state.roundTotal} · ${s.score} pts</span></div>`).join('')}</div></div><div class="space"></div>`
      : '') +
    `<div class="two"><div class="card"><h2>Participants · ${state.roster.length}</h2><p>${state.roster.filter((x) => x.connected).length} connected · ${state.roster.filter((x) => !x.connected).length} offline. Rejoining preserves answers.</p><div class="roster">${state.roster.map((s) => `<div class="roster-item"><b>${esc(s.nick)}</b><br>${badge(s.connected ? 'connected' : 'offline')}<br>${badge(checks.get(s.nick)?.status)}<div class="space"></div>${button('Confirm presence', () => markAttendance(s.nick, 'confirmed'))}${button('Not present', () => markAttendance(s.nick, 'rejected'))}</div>`).join('')}</div></div><aside class="stack"><div class="card empty"><h2>Student access</h2><div class="qr">${state.qrSvg || ''}</div><p><a href="${esc(state.joinUrl)}" target="_blank" rel="noopener">${esc(state.joinUrl)}</a></p>${button(
      'Copy join link',
      async () => {
        await navigator.clipboard.writeText(state.joinUrl);
        toast('Join link copied.');
      }
    )}</div><div class="card"><h3>Session settings</h3><p>${esc(prep.title || 'Session')}<br>${prep.taskIds?.length || state.roundTotal || 'Available'} questions</p>${
      !running && !finished
        ? button(
            'Start session',
            () => {
              send({ type: 'setStream', stream: prep.stream || 1 });
              send({
                type: 'start',
                taskIds: prep.taskIds,
                importId: prep.importId,
                title: prep.title,
              });
            },
            true
          )
        : ''
    }</div></aside></div>`
  );
}
async function markAttendance(nick, status) {
  await api('/rooms/' + room + '/attendance', { nick, status });
  toast('Attendance updated.');
}
function projectJoin() {
  if (!state) return;
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to open the presenter screen.');
  w.document.write(
    `<!doctype html><html lang="en"><title>Join AlgoClimb</title><body style="font-family:Arial;text-align:center;padding:30px;background:#eff3fa;color:#13243b"><h1>Join the session</h1><div style="width:360px;margin:30px auto">${state.qrSvg || ''}</div><h2>${esc(state.joinUrl)}</h2><p>${state.roster.length} participants joined when this screen opened</p></body></html>`
  );
  w.document.close();
}
function confirmAction(title, fn) {
  modal(
    title,
    '<p>This affects the selected classroom.</p>' +
      button(
        'Confirm',
        async () => {
          await fn();
          closeModal();
        },
        true
      )
  );
}
async function repeatSession(id) {
  const r = await api('/sessions/' + id);
  picked = new Set(
    r.questions.map((q) => q.id).filter((id) => catalog.tasks.some((t) => t.id === id))
  );
  if (!picked.size)
    throw new Error(
      'These questions are no longer available in your library. Import a bank or choose another set.'
    );
  room = null;
  await configure();
}
async function openReport(id) {
  report = await api('/sessions/' + id);
  reportTab = 'overview';
  answerFilter = 'all';
  page = 'analytics';
  render();
  window.scrollTo(0, 0);
}
function reportStudents() {
  return [
    ...new Set([
      ...report.participants.map((x) => x.nick),
      ...report.results.map((x) => x.nick),
      ...report.answers.map((x) => x.nick),
    ]),
  ];
}
function studentAnswers(nick) {
  return report.answers.filter((a) => a.nick === nick);
}
function studentStats(nick) {
  const a = studentAnswers(nick);
  const result = report.results.find((r) => r.nick === nick);
  return {
    submitted: a.length,
    correct: a.filter((x) => x.correct).length,
    score: result?.total ?? a.reduce((n, x) => n + (x.points || 0), 0),
    rank: result?.place ?? '—',
  };
}
function setReportTab(t) {
  reportTab = t;
  answerFilter = 'all';
  render();
  window.scrollTo(0, 0);
}
function openStudent(n) {
  selectedStudent = n;
  setReportTab('student');
}
function openQuestion(id) {
  selectedQuestion = id;
  setReportTab('question');
}
function accuracy(correct, count) {
  return count ? Math.round((correct / count) * 100) + '%' : '—';
}
function analyticsView() {
  if (!report)
    return (
      heading('Analytics', 'Choose a session to inspect its results.') +
      `<div class="card">${historyTable(history)}</div>`
    );
  return (
    heading(
      report.session.title || 'Session #' + report.session.id,
      `${report.session.date} · ${report.questions.length || report.session.question_count || 0} questions · ${reportStudents().length} participants`,
      button('Export CSV', exportReport)
    ) +
    tabs(
      [
        ['overview', 'Overview'],
        ['leaderboard', 'Leaderboard'],
        ['students', 'Students'],
        ['questions', 'Questions'],
        ['connections', 'Connections'],
      ],
      reportTab === 'student' ? 'students' : reportTab === 'question' ? 'questions' : reportTab,
      setReportTab
    ) +
    (
      {
        overview: reportOverview,
        leaderboard: reportLeaderboard,
        students: reportStudentTable,
        student: reportStudent,
        questions: reportQuestionTable,
        question: reportQuestion,
        connections: reportConnections,
      }[reportTab] || reportOverview
    )()
  );
}
function reportOverview() {
  const correct = report.answers.filter((x) => x.correct).length;
  return `<div class="grid">${metric('Participants', reportStudents().length, 'Open student answer matrix', () => setReportTab('students'))}${metric('Accuracy', accuracy(correct, report.answers.length), 'Correct / submitted answers', () => setReportTab('questions'))}${metric('Reconnections', report.events.filter((x) => x.kind === 'reconnected').length, 'Open connection events', () => setReportTab('connections'))}</div><div class="space"></div><div class="two"><div class="card"><h2>Accuracy by question</h2><div class="metric">${report.questions
    .map((q, i) => {
      const a = report.answers.filter((x) => x.task_id === q.id);
      return `<button data-action="${registerAction(() => openQuestion(q.id))}" title="${esc(q.title)}" style="height:${a.length ? Math.max(3, (a.filter((x) => x.correct).length / a.length) * 100) : 3}%"><small>${i + 1}</small></button>`;
    })
    .join(
      ''
    )}</div><div class="space"></div>${!report.questions.length ? '<p>Legacy session: question snapshots were not recorded.</p>' : button('Inspect questions', () => setReportTab('questions'))}</div><div class="card"><h2>Leaderboard</h2>${report.results
    .slice(0, 3)
    .map(
      (r) => `<p>${r.place}. ${button(r.nick, () => openStudent(r.nick))}<br>${r.total} points</p>`
    )
    .join('')}${button('Full leaderboard', () => setReportTab('leaderboard'))}</div></div>`;
}
function registerAction(fn) {
  const id = ++eventId;
  events.set(id, fn);
  return id;
}
function reportLeaderboard() {
  const checks = new Map(report.checks.map((x) => [x.nick, x.status]));
  return `<div class="card"><h2>Leaderboard</h2><p>Quiz results are preserved separately from attendance. Review the top 10 before awarding grades.</p>${table(
    ['Rank', 'Student', 'Score', 'Correct', 'Attendance', ''],
    report.results.map((r) =>
      tr([
        r.place,
        esc(r.nick),
        r.total,
        studentStats(r.nick).correct,
        badge(checks.get(r.nick)),
        button('View all answers', () => openStudent(r.nick)),
      ])
    )
  )}</div>`;
}
function answerStatus(a) {
  return !a ? 'unanswered' : a.correct ? 'correct' : 'incorrect';
}
function reportStudentTable() {
  const names = reportStudents().filter((n) =>
    n.toLowerCase().includes(studentFilter.toLowerCase())
  );
  return `<div class="toolbar"><input id="studentSearch" placeholder="Search student name" value="${esc(studentFilter)}">${button(
    'Search',
    () => {
      studentFilter = $('studentSearch').value;
      render();
    }
  )}</div><div class="card"><h2>Student × question results</h2><p>Click a name for the full answer report. Scroll horizontally for all questions.</p>${table(
    ['Student', 'Score', 'Submitted', 'Correct', ...report.questions.map((q, i) => 'Q' + (i + 1))],
    names.map((n) => {
      const s = studentStats(n);
      return tr([
        button(n, () => openStudent(n)),
        s.score,
        s.submitted,
        s.correct,
        ...report.questions.map((q) => {
          const a = report.answers.find((x) => x.nick === n && x.task_id === q.id);
          return button(a ? (a.correct ? '✓' : '✕') : '—', () => {
            selectedStudent = n;
            selectedQuestion = q.id;
            setReportTab('student');
            document.getElementById('answer-' + q.id)?.scrollIntoView({ block: 'center' });
          });
        }),
      ]);
    })
  )}</div>`;
}
function answerFilters() {
  return `<div class="toolbar">${[
    ['all', 'All answers'],
    ['incorrect', 'Incorrect'],
    ['unanswered', 'No answer'],
    ['correct', 'Correct'],
  ]
    .map(([v, n]) =>
      button(
        n,
        () => {
          answerFilter = v;
          render();
        },
        answerFilter === v
      )
    )
    .join('')}</div>`;
}
function reportStudent() {
  const s = studentStats(selectedStudent);
  return `<p>${button('← All students', () => setReportTab('students'))}</p>${heading(selectedStudent, 'Full answers for this session')}<div class="grid">${metric('Score', s.score, 'Rank ' + s.rank)}${metric('Correct', s.correct, accuracy(s.correct, s.submitted))}${metric('Submitted', s.submitted, 'of ' + report.questions.length)}</div><div class="space"></div>${answerFilters()}<div class="stack">${
    report.questions
      .filter(
        (q) =>
          answerFilter === 'all' ||
          answerStatus(
            report.answers.find((a) => a.nick === selectedStudent && a.task_id === q.id)
          ) === answerFilter
      )
      .map((q, i) => {
        const a = report.answers.find((x) => x.nick === selectedStudent && x.task_id === q.id);
        return `<article class="card" id="answer-${esc(q.id)}"><div class="heading"><h2>Q${report.questions.indexOf(q) + 1} · ${esc(q.title)}</h2>${badge(answerStatus(a))}</div><p>${esc(q.prompt)}</p><div class="answers"><div class="answerbox ${answerStatus(a)}"><small>STUDENT ANSWER</small><p>${esc(a ? (a.answer_text ?? 'Detailed answer not recorded in this legacy session.') : 'No answer submitted')}</p></div><div class="answerbox correct"><small>CORRECT ANSWER</small><p>${esc(q.correctAnswer)}</p></div></div><p>${a ? (a.duration_ms / 1000).toFixed(1) + ' seconds · ' + (a.points ?? '—') + ' points' : 'No submission'}</p>${button('Question statistics', () => openQuestion(q.id))}</article>`;
      })
      .join('') ||
    '<div class="card">No matching answer details. Legacy sessions may not have question snapshots.</div>'
  }</div>`;
}
function reportQuestionTable() {
  return `<div class="card"><h2>Question performance</h2>${table(
    ['Question', 'Type', 'Submitted', 'Correct', 'Accuracy', ''],
    report.questions.map((q, i) => {
      const a = report.answers.filter((x) => x.task_id === q.id),
        c = a.filter((x) => x.correct).length;
      return tr([
        `Q${i + 1} · ${esc(q.title)}`,
        esc(q.type),
        a.length,
        c,
        accuracy(c, a.length),
        button('Inspect answers', () => openQuestion(q.id)),
      ]);
    })
  )}${!report.questions.length ? '<p>Detailed snapshots are unavailable for legacy sessions. Existing results remain preserved.</p>' : ''}</div>`;
}
function reportQuestion() {
  const q = report.questions.find((x) => x.id === selectedQuestion);
  if (!q) return reportQuestionTable();
  const names = reportStudents().filter(
    (n) =>
      answerFilter === 'all' ||
      answerStatus(report.answers.find((a) => a.nick === n && a.task_id === q.id)) === answerFilter
  );
  const a = report.answers.filter((x) => x.task_id === q.id);
  return `<p>${button('← All questions', () => setReportTab('questions'))}</p>${heading(q.title, q.type)}<div class="two"><div class="card"><p>${esc(q.prompt)}</p><div class="answerbox correct"><small>CORRECT ANSWER</small><p>${esc(q.correctAnswer)}</p></div></div><div class="card"><h2>Response distribution</h2><p>${a.filter((x) => x.correct).length} correct</p><p>${a.filter((x) => !x.correct).length} incorrect</p><p>${reportStudents().length - a.length} unanswered</p><b>${accuracy(a.filter((x) => x.correct).length, a.length)} accuracy</b></div></div><div class="space"></div><div class="card"><h2>Every participant's answer</h2>${answerFilters()}${table(
    ['Student', 'Student answer', 'Correct answer', 'Result', ''],
    names.map((n) => {
      const answer = report.answers.find((x) => x.nick === n && x.task_id === q.id);
      return tr([
        esc(n),
        esc(answer ? (answer.answer_text ?? 'Not recorded') : 'No answer'),
        esc(q.correctAnswer),
        badge(answerStatus(answer)),
        button('Student report', () => openStudent(n)),
      ]);
    })
  )}</div>`;
}
function reportConnections() {
  return `<div class="card"><h2>Connection & classroom events</h2><p>A disconnect event records an observation; it does not establish the cause. Older sessions may not contain connection events.</p>${table(
    ['Time', 'Student', 'Event', ''],
    report.events.map((e) =>
      tr([
        esc(e.at),
        esc(e.nick),
        badge(e.kind),
        button('Student report', () => openStudent(e.nick)),
      ])
    )
  )}</div>`;
}
function exportReport() {
  const checks = new Map(report.checks.map((x) => [x.nick, x.status]));
  modal(
    'Export results',
    `<p>Keep quiz results separate from attendance. Spreadsheet cells are escaped to prevent formula execution.</p>${button('All participants · CSV', () => downloadCsv(false))}${button('Confirmed / in-zone only · CSV', () => downloadCsv(true))}`
  );
  function downloadCsv(onlyConfirmed) {
    const csv = [
      ['Rank', 'Student', 'Score', 'Attendance'],
      ...report.results
        .filter((r) => !onlyConfirmed || ['confirmed', 'in_zone'].includes(checks.get(r.nick)))
        .map((r) => [r.place, r.nick, r.total, checks.get(r.nick) || 'not_checked']),
    ]
      .map((row) =>
        row
          .map(
            (v) =>
              '"' + String(/^[=+\-@\t\r]/.test(String(v)) ? "'" + v : v).replaceAll('"', '""') + '"'
          )
          .join(',')
      )
      .join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'algoclimb-session-' + report.session.id + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}
function keysView() {
  return (
    heading(
      'API keys',
      'Read only your sessions and results · expires after 24 hours',
      button(
        'Create API key',
        () => {
          modal(
            'Create API key',
            `${input('keyName', 'Key name', 'Research export')}${formError()}${button(
              'Generate',
              () =>
                formTask(async () => {
                  const r = await api('/keys', { name: $('keyName').value });
                  modal(
                    'Copy your key — shown once',
                    `<pre>${esc(r.token)}</pre><p>Expires ${new Date(r.expires_at * 1000).toLocaleString()}</p><code>Authorization: Bearer &lt;key&gt;</code>`
                  );
                  keys = await api('/keys');
                  render();
                }),
              true
            )}`
          );
        },
        true
      )
    ) +
    `<div class="card">${table(
      ['Name', 'Expires', 'Status', ''],
      keys.map((k) =>
        tr([
          esc(k.name),
          new Date(k.expires_at * 1000).toLocaleString(),
          k.revoked ? 'Revoked' : k.expires_at * 1000 < Date.now() ? 'Expired' : 'Active',
          button('Revoke', async () => {
            await api('/keys/' + k.id + '/revoke', {});
            await navigate('keys');
          }),
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Read-only endpoints</h2><pre>GET /api/v1/sessions\nGET /api/v1/sessions/{id}\nGET /api/v1/sessions/{id}/results\nGET /api/v1/sessions/{id}/answers\nGET /api/v1/sessions/{id}/events</pre><p>Ownership and current subject permissions apply on every request.</p></div>`
  );
}
function requestsView() {
  return (
    heading(
      'Feedback & requests',
      'Access to subjects, new subject proposals, shared publication and feedback.',
      button('New request', newRequest, true)
    ) + `<div class="card">${requestTable()}</div>`
  );
}
function requestTable() {
  return table(
    ['Type', 'Title', 'Message', 'Status', 'Reply', ''],
    requests.map((r) =>
      tr([
        esc(r.kind),
        esc(r.title),
        esc(r.message),
        badge(r.status),
        esc(r.reply),
        me.role === 'admin' ? button('Review', () => resolveRequest(r)) : '',
      ])
    )
  );
}
function newRequest() {
  modal(
    'Send a request',
    `${field(
      'requestKind',
      'Request type',
      [
        ['feedback', 'Feedback / report a problem'],
        ['subject_access', 'Access to existing subject'],
        ['new_subject', 'Propose new subject'],
        ['publish', 'Publish my set for everyone'],
      ],
      'feedback'
    )}${input('requestTitle', 'Title / subject ID / personal set ID')}<p class="muted">Subject IDs: algorithms, oop, graphs, db, nn. For publication use your set ID shown in Administration or the library.</p><label for="requestMessage">Message</label><textarea id="requestMessage" class="full" rows="4"></textarea>${formError()}${button(
      'Send',
      () =>
        formTask(async () => {
          await api('/requests', {
            kind: $('requestKind').value,
            title: $('requestTitle').value,
            message: $('requestMessage').value,
          });
          closeModal();
          await navigate('requests');
        }),
      true
    )}`
  );
}
function adminView() {
  if (!adminData) return '';
  return (
    heading(
      'Administration',
      'Owner controls · Invitations are delivered manually, without SMTP.',
      button('Invite teacher', invite, true)
    ) +
    `<div class="card"><h2>Teachers</h2>${table(
      ['Name', 'Email login', 'Subjects', 'Access', ''],
      adminData.users.map((u) =>
        tr([
          esc(u.name),
          esc(u.email),
          esc(u.sections.join(', ')),
          u.active ? (u.suspend_after ? 'Until current class ends' : 'Active') : 'Suspended',
          u.role !== 'admin' ? button('Manage', () => manage(u)) : 'Owner',
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Invitations & recovery links</h2>${table(
      ['Email', 'Kind', 'Expires', 'Status', ''],
      adminData.invitations.map((i) =>
        tr([
          esc(i.email),
          esc(i.kind),
          new Date(i.expires * 1000).toLocaleString(),
          i.used ? 'Used / cancelled' : i.expires * 1000 < Date.now() ? 'Expired' : 'Available',
          button('Cancel', async () => {
            await api('/admin/invitations/' + i.id + '/cancel', {});
            await navigate('admin');
          }),
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Requests</h2>${requestTable()}</div><div class="space"></div><div class="card"><h2>Saved personal / shared sets</h2>${table(
      ['Set', 'ID', 'Subject', 'Visibility'],
      adminData.sets.map((s) => tr([esc(s.title), esc(s.id), esc(s.section), badge(s.visibility)]))
    )}</div><div class="space"></div><div class="card"><h2>API keys</h2>${table(
      ['Name', 'Owner', 'Status', ''],
      adminData.keys.map((k) =>
        tr([
          esc(k.name),
          esc(k.owner_id || 'Legacy'),
          k.revoked ? 'Revoked' : new Date(k.expires_at * 1000).toLocaleString(),
          button('Revoke', async () => {
            await api('/keys/' + k.id + '/revoke', {});
            await navigate('admin');
          }),
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Audit log</h2>${table(
      ['When', 'Action', 'Target'],
      adminData.audit.map((a) =>
        tr([new Date(a.at * 1000).toLocaleString(), esc(a.action), esc(a.target)])
      )
    )}</div>`
  );
}
function sectionChecks(selected = []) {
  return Object.entries(catalog.sections)
    .map(
      ([id, n]) =>
        `<label class="checkrow"><input type="checkbox" data-section="${esc(id)}" ${selected.includes(id) ? 'checked' : ''}>${esc(n)}</label>`
    )
    .join('');
}
function readSections() {
  return [...document.querySelectorAll('[data-section]:checked')].map((x) => x.dataset.section);
}
function invite() {
  modal(
    'Invite a teacher',
    `${input('inviteEmail', 'Email login')}<label>Allowed subjects</label>${sectionChecks()}<p>Single-use link · 48 hours. Send it privately. Email is a login, not verified by a mail service.</p>${formError()}${button(
      'Create invitation',
      () =>
        formTask(async () => {
          const r = await api('/admin/invite', {
            email: $('inviteEmail').value,
            sections: readSections(),
          });
          showInvitation(r);
        }),
      true
    )}`
  );
}
function showInvitation(r) {
  const link = location.origin + '/workspace#' + r.kind + '=' + r.token;
  modal(
    r.kind === 'recover' ? 'Password recovery link' : 'Invitation ready',
    `<p>Send this link privately to the intended teacher. It can be used once.</p><textarea readonly class="full" rows="4">${esc(link)}</textarea><p>Expires in ${Math.round(r.expires_in / 3600)} hours. No email is sent automatically.</p>`
  );
}
function manage(u) {
  modal(
    'Manage ' + u.name,
    `<label>Allowed subjects</label>${sectionChecks(u.sections)}${formError()}${button(
      'Save permissions',
      () =>
        formTask(async () => {
          await api('/admin/users/' + u.id, { sections: readSections() });
          closeModal();
          await navigate('admin');
        }),
      true
    )}<div class="space"></div>${button('Issue password recovery link', async () => showInvitation(await api('/admin/invite', { kind: 'recover', user_id: u.id })))}${button(
      'Revoke logins & API keys',
      () =>
        confirmAction('Revoke all access credentials?', async () => {
          await api('/admin/users/' + u.id, { action: 'revoke' });
          await navigate('admin');
        })
    )}<div class="space"></div>${button('Suspend after current class', () =>
      confirmAction('Suspend when the current class finishes?', async () => {
        await api('/admin/users/' + u.id, { action: 'suspend', after_session: true });
        await navigate('admin');
      })
    )}${button(u.active ? 'Suspend & stop now' : 'Restore access', () =>
      confirmAction('Change teacher access?', async () => {
        await api('/admin/users/' + u.id, { action: u.active ? 'suspend' : 'activate' });
        await navigate('admin');
      })
    )}<div class="space"></div>${button('Remove account & transfer sets to owner', () =>
      confirmAction(
        'Remove access, stop live classes and transfer personal sets? Historical attribution is preserved.',
        async () => {
          await api('/admin/users/' + u.id, { action: 'delete' });
          await navigate('admin');
        }
      )
    )}`
  );
}
function resolveRequest(r) {
  modal(
    'Review request',
    `<p>${esc(r.kind)} · ${esc(r.title)}</p><p>${esc(r.message)}</p>${field(
      'requestStatus',
      'Decision',
      [
        ['approved', 'Approve'],
        ['declined', 'Decline'],
        ['needs_information', 'Ask for information'],
        ['resolved', 'Resolved'],
      ],
      'approved'
    )}${input('requestReply', 'Reply', '')}${formError()}${button(
      'Save decision',
      () =>
        formTask(async () => {
          await api('/admin/requests/' + r.id, {
            status: $('requestStatus').value,
            reply: $('requestReply').value,
          });
          closeModal();
          await navigate('admin');
        }),
      true
    )}`
  );
}
async function authView() {
  const status = await api('/status');
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('invite') || fragment.get('recover');
  const recovering = fragment.has('recover');
  if (token) window.history.replaceState(null, '', location.pathname);
  const setup = !status.initialized;
  $('app').innerHTML =
    `<div class="auth card"><div class="brand">Algo<em>Climb</em></div><h1>${token ? (recovering ? 'Reset password' : 'Accept invitation') : setup ? 'Create owner account' : 'Teacher sign in'}</h1><p>${token ? 'This link works once. No email delivery is required.' : setup ? 'Use the existing teacher key once to create the owner account.' : 'Use your personal account. Request an invitation or recovery link from the administrator.'}</p><form id="authForm">${setup && !token ? input('bootstrapKey', 'Existing teacher key', '', 'password') : ''}${!token || setup ? input('authEmail', 'Email login', '', 'email') : ''}${setup || (token && !recovering) ? input('authName', 'Full name') + input('authSubject', 'Teaching subject / institution') : ''}${input('authPassword', 'Password · 10–256 characters', '', 'password')}${formError()}<button class="primary full" type="submit">${token ? 'Activate / reset account' : setup ? 'Create owner account' : 'Sign in'}</button></form><p class="footnote">No SMTP is configured. An email address identifies your login; invitations and recovery links are issued by the administrator.</p></div>`;
  $('authForm').onsubmit = (e) => {
    e.preventDefault();
    formTask(async () => {
      const body = { password: $('authPassword').value };
      if ($('authEmail')) body.email = $('authEmail').value;
      if ($('authName')) {
        body.name = $('authName').value;
        body.subject = $('authSubject').value;
      }
      if (token) body.token = token;
      if ($('bootstrapKey')) body.key = $('bootstrapKey').value;
      me = await api(token ? '/activate' : setup ? '/setup' : '/login', body);
      await refreshCatalog();
      await navigate('home');
    });
  };
}
(async () => {
  if (location.hash.startsWith('#invite=') || location.hash.startsWith('#recover=')) {
    await authView();
    return;
  }
  try {
    me = await api('/me');
    await refreshCatalog();
    await navigate('home');
  } catch {
    await authView();
  }
})().catch(fail);
