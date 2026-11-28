'use strict';
const tx = window.ACI18n?.t || ((v) => v);
const uh = window.ACI18n?.staticHTML || ((v) => v);
const ui =
  window.ACI18n?.html ||
  ((parts, ...values) => parts.reduce((out, p, i) => out + p + (values[i] ?? ''), ''));
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
let libraryType = '',
  libraryLevel = '',
  librarySource = '',
  advancedOpen = false,
  randomSampleSize = 10;
const navigationTrail = [];
function rememberPage() {
  const last = navigationTrail.at(-1);
  if (!last || last.page !== page || last.room !== room) navigationTrail.push({ page, room });
  if (navigationTrail.length > 40) navigationTrail.shift();
}
async function goBack() {
  if ($('overlay').children.length) return closeModal();
  if (page === 'analytics' && report) {
    if (reportTab === 'student') return setReportTab('students');
    if (reportTab === 'question') return setReportTab('questions');
    if (reportTab !== 'overview') return setReportTab('overview');
    report = null;
    return navigate('analytics', false);
  }
  const target = navigationTrail.pop();
  if (target?.page === 'lobby' && target.room) {
    if (target.room === room || rooms.some((r) => r.id === target.room))
      return openRoom(target.room, false);
    return navigate('sessions', false);
  }
  return navigate(target?.page || 'home', false);
}
const events = new Map();
let eventId = 0;
function button(label, callback, primary = false) {
  const id = ++eventId;
  events.set(id, callback);
  return ui`<button data-action="${id}" class="${primary ? 'primary' : ''}">${esc(label)}</button>`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-home]')) {
    e.preventDefault();
    closeModal();
    navigate('home').catch(fail);
    return;
  }
  const b = e.target.closest('[data-action]');
  if (b)
    Promise.resolve()
      .then(async () => {
        if (b.dataset.busy) return;
        b.dataset.busy = 'true';
        b.setAttribute('aria-busy', 'true');
        try {
          await events.get(Number(b.dataset.action))?.();
        } finally {
          delete b.dataset.busy;
          b.removeAttribute('aria-busy');
        }
      })
      .catch(fail);
});
function fail(e) {
  toast(tx(e.message || String(e)));
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
    throw new Error(tx('Server unavailable. Retry in a moment.'));
  }
  if (!r.ok)
    throw new Error(
      typeof data.detail === 'string' ? data.detail : tx('Please check the form fields.')
    );
  return data;
}
function heading(title, sub = '', actions = '') {
  return ui`<div class="heading"><div><h1>${esc(title)}</h1><span class="muted">${esc(sub)}</span></div><div class="row">${actions}</div></div>`;
}
let dialogTrigger;
function modal(title, html, className = '') {
  dialogTrigger = document.activeElement;
  $('app').inert = true;
  $('overlay').innerHTML =
    ui`<div class="modalback"><section role="dialog" aria-modal="true" aria-label="${esc(title)}" class="modal ${className}">${button(tx('← Back / Close'), closeModal)}<div class="space"></div><h2>${esc(title)}</h2>${html}</section></div>`;
  $('overlay').querySelector('button')?.focus({ preventScroll: true });
}
function closeModal() {
  $('overlay').innerHTML = '';
  $('app').inert = false;
  if (dialogTrigger?.isConnected) dialogTrigger.focus({ preventScroll: true });
  pruneActions();
}
function input(id, label, value = '', type = 'text') {
  return ui`<label for="${id}">${esc(label)}</label><input id="${id}" class="full" type="${type}" value="${esc(value)}" required>`;
}
function field(id, label, options, value) {
  return ui`<label for="${id}">${esc(label)}</label><select id="${id}" class="full">${options.map(([v, n]) => ui`<option value="${esc(v)}" ${value === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
}
function formError() {
  return uh('<p id="formError" class="error" hidden></p>');
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
  return ui`<div class="tabs">${items.map(([v, n]) => button(n, () => setter(v), current === v)).join('')}</div>`;
}
function badge(v) {
  return ui`<span class="pill ${v === 'correct' || v === 'confirmed' || v === 'in_zone' ? 'correct' : v === 'incorrect' || v === 'outside' || v === 'rejected' ? 'incorrect' : 'unanswered'}">${esc(tx((v || 'not_checked').replaceAll('_', ' ')))}</span>`;
}
function table(headers, rows) {
  return ui`<div class="tablewrap"><table class="table"><thead><tr>${headers.map((x) => ui`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || ui`<tr><td colspan="${headers.length}" class="empty">No records yet.</td></tr>`}</tbody></table></div>`;
}
function tr(cells) {
  return ui`<tr>${cells.map((x) => ui`<td>${x}</td>`).join('')}</tr>`;
}
function metric(label, value, sub = '', action) {
  return ui`<div class="card ${action ? 'clickable' : ''}">${action ? button(label, action) : ui`<small>${esc(label)}</small>`}<div class="stat">${esc(value)}</div><small>${esc(sub)}</small></div>`;
}
async function toggleLanguage() {
  const fields = [...document.querySelectorAll('input[id],select[id],textarea[id]')].map((el) => ({
    id: el.id,
    value: el.value,
    checked: el.checked,
  }));
  window.ACI18n.setLanguage(window.ACI18n.language === 'ru' ? 'en' : 'ru');
  if (me) render();
  else await authView();
  for (const saved of fields) {
    const el = $(saved.id);
    if (el) {
      el.value = saved.value;
      if (el.type === 'checkbox') el.checked = saved.checked;
    }
  }
  $('connection').textContent = tx('AlgoClimb · Teacher workspace');
  $('languageToggle')?.focus({ preventScroll: true });
}
function languageButton() {
  return button(window.ACI18n?.language === 'ru' ? 'English' : 'Русский', toggleLanguage).replace(
    '<button ',
    '<button id="languageToggle" '
  );
}
function nav() {
  const items = [
    ['home', tx('Overview')],
    ['library', tx('Question library')],
    ['sessions', tx('My sessions')],
    ['analytics', tx('Analytics')],
    ['keys', tx('API keys')],
    ['requests', tx('Feedback & requests')],
  ];
  if (room) items.splice(2, 0, ['lobby', tx('Current session')]);
  if (me.role === 'admin') items.push(['admin', tx('Administration')]);
  return ui`<aside class="rail"><a class="brand" href="/workspace" data-home aria-label="AlgoClimb · Overview">Algo<em>Climb</em></a>${languageButton()}${items.map(([p, t]) => button(t, () => navigate(p), p === page)).join('')}<div class="profile">${esc(me.name)}<br>${esc(me.subject)}<br>${esc(me.role)} · ${Object.keys(catalog.sections).join(', ')}<br>${button(tx('Account & password'), editAccount)}${button(
    tx('Sign out'),
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
function editAccount() {
  modal(
    tx('Account & password'),
    ui`${input('profileName', tx('Full name'), me.name)}${input('profileSubject', tx('Teaching subject / institution'), me.subject)}${input('oldPassword', tx('Current password'), '', 'password')}${input('newPassword', tx('New password · 10–256 characters'), '', 'password')}<p>Saving signs out other browsers and revokes your existing API keys.</p>${formError()}${button(
      tx('Save & update password'),
      () =>
        formTask(async () => {
          await api('/account', {
            name: $('profileName').value,
            subject: $('profileSubject').value,
            current_password: $('oldPassword').value,
            password: $('newPassword').value,
          });
          location.reload();
        }),
      true
    )}`
  );
}
function render() {
  if (!me) return;
  const scrolls = new Map(
    [...document.querySelectorAll('[data-preserve-scroll]')].map((el) => [
      el.dataset.preserveScroll,
      { top: el.scrollTop, left: el.scrollLeft },
    ])
  );
  const searchFocused = document.activeElement?.id === 'boardSearch';
  const searchPosition = searchFocused ? document.activeElement.selectionStart : null;
  document.body.classList.toggle('competition-expanded', boardExpanded && page === 'lobby');
  $('app').innerHTML =
    ui`<div class="shell">${nav()}<main class="main">${page !== 'home' ? uh('<div class="page-back">') + button(tx('← Back'), goBack) + uh('</div>') : ''}${({ home: homeView, library: libraryView, sessions: sessionsView, lobby: lobbyView, analytics: analyticsView, keys: keysView, requests: requestsView, admin: adminView }[page] || homeView)()}</main></div>`;
  for (const el of document.querySelectorAll('[data-preserve-scroll]')) {
    const saved = scrolls.get(el.dataset.preserveScroll);
    if (saved) {
      el.scrollTop = saved.top;
      el.scrollLeft = saved.left;
    }
  }
  if (searchFocused && $('boardSearch')) {
    const input = $('boardSearch');
    input.focus({ preventScroll: true });
    if (searchPosition !== null) input.setSelectionRange(searchPosition, searchPosition);
  }
  pruneActions();
}
async function navigate(p, remember = true) {
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
  if (remember && page !== p) rememberPage();
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
      tx('Welcome, ') + me.name,
      tx('Prepare a class, teach and review results.'),
      button(tx('Create session'), configure, true)
    ) +
    ui`<div class="two"><section><h2>Available subjects</h2><div class="grid">${Object.entries(
      catalog.sections
    )
      .map(
        ([id, name]) =>
          ui`<div class="card"><span class="tag">${catalog.tasks.filter((t) => t.section === id).length} questions</span><div class="space"></div><h2>${esc(tx(name))}</h2><p>Shared sets and your teaching materials.</p>${button(
            tx('Browse sets'),
            () => {
              section = id;
              setFilter = '';
              navigate('library');
            }
          )}</div>`
      )
      .join(
        ''
      )}</div><div class="space"></div><h2>Recent sessions</h2>${historyTable(history.slice(0, 5))}</section><aside class="stack"><div class="card"><h2>Your materials</h2><p>Use a JSON bank once, or save a personal set for future classes.</p>${button(tx('Upload JSON'), upload)}</div><div class="card"><h2>Prepared & live rooms</h2>${
      rooms
        .filter((r) => r.status !== 'finished')
        .map(
          (r) =>
            ui`<p>${esc(r.title)} · ${esc(r.status)}<br>${button(tx('Open room'), () => openRoom(r.id))}</p>`
        )
        .join('') || uh('<p>No open rooms.</p>')
    }</div><div class="card"><h3>Need another subject?</h3>${button(tx('Request access'), newRequest)}</div></aside></div>`
  );
}
function historyTable(rows) {
  return table(
    [tx('Session / set'), tx('Date'), tx('Status'), tx('Winner'), ''],
    rows.map((s) =>
      tr([
        ui`<b>${esc(s.title || tx('Legacy session #') + s.id)}</b><br><small>${esc((s.sets || []).map((x) => x.name).join(', '))}</small>`,
        esc(s.date),
        badge(s.status),
        esc(s.winner?.nick || '—'),
        button(tx('Report'), () => openReport(s.id)) +
          button(tx('Repeat'), () => repeatSession(s.id)),
      ])
    )
  );
}
function sessionsView() {
  return (
    heading(
      tx('My sessions'),
      tx('Your prepared rooms and saved results.'),
      button(tx('Create session'), configure, true)
    ) +
    ui`<div class="card"><h2>Open rooms</h2>${
      rooms
        .map(
          (r) =>
            ui`<p>${esc(r.title)} · ${esc(r.status)} · ${r.participants} participants ${
              button(tx('Open'), () => openRoom(r.id)) +
              (r.status !== 'running'
                ? button(tx('Close room'), () =>
                    confirmAction(
                      tx('Close this room? Saved results remain available.'),
                      async () => {
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
                      }
                    )
                  )
                : '')
            }</p>`
        )
        .join('') || uh('<p>No prepared sessions.</p>')
    }</div><div class="space"></div><div class="card">${historyTable(history)}</div>`
  );
}
function libraryItems() {
  return catalog.tasks.filter(
    (t) =>
      (!section || t.section === section) &&
      (!libraryType || t.type === libraryType) &&
      (!libraryLevel || String(t.level) === libraryLevel) &&
      (!librarySource || (t.set.startsWith('personal-') ? 'saved' : 'builtin') === librarySource) &&
      (!questionFilter ||
        (t.title + ' ' + t.prompt).toLowerCase().includes(questionFilter.toLowerCase()))
  );
}
function libraryView() {
  const items = libraryItems();
  const visible = items.filter((t) => !setFilter || t.set === setFilter);
  const sets = [...new Map(items.map((t) => [t.set, t])).values()];
  return (
    heading(
      tx('Question library'),
      tx('Subject → question set → questions. Topics removed.'),
      button(tx('Upload JSON'), upload)
    ) +
    ui`<div class="toolbar">${button(
      tx('All subjects'),
      () => {
        section = '';
        setFilter = '';
        render();
      },
      !section
    )}${Object.entries(catalog.sections)
      .map(([id, name]) =>
        button(
          tx(name),
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
      tx('Search'),
      () => {
        questionFilter = $('questionSearch').value;
        render();
      }
    )}</span>${button(tx('Clear search'), () => {
      questionFilter = '';
      render();
    })}</div><details class="setup-section" id="libraryAdvanced" ${advancedOpen ? 'open' : ''}><summary>Advanced filters</summary><div class="setup-grid"><div>${field(
      'libraryType',
      tx('Question type'),
      [
        ['', tx('All types')],
        ['choice', tx('Multiple choice')],
        ['graph', tx('Build graph')],
        ['order', tx('Traversal / ordering')],
        ['sort', tx('Sorting')],
        ['blank', tx('Fill blanks')],
      ],
      libraryType
    )}</div><div>${field(
      'libraryLevel',
      tx('Difficulty'),
      [
        ['', tx('All levels')],
        ['1', tx('Level 1')],
        ['2', tx('Level 2')],
        ['3', tx('Level 3')],
      ],
      libraryLevel
    )}</div><div>${field(
      'librarySource',
      tx('Source'),
      [
        ['', tx('All sources')],
        ['builtin', tx('Built-in bank')],
        ['saved', tx('Saved JSON sets')],
      ],
      librarySource
    )}</div></div>${button(tx('Apply filters'), () => {
      libraryType = $('libraryType').value;
      libraryLevel = $('libraryLevel').value;
      librarySource = $('librarySource').value;
      advancedOpen = true;
      render();
    })}${button(tx('Reset filters'), () => {
      libraryType = libraryLevel = librarySource = '';
      render();
    })}</details><div class="card"><h2>Question sets</h2>${table(
      [tx('Set'), tx('Subject'), tx('Questions'), ''],
      sets.map((t) =>
        tr([
          ui`<b>${esc(t.setName)}</b><br><small>${esc(t.set)}</small>`,
          esc(catalog.sections[t.section]),
          items.filter((x) => x.set === t.set).length,
          button(tx('Preview questions'), () => {
            setFilter = t.set;
            render();
          }) +
            button(
              tx('Select set'),
              () => {
                items.filter((x) => x.set === t.set).forEach((x) => picked.add(x.id));
                setFilter = t.set;
                render();
              },
              true
            ),
        ])
      )
    )}</div><div class="space"></div><div class="card"><div class="heading"><h2 id="selectionCount" aria-live="polite">Questions · ${picked.size} selected</h2><div class="row">${button(
      tx('Clear selection'),
      () => {
        picked.clear();
        render();
      }
    )}${button(tx('Configure session'), configure, true)}</div></div><div class="toolbar"><span>${visible.length} matching questions</span><label for="randomCount">Random sample size</label><input id="randomCount" type="number" min="1" max="500" step="1" value="${randomSampleSize}">${button(tx('Preview random sample'), previewRandomSample)}</div>${table(
      [tx('Select'), tx('Question'), tx('Type'), tx('Level'), ''],
      visible.map((t) =>
        tr([
          ui`<input type="checkbox" aria-label="Select ${esc(t.title)}" data-pick="${esc(t.id)}" ${picked.has(t.id) ? 'checked' : ''}>`,
          esc(t.title),
          esc(t.type),
          t.level,
          button(tx('Preview'), () => questionPreview(t)),
        ])
      )
    )}</div>`
  );
}
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-pick]')) {
    const id = e.target.dataset.pick;
    e.target.checked ? picked.add(id) : picked.delete(id);
    if ($('selectionCount'))
      $('selectionCount').textContent = tx('Questions · ') + picked.size + tx(' selected');
  }
});
function previewRandomSample() {
  const count = Number($('randomCount').value);
  const candidates = libraryItems().filter((t) => !setFilter || t.set === setFilter);
  if (!Number.isInteger(count) || count < 1 || count > 500)
    throw new Error(tx('Enter a whole sample size from 1 to 500.'));
  if (count > candidates.length)
    throw new Error(
      tx(
        'The sample is larger than the filtered question pool. Reduce the sample size or change filters.'
      )
    );
  randomSampleSize = count;
  const sample = [...candidates];
  for (let i = sample.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sample[i], sample[j]] = [sample[j], sample[i]];
  }
  sample.length = count;
  const apply = (replace) => {
    const allowed = new Set(catalog.tasks.map((t) => t.id));
    if (sample.some((task) => !allowed.has(task.id)))
      throw new Error(
        tx('Some sampled questions are no longer available. Refresh the library and try again.')
      );
    const next = new Set(replace ? [] : picked);
    for (const task of sample) next.add(task.id);
    if (next.size > 500)
      throw new Error(tx('A session can contain at most 500 selected questions.'));
    picked = next;
    closeModal();
    render();
  };
  modal(
    tx('Random sample preview'),
    ui`<p>${count} questions from ${candidates.length} matching questions. Review before changing your selection.</p><ol>${sample.map((t) => ui`<li>${esc(t.title)}</li>`).join('')}</ol>${button(tx('Add to selection'), () => apply(false))}${button(tx('Replace selection'), () => apply(true), true)}`
  );
}
async function questionPreview(t) {
  modal(
    t.title,
    ui`<p>${esc(t.prompt)}</p><p>${esc(tx(t.type))} · Level ${t.level}</p>${button(
      tx('Add to selection'),
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
  const timeTypes = [
    ['choice', tx('Multiple choice')],
    ['graph', tx('Build graph')],
    ['order', tx('Traversal / ordering')],
    ['sort', tx('Sorting')],
    ['blank', tx('Fill blanks')],
  ];
  const prep = state?.session?.status === 'lobby' ? state.session.preparation || {} : {};
  const savedLimits = prep.timeLimits || {};
  const taskIds = picked.size ? [...picked] : prep.taskIds || [];
  const importId = pendingImport || prep.importId || null;
  const configuredGeo =
    state?.session?.status === 'lobby' && state.session.attendanceSettings?.enabled
      ? state.session.attendanceSettings
      : null;
  modal(
    tx('Prepare session'),
    ui`<p class="muted">Prepare your classroom, then invite students. The quiz starts only when you press Start in the lobby.</p><div class="session-summary"><strong>${importId ? tx('One-session JSON bank') : taskIds.length ? taskIds.length + ' selected questions' : tx('Available question bank')}</strong><span>${importId ? tx('Separate bank · used for this session only') : tx('Your library stays unchanged')}</span></div><section class="setup-section"><h3>1 · Class details</h3><div class="setup-grid"><div>${input('sessionTitle', tx('Session title'), prep.title || tx('Class · ') + new Date().toLocaleDateString())}</div><div>${input('classGroup', tx('Group / cohort number'), prep.stream || '1', 'number')}</div></div>${field(
      'revealMode',
      tx('Show answer correctness'),
      [
        ['after', tx('After session ends')],
        ['immediate', tx('After each answer')],
        ['teacher', tx('Teacher only')],
      ],
      state?.session?.status === 'lobby' ? state.session.reveal || 'after' : 'after'
    )}</section><details class="setup-section"><summary>2 · Time per question type (optional)</summary><p class="muted">Seconds per question, from 5 to 3600. Leave blank to keep the question’s own time limit or the platform default. A value here overrides it for this session only.</p><div class="setup-grid">${timeTypes.map(([type, label]) => uh('<div>') + input('time-' + type, label + tx(' · seconds'), savedLimits[type] ?? '', 'number').replace(' required>', ' min="5" max="3600" step="1" placeholder="Default">') + uh('</div>')).join('')}</div></details><section class="setup-section"><h3>3 · Attendance (optional)</h3><label class="checkrow"><input type="checkbox" id="geoEnabled"> Check attendance by location</label><div id="geoOptions" hidden>${input('geoRadius', tx('Attendance radius (meters)'), configuredGeo?.radius || '200', 'number')}<p class="muted">Requires location permission. Uncertain results can be reviewed manually; quiz scores are preserved separately.</p></div></section><div class="setup-actions">${formError()}<p class="muted">You can review these settings before starting.</p>${button(
      tx('Open lobby'),
      () =>
        formTask(async () => {
          const timeLimits = {};
          for (const [type, label] of timeTypes) {
            const raw = $('time-' + type).value.trim();
            if (!raw) continue;
            const seconds = Number(raw);
            if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)
              throw new Error(label + tx(': enter whole seconds from 5 to 3600 or leave blank.'));
            timeLimits[type] = seconds;
          }
          if ($('geoEnabled').checked) {
            if (!isSecureContext || !navigator.geolocation)
              throw new Error(tx('Location requires HTTPS and browser permission.'));
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
            taskIds,
            importId,
            stream: group,
            timeLimits,
          });
          const prep = {
            title,
            taskIds,
            stream: group,
            importId,
            timeLimits,
          };
          localStorage.setItem('ac.prep.' + room, JSON.stringify(prep));
          closeModal();
          await openRoom(room);
        }),
      true
    )}</div>`,
    'session-setup'
  );
  $('geoEnabled').checked = Boolean(configuredGeo);
  $('geoOptions').hidden = !configuredGeo;
  $('geoEnabled').addEventListener('change', () => {
    $('geoOptions').hidden = !$('geoEnabled').checked;
  });
}
async function upload() {
  modal(
    tx('Import questions'),
    ui`${input('bankTitle', tx('Set / session title'))}${field('bankSubject', tx('Subject'), subjectOptions(), section || subjectOptions()[0]?.[0])}${field(
      'bankMode',
      tx('Keep this bank'),
      [
        ['once', tx('One session only')],
        ['permanent', tx('Save to my personal library')],
      ],
      'once'
    )}<label for="bankFile">JSON file · maximum 2 MiB</label><input id="bankFile" type="file" accept=".json">${formError()}<p>Questions are validated before import. Permanent sets are personal; sharing requires administrator approval.</p>${button(
      tx('Validate & import'),
      () =>
        formTask(async () => {
          const f = $('bankFile').files[0];
          if (!f || f.size > 2 * 1024 * 1024)
            throw new Error(tx('Choose a JSON file no larger than 2 MiB.'));
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
async function openRoom(id, remember = true) {
  if (remember && (page !== 'lobby' || room !== id)) rememberPage();
  if (room !== id) {
    boardQuery = '';
    boardCheckpoint = null;
    boardTopOnly = false;
    boardFocus = null;
    boardExpanded = false;
  }
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
    ui`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/teacher?room=${encodeURIComponent(room)}`
  );
  const ws = socket;
  ws.onopen = () => {
    retry = 0;
    $('connection').textContent = tx('Connected · changes are saved on the server');
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
      $('connection').textContent = tx('Access revoked or session expired. Sign in again.');
      return;
    }
    $('connection').textContent = tx('Reconnecting… Your class continues on the server.');
    reconnectTimer = setTimeout(connectRoom, Math.min(10000, 500 * 2 ** Math.min(retry++, 5)));
  };
}
function send(command) {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    throw new Error(tx('Reconnecting. Wait for the connection to restore.'));
  socket.send(JSON.stringify(command));
}
let boardQuery = '',
  boardCheckpoint = null,
  boardTopOnly = false,
  boardExpanded = false,
  boardFocus = null,
  boardMode = 'mountain';
function boardAction(fn) {
  return registerAction(fn);
}
function boardProgress(s, total) {
  return Math.max(0, Math.min(total, Number(s.correct) || 0));
}
function boardPoint(progress) {
  return {
    x: 64 + progress * 860,
    y: 312 - progress * 248 + 18 * Math.sin(progress * Math.PI * 2),
  };
}
function competitionBoard() {
  const all = state.leaderboard || [],
    total = Math.max(1, Number(state.roundTotal) || Number(state.session.total) || 1);
  const bucketWidth = Math.max(1, Math.ceil(total / 30));
  const checkpointFor = (s) => Math.floor(boardProgress(s, total) / bucketWidth) * bucketWidth;
  const checkpointLabel = (step) =>
    bucketWidth === 1 ? String(step) : ui`${step}–${Math.min(total, step + bucketWidth - 1)}`;
  const filtered = all.filter(
    (s) =>
      (!boardTopOnly || s.rank <= 10) &&
      (boardCheckpoint === null || checkpointFor(s) === boardCheckpoint) &&
      String(s.nick).toLocaleLowerCase().includes(boardQuery.toLocaleLowerCase())
  );
  const focused = all.find((s) => s.nick === boardFocus) || all[0];
  const groups = new Map();
  for (const s of all) {
    const step = checkpointFor(s);
    if (!groups.has(step)) groups.set(step, []);
    groups.get(step).push(s);
  }
  const route = Array.from({ length: 101 }, (_, i) => {
    const p = boardPoint(i / 100);
    return ui`${p.x},${p.y}`;
  }).join(' ');
  const spacing = Math.max(1, Math.ceil(total / 10));
  const markers = [...groups]
    .map(([step, people]) => {
      const p = boardPoint((step + Math.min(total, step + bucketWidth - 1)) / 2 / total),
        selected = step === boardCheckpoint,
        active = focused && people.some((s) => s.nick === focused.nick);
      return ui`<g class="climb-marker ${selected ? 'selected' : ''} ${active ? 'focused' : ''}" role="button" tabindex="0" data-action="${boardAction(
        () => {
          boardCheckpoint = boardCheckpoint === step ? null : step;
          render();
        }
      )}" data-checkpoint="${step}" aria-label="${checkpointLabel(step)} correct answers: ${people.length} participants. Filter leaderboard"><title>${checkpointLabel(step)}/${total} correct · ${people.length} participants</title>${active ? ui`<circle cx="${p.x}" cy="${p.y}" r="23" class="climb-halo"/>` : ''}<circle cx="${p.x}" cy="${p.y}" r="16"/><text x="${p.x}" y="${p.y + 5}" text-anchor="middle">${people.length}</text></g>`;
    })
    .join('');
  const ticks = Array.from({ length: total + 1 }, (_, step) => {
    if (step % spacing !== 0 && step !== total) return '';
    const p = boardPoint(step / total);
    return ui`<circle cx="${p.x}" cy="${p.y}" r="4" fill="#849caf"/><text class="climb-tick" x="${p.x}" y="${p.y + 42}" text-anchor="middle">${step === total ? tx('Finish · ') + total : step === 0 ? tx('Start · 0') : step}</text>`;
  }).join('');
  return ui`<section class="card competition-board ${boardExpanded ? 'board-expanded' : ''}" aria-label="Class climb"><header class="board-heading"><div><span class="board-eyebrow">${state.session.status === 'finished' ? tx('FINAL RESULTS') : state.paused ? tx('PAUSED CLASSROOM') : tx('LIVE CLASSROOM')} · ${all.length} ${all.length === 1 ? tx('CLIMBER') : tx('CLIMBERS')}</span><h2>Class climb</h2><p>Correct answers move you toward the summit. ${all.length ? ui`${Math.max(...all.map((s) => boardProgress(s, total)))}/${total} is the furthest checkpoint.` : tx('Waiting for the first participant.')}</p></div><div class="row">${button(
    boardMode === 'mountain' ? tx('Leaderboard only') : tx('Show mountain'),
    () => {
      boardMode = boardMode === 'mountain' ? 'leaderboard' : 'mountain';
      render();
    }
  )}${button(
    boardExpanded ? tx('Exit large view') : tx('Large view'),
    () => {
      boardExpanded = !boardExpanded;
      render();
    },
    true
  )}</div></header>${focused ? ui`<div class="board-spotlight"><span class="board-rank">#${focused.rank}</span><div class="board-spotlight-name"><small>${boardFocus ? 'SELECTED CLIMBER' : tx('LEADING THE CLIMB')}</small><strong>${esc(focused.nick)}</strong></div><div class="board-spotlight-stat"><strong>${boardProgress(focused, total)}<span> / ${total}</span></strong><small>correct answers</small></div><div class="board-spotlight-stat"><strong>${Number(focused.score) || 0}</strong><small>points</small></div>${badge(focused.connected ? 'connected' : 'offline')}</div>` : ''}${boardMode === 'mountain' ? ui`<div class="climb-scene-scroll" data-preserve-scroll="climb-scene"><svg class="climb-scene" viewBox="0 0 1000 400" role="group" aria-label="Mountain from zero to ${total} correct answers. Numbered circles show participant counts at each checkpoint."><defs><linearGradient id="climb-sky" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#edf6fb"/><stop offset="1" stop-color="#f9fbfc"/></linearGradient><linearGradient id="climb-rock" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#bad1df"/><stop offset="1" stop-color="#e4eef2"/></linearGradient></defs><rect width="1000" height="400" rx="16" fill="url(#climb-sky)"/><circle cx="100" cy="64" r="27" fill="#ffe6a2"/><path d="M0 260 150 130 280 260 465 105 650 280 840 145 1000 280V400H0Z" fill="#e5eef3"/><path d="M0 370 240 265 420 290 620 150 744 191 919 52 1000 174V400H0Z" fill="url(#climb-rock)"/><path d="m859 100 60-48 49 74-39-16-20 9-17-24Z" fill="#fff"/><path d="M919 52V12m0 0 38 10-38 10" fill="#edbd27" stroke="#394e67" stroke-width="3" stroke-linejoin="round"/><polyline points="${route}" fill="none" stroke="#a6bac7" stroke-width="15" stroke-linecap="round" opacity=".35"/><polyline points="${route}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/><polyline points="${route}" fill="none" stroke="#d3a521" stroke-width="3" stroke-dasharray="5 7"/>${ticks}${markers}<text x="970" y="382" text-anchor="end" class="climb-tick">${total} questions · climb at your own pace</text></svg></div><div class="board-legend"><span><i></i> Circle number = students at this checkpoint</span><span>Click a circle to inspect that group</span></div>` : ''}<div class="board-toolbar"><input id="boardSearch" type="search" aria-label="Find a climber" placeholder="Find a student by full name…" value="${esc(boardQuery)}">${button(
    boardTopOnly ? tx('Show everyone') : tx('Top 10'),
    () => {
      boardTopOnly = !boardTopOnly;
      render();
    },
    boardTopOnly
  )}${
    boardCheckpoint !== null
      ? button(
          ui`${checkpointLabel(boardCheckpoint)}/${total} correct · clear filter`,
          () => {
            boardCheckpoint = null;
            render();
          },
          true
        )
      : ''
  }${
    boardQuery
      ? button(tx('Clear search'), () => {
          boardQuery = '';
          render();
        })
      : ''
  }<span class="muted">${filtered.length} of ${all.length}</span></div><div class="climb-leaderboard" data-preserve-scroll="climb-ranking"><div class="climb-table-head"><span>Rank</span><span>Student</span><span>Ascent · correct answers</span><span>Points</span></div>${
    filtered
      .map((s) => {
        const progress = boardProgress(s, total),
          chosen = focused?.nick === s.nick;
        return ui`<div class="climb-student-row ${chosen ? 'is-focused' : ''}" data-climber-name="${esc(s.nick)}"><span class="climb-rank ${s.rank <= 3 ? 'podium' : ''}">${s.rank}</span><button class="climb-student-name" data-action="${boardAction(
          () => {
            boardFocus = s.nick;
            render();
          }
        )}" title="Focus ${esc(s.nick)}"><strong>${esc(s.nick)}</strong><small>${s.connected ? tx('Connected') : tx('Offline · progress saved')}${s.answeredThisRound ? ' · Answer submitted' : ''}</small></button><div class="climb-progress"><div class="climb-track"><span style="width:${(progress / total) * 100}%"></span><i style="left:${(progress / total) * 100}%" aria-hidden="true"></i></div><span class="climb-progress-label"><b>${progress}</b> / ${total} <small>correct</small></span></div><strong class="climb-score">${Number(s.score) || 0}<small>points</small></strong></div>`;
      })
      .join('') || uh('<div class="empty">No climbers match these filters.</div>')
  }</div></section>`;
}
document.addEventListener('input', (event) => {
  if (event.target.id !== 'boardSearch') return;
  const at = event.target.selectionStart;
  boardQuery = event.target.value;
  render();
  const input = $('boardSearch');
  if (input) {
    input.focus({ preventScroll: true });
    if (at !== null) input.setSelectionRange(at, at);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && $('overlay').children.length) {
    const items = [
      ...$('overlay').querySelectorAll('button, input, select, textarea, summary, a[href]'),
    ].filter((el) => !el.disabled && el.getClientRects().length);
    const first = items[0],
      last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  if (event.key === 'Escape' && $('overlay').children.length) {
    closeModal();
    return;
  }
  if (event.key === 'Escape' && boardExpanded) {
    boardExpanded = false;
    render();
  }
  if (
    (event.key === 'Enter' || event.key === ' ') &&
    event.target.matches('g.climb-marker[data-action]')
  ) {
    event.preventDefault();
    Promise.resolve()
      .then(() => events.get(Number(event.target.dataset.action))?.())
      .catch(fail);
  }
});

function lobbyView() {
  if (!state) return heading(tx('Opening session…'), tx('Connecting to your classroom.'));
  const running = state.session.status === 'running',
    finished = state.session.status === 'finished';
  const checks = new Map((state.attendance || []).map((c) => [c.nick, c]));
  const prep =
    state.session.preparation || JSON.parse(localStorage.getItem('ac.prep.' + room) || '{}');
  return (
    heading(
      state.session.metadata?.title || prep.title || tx('Classroom lobby'),
      ui`${state.session.status} · Group ${state.session.stream} · ${state.roster.length} participants`,
      button(tx('Project join screen'), projectJoin)
    ) +
    (running || finished
      ? ui`<div class="row">${
          running
            ? button(state.paused ? tx('Resume') : tx('Pause'), () =>
                send({ type: state.paused ? 'resume' : 'pause' })
              ) +
              button('+15 seconds', () => send({ type: 'addTime', ms: 15000 })) +
              button(tx('Skip question'), () =>
                confirmAction(tx('Skip current question?'), () => send({ type: 'skip' }))
              ) +
              button(tx('Finish session'), () =>
                confirmAction(tx('Finish this session and save results?'), () =>
                  send({ type: 'finish' })
                )
              )
            : button(tx('Open saved report'), async () => {
                await navigate('sessions');
              })
        }<b>Question ${state.round + 1} / ${state.roundTotal} · ${state.answeredCount} answered</b><span class="tab-leaves">↗ ${(state.leaderboard || []).reduce((n, s) => n + (Number(s.tabLeaves) || 0), 0)} tab leaves</span></div><div class="space"></div>${competitionBoard()}<div class="space"></div>`
      : '') +
    ui`<div class="two"><div class="card"><h2>Participants · ${state.roster.length}</h2><p>${state.roster.filter((x) => x.connected).length} connected · ${state.roster.filter((x) => !x.connected).length} offline. Rejoining preserves answers.</p><div class="roster">${state.roster.map((s) => ui`<div class="roster-item"><b>${esc(s.nick)}</b><br>${badge(s.connected ? 'connected' : 'offline')}<br>${badge(checks.get(s.nick)?.status)}<br><span class="tab-leaves">↗ ${Number(state.leaderboard?.find((r) => r.nick === s.nick)?.tabLeaves) || 0} tab leaves</span><div class="space"></div>${button(tx('Confirm presence'), () => markAttendance(s.nick, 'confirmed'))}${button(tx('Not present'), () => markAttendance(s.nick, 'rejected'))}</div>`).join('')}</div></div><aside class="stack"><div class="card empty"><h2>Student access</h2><div class="qr">${state.qrSvg || ''}</div><p><a href="${esc(state.joinUrl)}" target="_blank" rel="noopener">${esc(state.joinUrl)}</a></p>${button(
      tx('Copy join link'),
      async () => {
        await navigator.clipboard.writeText(state.joinUrl);
        toast(tx('Join link copied.'));
      }
    )}</div><div class="card"><h3>Session settings</h3><p>${esc(prep.title || tx('Session'))}<br>${prep.taskIds?.length || state.roundTotal || tx('Available')} questions</p>${
      !running && !finished
        ? button(
            tx('Start session'),
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
  toast(tx('Attendance updated.'));
}
function projectJoin() {
  if (!state) return;
  const w = window.open('', '_blank');
  if (!w) throw new Error(tx('Allow pop-ups to open the presenter screen.'));
  w.document.write(
    ui`<!doctype html><html lang="en"><title>Join AlgoClimb</title><body style="font-family:Arial;text-align:center;padding:30px;background:#eff3fa;color:#13243b"><h1>Join the session</h1><div style="width:360px;margin:30px auto">${state.qrSvg || ''}</div><h2>${esc(state.joinUrl)}</h2><p>${state.roster.length} participants joined when this screen opened</p></body></html>`
  );
  w.document.close();
}
function confirmAction(title, fn) {
  modal(
    title,
    uh('<p>This affects the selected classroom.</p>') +
      button(
        tx('Confirm'),
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
      tx(
        'These questions are no longer available in your library. Import a bank or choose another set.'
      )
    );
  room = null;
  await configure();
}
async function openReport(id) {
  const nextReport = await api('/sessions/' + id);
  if (page !== 'analytics') rememberPage();
  report = nextReport;
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
function tabLeaveCount(nick) {
  return report.events.filter((e) => e.kind === 'tableave' && (!nick || e.nick === nick)).length;
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
      heading(tx('Analytics'), tx('Choose a session to inspect its results.')) +
      ui`<div class="card">${historyTable(history)}</div>`
    );
  return (
    heading(
      report.session.title || tx('Session #') + report.session.id,
      ui`${report.session.date} · ${report.questions.length || report.session.question_count || 0} questions · ${reportStudents().length} participants`,
      button(tx('Export CSV'), exportReport) +
        (me.role === 'admin' ? button(tx('Share report'), shareReport) : '')
    ) +
    tabs(
      [
        ['overview', tx('Overview')],
        ['leaderboard', tx('Leaderboard')],
        ['students', tx('Students')],
        ['questions', tx('Questions')],
        ['connections', tx('Connections')],
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
  return ui`<div class="grid">${metric(tx('Participants'), reportStudents().length, tx('Open student answer matrix'), () => setReportTab('students'))}${metric(tx('Accuracy'), accuracy(correct, report.answers.length), tx('Correct / submitted answers'), () => setReportTab('questions'))}${metric(tx('Reconnections'), report.events.filter((x) => x.kind === 'reconnected').length, tx('Open connection events'), () => setReportTab('connections'))}</div><div class="space"></div><div class="two"><div class="card"><h2>Accuracy by question</h2><p class="muted">Correct / submitted answers · select a bar to inspect the question</p><div class="accuracy-chart"><div class="metric accuracy-bars" style="min-width:${Math.max(240, report.questions.length * 48)}px">${report.questions
    .map((q, i) => {
      const a = report.answers.filter((x) => x.task_id === q.id);
      const correct = a.filter((x) => x.correct).length;
      const label = a.length ? accuracy(correct, a.length) : '—';
      const description = ui`Q${i + 1} · ${q.title} · ${a.length ? label + ' · ' + correct + '/' + a.length + ' correct' : tx('No submissions')}`;
      return ui`<button data-action="${registerAction(() => openQuestion(q.id))}" aria-label="${esc(description)}" title="${esc(description)}" style="height:${a.length ? Math.max(3, (correct / a.length) * 100) : 3}%"><span class="accuracy-value" aria-hidden="true">${label}</span><small>Q${i + 1}</small></button>`;
    })
    .join(
      ''
    )}</div></div><div class="space"></div>${!report.questions.length ? uh('<p>Legacy session: question snapshots were not recorded.</p>') : button(tx('Inspect questions'), () => setReportTab('questions'))}</div><div class="card"><h2>Leaderboard</h2>${report.results
    .slice(0, 3)
    .map(
      (r) =>
        ui`<p>${r.place}. ${button(r.nick, () => openStudent(r.nick))}<br>${r.total} points</p>`
    )
    .join('')}${button(tx('Full leaderboard'), () => setReportTab('leaderboard'))}</div></div>`;
}
function registerAction(fn) {
  const id = ++eventId;
  events.set(id, fn);
  return id;
}
function reportLeaderboard() {
  const checks = new Map(report.checks.map((x) => [x.nick, x.status]));
  return ui`<div class="card"><h2>Leaderboard</h2><p>Quiz results are preserved separately from attendance. Review the top 10 before awarding grades.</p>${table(
    [tx('Rank'), tx('Student'), tx('Score'), tx('Correct'), tx('Tab leaves'), tx('Attendance'), ''],
    report.results.map((r) =>
      tr([
        r.place,
        esc(r.nick),
        r.total,
        studentStats(r.nick).correct,
        tabLeaveCount(r.nick),
        badge(checks.get(r.nick)),
        button(tx('View all answers'), () => openStudent(r.nick)),
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
  return ui`<div class="toolbar"><input id="studentSearch" placeholder="Search student name" value="${esc(studentFilter)}">${button(
    tx('Search'),
    () => {
      studentFilter = $('studentSearch').value;
      render();
    }
  )}</div><div class="card"><h2>Student × question results</h2><p>Click a name for the full answer report. Scroll horizontally for all questions.</p>${table(
    [
      tx('Student'),
      tx('Score'),
      tx('Submitted'),
      tx('Correct'),
      tx('Tab leaves'),
      ...report.questions.map((q, i) => 'Q' + (i + 1)),
    ],
    names.map((n) => {
      const s = studentStats(n);
      return tr([
        button(n, () => openStudent(n)),
        s.score,
        s.submitted,
        s.correct,
        tabLeaveCount(n),
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
  return ui`<div class="toolbar">${[
    ['all', tx('All answers')],
    ['incorrect', tx('Incorrect')],
    ['unanswered', tx('No answer')],
    ['correct', tx('Correct')],
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
  return ui`<p>${button(tx('← All students'), () => setReportTab('students'))}</p>${heading(selectedStudent, tx('Full answers for this session'))}<div class="grid">${metric(tx('Score'), s.score, tx('Rank ') + s.rank)}${metric(tx('Correct'), s.correct, accuracy(s.correct, s.submitted))}${metric(tx('Submitted'), s.submitted, 'of ' + report.questions.length)}${metric(tx('Tab leaves'), tabLeaveCount(selectedStudent), tx('Recorded while a question was visible'))}</div><div class="space"></div>${answerFilters()}<div class="stack">${
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
        return ui`<article class="card" id="answer-${esc(q.id)}"><div class="heading"><h2>Q${report.questions.indexOf(q) + 1} · ${esc(q.title)}</h2>${badge(answerStatus(a))}</div><p>${esc(q.prompt)}</p><div class="answers"><div class="answerbox ${answerStatus(a)}"><small>STUDENT ANSWER</small><p>${esc(a ? (a.answer_text ?? tx('Detailed answer not recorded in this legacy session.')) : tx('No answer submitted'))}</p></div><div class="answerbox correct"><small>CORRECT ANSWER</small><p>${esc(q.correctAnswer)}</p></div></div><p>${a ? (a.duration_ms / 1000).toFixed(1) + ' seconds · ' + (a.points ?? '—') + ' points' : tx('No submission')}</p>${button(tx('Question statistics'), () => openQuestion(q.id))}</article>`;
      })
      .join('') ||
    uh(
      '<div class="card">No matching answer details. Legacy sessions may not have question snapshots.</div>'
    )
  }</div>`;
}
function reportQuestionTable() {
  return ui`<div class="card"><h2>Question performance</h2>${table(
    [tx('Question'), tx('Type'), tx('Submitted'), tx('Correct'), tx('Accuracy'), ''],
    report.questions.map((q, i) => {
      const a = report.answers.filter((x) => x.task_id === q.id),
        c = a.filter((x) => x.correct).length;
      return tr([
        ui`Q${i + 1} · ${esc(q.title)}`,
        esc(q.type),
        a.length,
        c,
        accuracy(c, a.length),
        button(tx('Inspect answers'), () => openQuestion(q.id)),
      ]);
    })
  )}${!report.questions.length ? uh('<p>Detailed snapshots are unavailable for legacy sessions. Existing results remain preserved.</p>') : ''}</div>`;
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
  return ui`<p>${button(tx('← All questions'), () => setReportTab('questions'))}</p>${heading(q.title, q.type)}<div class="two"><div class="card"><p>${esc(q.prompt)}</p><div class="answerbox correct"><small>CORRECT ANSWER</small><p>${esc(q.correctAnswer)}</p></div></div><div class="card"><h2>Response distribution</h2><p>${a.filter((x) => x.correct).length} correct</p><p>${a.filter((x) => !x.correct).length} incorrect</p><p>${reportStudents().length - a.length} unanswered</p><b>${accuracy(a.filter((x) => x.correct).length, a.length)} accuracy</b></div></div><div class="space"></div><div class="card"><h2>Every participant's answer</h2>${answerFilters()}${table(
    [tx('Student'), tx('Student answer'), tx('Correct answer'), tx('Result'), ''],
    names.map((n) => {
      const answer = report.answers.find((x) => x.nick === n && x.task_id === q.id);
      return tr([
        esc(n),
        esc(answer ? (answer.answer_text ?? tx('Not recorded')) : tx('No answer')),
        esc(q.correctAnswer),
        badge(answerStatus(answer)),
        button(tx('Student report'), () => openStudent(n)),
      ]);
    })
  )}</div>`;
}
function reportConnections() {
  return ui`<div class="card"><h2>Connection & classroom events</h2><p><strong>${tabLeaveCount()} tab leaves recorded</strong></p><p>Tab leaves are recorded when a student hides the page while a question is displayed and connected. They do not prove cheating. Offline exits, lobby and finished screens are not counted.</p><p>A disconnect event records an observation; it does not establish the cause. Older sessions may not contain connection events.</p>${table(
    [tx('Time'), tx('Student'), tx('Event'), ''],
    report.events.map((e) =>
      tr([
        esc(e.at),
        esc(e.nick),
        badge(e.kind === 'tableave' ? tx('Tab left') : e.kind),
        button(tx('Student report'), () => openStudent(e.nick)),
      ])
    )
  )}</div>`;
}
function shareReport() {
  modal(
    tx('Read-only report access'),
    ui`${input('shareEmail', tx('Teacher email'))}<label>Subject sections in this report</label>${sectionChecks(report.session.sections || [])}<p>For a legacy report, select the sections after checking its question sets. The teacher must already have subject access, or an unused invitation. Session ownership and room controls stay unchanged.</p>${formError()}${button(
      tx('Grant view access'),
      () =>
        formTask(async () => {
          await api('/admin/sessions/' + report.session.id + '/access', {
            email: $('shareEmail').value,
            sections: readSections(),
          });
          closeModal();
          toast(tx('Read-only report access granted.'));
        }),
      true
    )}${button(tx('Revoke view access'), () =>
      formTask(async () => {
        await api('/admin/sessions/' + report.session.id + '/access', {
          email: $('shareEmail').value,
          action: 'revoke',
        });
        closeModal();
        toast(tx('Report access revoked.'));
      })
    )}`
  );
}
function reportFilename(onlyConfirmed = false) {
  const clean = (value) =>
    String(value ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .slice(0, 100);
  const title = clean(report.session.title) || 'session';
  const group = clean(report.session.stream);
  return (
    [
      'algoclimb',
      title,
      group ? 'group-' + group : '',
      clean(report.session.date),
      clean(report.session.id),
      onlyConfirmed ? 'attendance' : 'all',
    ]
      .filter(Boolean)
      .join('_') + '.csv'
  );
}
function exportReport() {
  const checks = new Map(report.checks.map((x) => [x.nick, x.status]));
  modal(
    tx('Export results'),
    ui`<p>Keep quiz results separate from attendance. Spreadsheet cells are escaped to prevent formula execution.</p>${button(tx('All participants · CSV'), () => downloadCsv(false))}${button(tx('Confirmed / in-zone only · CSV'), () => downloadCsv(true))}`
  );
  function downloadCsv(onlyConfirmed) {
    const csv = [
      [tx('Rank'), tx('Student'), tx('Score'), tx('Attendance')],
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
    a.download = reportFilename(onlyConfirmed);
    a.click();
    URL.revokeObjectURL(url);
  }
}
function keysView() {
  return (
    heading(
      tx('API keys'),
      tx('Read only your sessions and results · expires after 24 hours'),
      button(
        tx('Create API key'),
        () => {
          modal(
            tx('Create API key'),
            ui`${input('keyName', tx('Key name'), tx('Research export'))}${formError()}${button(
              tx('Generate'),
              () =>
                formTask(async () => {
                  const r = await api('/keys', { name: $('keyName').value });
                  modal(
                    tx('Copy your key — shown once'),
                    ui`<pre>${esc(r.token)}</pre><p>Expires ${new Date(r.expires_at * 1000).toLocaleString()}</p><code>Authorization: Bearer &lt;key&gt;</code>`
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
    ui`<div class="card">${table(
      [tx('Name'), tx('Expires'), tx('Status'), ''],
      keys.map((k) =>
        tr([
          esc(k.name),
          new Date(k.expires_at * 1000).toLocaleString(),
          k.revoked
            ? tx('Revoked')
            : k.expires_at * 1000 < Date.now()
              ? tx('Expired')
              : tx('Active'),
          button(tx('Revoke'), async () => {
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
      tx('Feedback & requests'),
      tx('Access to subjects, new subject proposals, shared publication and feedback.'),
      button(tx('New request'), newRequest, true)
    ) + ui`<div class="card">${requestTable()}</div>`
  );
}
function requestTable() {
  return table(
    [tx('Type'), tx('Title'), tx('Message'), tx('Status'), tx('Reply'), ''],
    requests.map((r) =>
      tr([
        esc(r.kind),
        esc(r.title),
        esc(r.message),
        badge(r.status),
        esc(r.reply),
        me.role === 'admin' ? button(tx('Review'), () => resolveRequest(r)) : '',
      ])
    )
  );
}
function newRequest() {
  modal(
    tx('Send a request'),
    ui`${field(
      'requestKind',
      tx('Request type'),
      [
        ['feedback', tx('Feedback / report a problem')],
        ['subject_access', tx('Access to existing subject')],
        ['new_subject', tx('Propose new subject')],
        ['publish', tx('Publish my set for everyone')],
      ],
      'feedback'
    )}${input('requestTitle', tx('Title / subject ID / personal set ID'))}<p class="muted">Subject IDs: algorithms, oop, graphs, db, nn. For publication use your set ID shown in Administration or the library.</p><label for="requestMessage">Message</label><textarea id="requestMessage" class="full" rows="4"></textarea>${formError()}${button(
      tx('Send'),
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
      tx('Administration'),
      tx('Owner controls · Invitations are delivered manually, without SMTP.'),
      button(tx('Invite teacher'), invite, true)
    ) +
    ui`<div class="card"><h2>Teachers</h2>${table(
      [tx('Name'), tx('Email login'), tx('Subjects'), tx('Access'), ''],
      adminData.users.map((u) =>
        tr([
          esc(u.name),
          esc(u.email),
          esc(u.sections.join(', ')),
          u.active
            ? u.suspend_after
              ? tx('Until current class ends')
              : tx('Active')
            : tx('Suspended'),
          u.role !== 'admin' ? button(tx('Manage'), () => manage(u)) : tx('Owner'),
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Invitations & recovery links</h2>${table(
      [tx('Email'), tx('Kind'), tx('Expires'), tx('Status'), ''],
      adminData.invitations.map((i) =>
        tr([
          esc(i.email),
          esc(i.kind),
          new Date(i.expires * 1000).toLocaleString(),
          i.used
            ? tx('Used / cancelled')
            : i.expires * 1000 < Date.now()
              ? tx('Expired')
              : tx('Available'),
          button(tx('Cancel'), async () => {
            await api('/admin/invitations/' + i.id + '/cancel', {});
            await navigate('admin');
          }),
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Requests</h2>${requestTable()}</div><div class="space"></div><div class="card"><h2>Saved personal / shared sets</h2>${table(
      [tx('Set'), 'ID', tx('Subject'), tx('Visibility')],
      adminData.sets.map((s) => tr([esc(s.title), esc(s.id), esc(s.section), badge(s.visibility)]))
    )}</div><div class="space"></div><div class="card"><h2>API keys</h2>${table(
      [tx('Name'), tx('Owner'), tx('Status'), ''],
      adminData.keys.map((k) =>
        tr([
          esc(k.name),
          esc(k.owner_id || tx('Legacy')),
          k.revoked ? tx('Revoked') : new Date(k.expires_at * 1000).toLocaleString(),
          button(tx('Revoke'), async () => {
            await api('/keys/' + k.id + '/revoke', {});
            await navigate('admin');
          }),
        ])
      )
    )}</div><div class="space"></div><div class="card"><h2>Audit log</h2>${table(
      [tx('When'), tx('Action'), tx('Target')],
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
        ui`<label class="checkrow"><input type="checkbox" data-section="${esc(id)}" ${selected.includes(id) ? 'checked' : ''}>${esc(n)}</label>`
    )
    .join('');
}
function readSections() {
  return [...document.querySelectorAll('[data-section]:checked')].map((x) => x.dataset.section);
}
function invite() {
  modal(
    tx('Invite a teacher'),
    ui`${input('inviteEmail', tx('Email login'))}<label>Allowed subjects</label>${sectionChecks()}<p>Single-use link · 48 hours. Send it privately. Email is a login, not verified by a mail service.</p>${formError()}${button(
      tx('Create invitation'),
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
    r.kind === 'recover' ? tx('Password recovery link') : tx('Invitation ready'),
    ui`<p>Send this link privately to the intended teacher. It can be used once.</p><textarea readonly class="full" rows="4">${esc(link)}</textarea><p>Expires in ${Math.round(r.expires_in / 3600)} hours. No email is sent automatically.</p>`
  );
}
function manage(u) {
  modal(
    tx('Manage ') + u.name,
    ui`<label>Allowed subjects</label>${sectionChecks(u.sections)}${formError()}${button(
      tx('Save permissions'),
      () =>
        formTask(async () => {
          await api('/admin/users/' + u.id, { sections: readSections() });
          closeModal();
          await navigate('admin');
        }),
      true
    )}<div class="space"></div>${button(tx('Issue password recovery link'), async () => showInvitation(await api('/admin/invite', { kind: 'recover', user_id: u.id })))}${button(
      tx('Revoke logins & API keys'),
      () =>
        confirmAction(tx('Revoke all access credentials?'), async () => {
          await api('/admin/users/' + u.id, { action: 'revoke' });
          await navigate('admin');
        })
    )}<div class="space"></div>${button(tx('Suspend after current class'), () =>
      confirmAction(tx('Suspend when the current class finishes?'), async () => {
        await api('/admin/users/' + u.id, { action: 'suspend', after_session: true });
        await navigate('admin');
      })
    )}${button(u.active ? tx('Suspend & stop now') : tx('Restore access'), () =>
      confirmAction(tx('Change teacher access?'), async () => {
        await api('/admin/users/' + u.id, { action: u.active ? 'suspend' : 'activate' });
        await navigate('admin');
      })
    )}<div class="space"></div>${button(tx('Remove account & transfer sets to owner'), () =>
      confirmAction(
        tx(
          'Remove access, stop live classes and transfer personal sets? Historical attribution is preserved.'
        ),
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
    tx('Review request'),
    ui`<p>${esc(r.kind)} · ${esc(r.title)}</p><p>${esc(r.message)}</p>${field(
      'requestStatus',
      tx('Decision'),
      [
        ['approved', tx('Approve')],
        ['declined', tx('Decline')],
        ['needs_information', tx('Ask for information')],
        ['resolved', tx('Resolved')],
      ],
      'approved'
    )}${input('requestReply', tx('Reply'), '')}${formError()}${button(
      tx('Save decision'),
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
    ui`<div class="auth card"><div class="brand">Algo<em>Climb</em></div>${languageButton()}<h1>${token ? (recovering ? tx('Reset password') : tx('Accept invitation')) : setup ? tx('Create owner account') : tx('Teacher sign in')}</h1><p>${token ? tx('This link works once. No email delivery is required.') : setup ? tx('Use the existing teacher key once to create the owner account.') : tx('Use your personal account. Request an invitation or recovery link from the administrator.')}</p><form id="authForm">${setup && !token ? input('bootstrapKey', tx('Existing teacher key'), '', 'password') : ''}${!token || setup ? input('authEmail', setup ? tx('Email login') : tx('Username or email'), '', setup ? 'email' : 'text') : ''}${setup || (token && !recovering) ? input('authName', tx('Full name')) + input('authSubject', tx('Teaching subject / institution')) : ''}${input('authPassword', tx('Password · 10–256 characters'), '', 'password')}${formError()}<button class="primary full" type="submit">${token ? tx('Activate / reset account') : setup ? tx('Create owner account') : tx('Sign in')}</button></form><p class="footnote">Use your assigned username or email login. No SMTP is configured; invitations and recovery links are issued by the administrator.</p></div>`;
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
  await window.ACI18n?.ready;
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
