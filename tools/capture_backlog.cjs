// Deterministic UI fixture. No VPS, private bank, credentials or live class connections.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.SCREENSHOT_BROWSER || undefined,
  });
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://climb.test/**', async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.startsWith('/api/workspace')) {
        const data = pathname.endsWith('/me')
          ? {
              id: 'demo',
              role: 'admin',
              name: 'Demo Teacher',
              email: 'demo@example.org',
              sections: ['graphs'],
              subject: 'Graphs',
            }
          : pathname.endsWith('/catalog')
            ? { sections: { graphs: 'Graphs' }, tasks: [] }
            : [];
        return route.fulfill({ json: data });
      }
      const file = pathname === '/workspace' ? 'workspace.html' : pathname.slice(1);
      if (
        ![
          'workspace.html',
          'workspace.js',
          'workspace.css',
          'interactions.css',
          'site-footer.js',
        ].includes(file)
      )
        return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
        contentType: file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
        body: fs.readFileSync(path.join(root, 'frontend', file), 'utf8'),
      });
    });
    await p.goto('https://climb.test/workspace');
    await p.getByRole('heading', { name: 'Welcome, Demo Teacher' }).waitFor();

    await p.evaluate(() => {
      const titles = [
        'Stack discipline',
        'Binary search',
        'Balanced tree',
        'Hash collisions',
        'Breadth-first search',
        'Depth-first search',
        'Shortest paths',
        'Connected components',
        'Topological order',
        'Spanning tree',
        'Complexity',
        'Sorting invariant',
        'Encapsulation',
        'Polymorphism',
        'Relations',
        'Transactions',
        'Activation function',
        'Gradient descent',
        'Combinations',
        'Graph coloring',
      ];
      const tasks = titles.map((title, i) => ({
        id: 'fixture-' + i,
        title,
        prompt: 'Demonstration question: ' + title + '. Select the correct statement.',
        type: 'choice',
        level: (i % 3) + 1,
        section: i < 12 ? 'graphs' : i < 14 ? 'oop' : 'algorithms',
        set:
          i < 10 ? 'graphs-demo' : i < 12 ? 'graphs-next' : i < 14 ? 'oop-demo' : 'algorithms-demo',
        setName:
          i < 10
            ? 'Graphs · Seminar 5'
            : i < 12
              ? 'Graphs · Seminar 6'
              : i < 14
                ? 'OOP · Basics'
                : 'Algorithms · Fundamentals',
        correctAnswer: 'Option B',
      }));
      catalog = {
        sections: { algorithms: 'Algorithms', oop: 'OOP', graphs: 'Graphs', db: 'DB', nn: 'NN' },
        tasks,
      };
      const students = Array.from({ length: 12 }, (_, i) => ({
        nick: 'Demo Student ' + String(i + 1).padStart(2, '0'),
        icon: '🧑‍🎓',
        connected: i !== 4,
        rank: i + 1,
        score: 2400 - i * 120,
        correct: Math.max(1, 18 - i),
        tabLeaves: i === 3 ? 2 : 0,
        answeredThisRound: i < 7,
      }));
      window.backlogReport = {
        session: { id: 101, title: 'Graphs · Seminar 5', date: '2026-11-24', sections: ['graphs'] },
        questions: tasks,
        participants: students,
        results: students.map((s) => ({ nick: s.nick, place: s.rank, total: s.score })),
        answers: tasks.flatMap((q, i) =>
          students
            .filter((_, j) => i !== 19 || j < 2)
            .map((s, j) => ({
              nick: s.nick,
              task_id: q.id,
              correct: (j + i) % (3 + (i % 4)) !== 0,
              answer_text: (j + i) % (3 + (i % 4)) !== 0 ? 'Option B' : 'Option A',
              points: (j + i) % (3 + (i % 4)) !== 0 ? 100 : 0,
              duration_ms: 6000 + j * 300,
            }))
        ),
        checks: students.map((s, i) => ({
          nick: s.nick,
          status: i === 4 ? 'outside' : i % 3 === 0 ? 'confirmed' : 'in_zone',
        })),
        events: [
          { nick: 'Demo Student 04', kind: 'tableave', at: '2026-11-24T10:04:18Z' },
          { nick: 'Demo Student 04', kind: 'tableave', at: '2026-11-24T10:05:21Z' },
          { nick: 'Demo Student 05', kind: 'disconnected', at: '2026-11-24T10:06:12Z' },
          { nick: 'Demo Student 05', kind: 'reconnected', at: '2026-11-24T10:06:19Z' },
        ],
      };
      report = window.backlogReport;
      history = [101, 100, 99].map((id, i) => ({
        id,
        title: ['Graphs · Seminar 5', 'Graphs · Seminar 4', 'OOP · Basics'][i],
        date: ['2026-11-24', '2026-11-21', '2026-11-20'][i],
        status: 'finished',
        sets: [{ name: i === 2 ? 'OOP · Basics' : 'Graphs · Seminar ' + (5 - i) }],
        winner: { nick: 'Demo Student 01' },
      }));
      rooms = [
        { id: 'fixture-room', title: 'Next Graphs class', status: 'lobby', participants: 0 },
      ];
      window.backlogState = {
        session: {
          status: 'running',
          stream: 2,
          total: 20,
          metadata: { title: 'Graphs · Seminar 5' },
          preparation: {
            title: 'Graphs · Seminar 5',
            stream: 2,
            taskIds: tasks.slice(0, 10).map((t) => t.id),
            timeLimits: { choice: 45 },
          },
          reveal: 'after',
          attendanceSettings: { enabled: false, radius: 200 },
        },
        roster: students,
        leaderboard: students,
        attendance: window.backlogReport.checks,
        round: 7,
        roundTotal: 20,
        answeredCount: 7,
        deadline: Date.now() + 25000,
        serverTime: Date.now(),
        limit: 45000,
        currentTitle: 'Connected components',
        currentType: 'choice',
        currentAnswer: 'Option B',
        joinUrl: 'https://example.org/?room=demo',
        qrSvg: '',
        paused: false,
      };
      adminData = {
        users: [
          {
            id: 'demo',
            name: 'Demo Owner',
            email: 'owner@example.org',
            sections: ['graphs', 'oop'],
            active: true,
            role: 'admin',
          },
          {
            id: 'teacher',
            name: 'Demo Teacher',
            email: 'teacher@example.org',
            sections: ['oop'],
            active: true,
            role: 'teacher',
          },
        ],
        invitations: [],
        sets: [
          { title: 'OOP · Personal set', id: 'demo-set', section: 'oop', visibility: 'personal' },
        ],
        keys: [],
        audit: [],
      };
      requests = [
        {
          id: 'demo-request',
          kind: 'new_subject',
          title: 'Discrete Mathematics',
          message: 'Request a subject area for the next term.',
          status: 'pending',
          reply: '',
        },
      ];
      room = null;
      state = null;
      picked = new Set();
      section = '';
      setFilter = '';
      page = 'library';
      render();
      const banner = document.createElement('div');
      banner.id = 'backlog-context';
      banner.style =
        'padding:16px 28px;background:#e4ecf9;color:#18385b;border-bottom:2px solid #8ca7ce;font:15px/1.5 system-ui';
      document.body.prepend(banner);
    });
    const out = path.join(root, 'docs/backlog/images');
    fs.mkdirSync(out, { recursive: true });
    async function shot(file, title, note) {
      await p.evaluate(
        ({ title, note }) => {
          document.getElementById('backlog-context').textContent =
            'CURRENT UI · SYNTHETIC DATA · ' + title + ' — ' + note;
          window.scrollTo(0, 0);
        },
        { title, note }
      );
      await p.screenshot({ path: path.join(out, file) });
    }
    await shot(
      'library.png',
      'Question library',
      'Subject / set / question selection. No advanced filter or random sample panel yet.'
    );
    await p.evaluate(() => {
      section = 'db';
      render();
    });
    await shot(
      'empty-subject.png',
      'DB / NN content',
      'Empty section shown using a demo catalog. Real content needs subject review.'
    );
    await p.evaluate(() => {
      section = '';
      configure();
    });
    await shot(
      'session-setup.png',
      'Prepare session',
      'Current optional timing / attendance form. Explicit final selection review is a separate backlog task.'
    );
    await p.evaluate(() => {
      closeModal();
      state = window.backlogState;
      room = 'fixture-room';
      page = 'lobby';
      render();
    });
    await shot(
      'live-room.png',
      'Current session',
      'Current controls above the climb board. A complete private question / timer console is still planned.'
    );
    await p.evaluate(() => {
      page = 'sessions';
      render();
    });
    await shot(
      'sessions.png',
      'My sessions',
      'Prepared rooms above saved reports. Repeat currently resolves available question IDs.'
    );
    await p.evaluate(() => {
      page = 'analytics';
      report = window.backlogReport;
      reportTab = 'overview';
      render();
    });
    assert.equal(await p.locator('.accuracy-value').count(), 20);
    await shot(
      'analytics.png',
      'Session analytics',
      'Percent labels are implemented. Comparing several sessions is still planned.'
    );
    await p.evaluate(() => {
      reportTab = 'leaderboard';
      render();
    });
    await shot(
      'leaderboard.png',
      'Leaderboard',
      'Overall ranking and attendance are visible; a separate attendance-eligible rank is still planned.'
    );
    await p.evaluate(() => {
      selectedStudent = 'Demo Student 04';
      reportTab = 'student';
      render();
    });
    await shot(
      'student-report.png',
      'Student report',
      'Saved answers, correct answers and tab leaves. Reusable stable student IDs are a separate task.'
    );
    await p.evaluate(() => {
      reportTab = 'connections';
      render();
    });
    await shot(
      'connections.png',
      'Connections',
      'Existing event timeline. Paired disconnect duration and latency diagnosis are still planned.'
    );
    await p.evaluate(() => {
      page = 'admin';
      render();
    });
    await shot(
      'administration.png',
      'Administration',
      'Current users and fixed subject grants. Dynamic subject catalog is still planned.'
    );
    await p.evaluate(() => {
      page = 'requests';
      render();
      newRequest();
    });
    await shot(
      'feedback.png',
      'Feedback & requests',
      'Current manual subject/set ID input; no screenshot upload control yet.'
    );
    await p.evaluate(() => closeModal());
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => {
      page = 'home';
      state = null;
      room = null;
      render();
      configure();
    });
    await shot(
      'mobile-setup.png',
      'Mobile setup',
      'Current responsive dialog; broader device/accessibility verification remains in the backlog.'
    );
    await p.setViewportSize({ width: 1440, height: 1050 });
    await p.setContent(
      `<!doctype html><html><head><style>body{margin:0;background:#edf2f8;color:#19263c;font:20px/1.5 system-ui;padding:60px}h1{font-size:36px}p{max-width:1100px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.card{background:white;border:1px solid #b7c8de;border-radius:20px;padding:26px;min-height:240px}small{color:#58708f}b{display:block;font-size:26px;margin:12px 0}.foot{background:#fff1be;padding:24px;border-radius:16px;margin-top:30px}</style></head><body><small>PROPOSED WORKFLOW · EXPLANATORY DIAGRAM · NOT AN IMPLEMENTED SCREEN</small><h1>Backups and safe releases</h1><p>These infrastructure cards improve operations behind the classroom UI. Current manual safeguards are the starting point.</p><div class=grid><div class=card>1 · Protect the data<b>SQLite backup API</b>Private room snapshots<br>Retention / disk budget<br>Scheduled restore exercise</div><div class=card>2 · Validate a release<b>Isolated candidate</b>Temporary runtime<br>Health / HTTP / WebSocket tests<br>Keep previous image</div><div class=card>3 · Switch safely<b>Check live rooms</b>Choose a safe restart window<br>Verify the deployed version<br>Rollback code, preserve answers</div></div><div class=foot>Expected result: a failed update or server incident has a rehearsed recovery path. A backup is useful only if it can actually be restored.</div><p>No production data or credentials are shown. Thresholds, retention and recovery targets must be selected explicitly in the implementation task.</p></body></html>`
    );
    await p.screenshot({ path: path.join(out, 'operations-proposal.png') });
    assert.deepEqual(errors, []);
    console.log('Captured 13 synthetic context screenshots / explanatory diagram');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
