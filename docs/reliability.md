# Measuring reliability

`tools/reliability_test.py` launches one isolated Uvicorn process, a generated question bank
covering all five types, and a temporary SQLite database. It connects synthetic students
and a teacher over real WebSockets. It never connects to the running application, changes
its session, or reads a private bank.

## Run it

Use the project's Python 3.11+ environment with `requirements.txt` installed:

```bash
# Baseline: all students finish all 30 questions, with real SQLite writes.
python tools/reliability_test.py --students 60 --rounds 30 --recovery-grace 0.5 --output /tmp/baseline.json

# Interrupted Wi-Fi simulation: 1 second offline, reconnect before/after submitting.
# Admission codes rotate every second; all students also remain idle for 65 seconds.
python tools/reliability_test.py --students 100 --rounds 30 --disconnects --qr \
  --idle 65 --outage 1 --recovery-grace 2 --output /tmp/reconnect.json
```

The second run takes roughly two minutes. Student 0 deliberately waits two seconds per
round, leaving a reproducible recovery window for the interrupted clients. That window
models a teacher giving students time to recover; it does not guarantee recovery before
an arbitrarily short live deadline. The test does not modify application timeouts or QR
settings; its configuration applies only to the temporary server.

## What passing means

The exit code is nonzero if any integrity check or latency budget fails:

- Every student receives every question and the final session summary.
- Every unique answer gets a confirmation; the final reviews match all submitted fixtures.
- The sum of acknowledged points matches the final score and persisted SQLite result.
- Attendance, answer and result row counts match the entire class and question count.
- Every intentionally dropped connection restores its current task; no spontaneous drops occur.
- Ordinary answer confirmations have p99 below 1 second, recovery maximum below 3 seconds
  (including the injected outage), and health-response p99 below 500 ms.

Faults include losing a connection before sending and losing it just after sending, before
receiving confirmation. The latter verifies restoration of already accepted answers without
awarding points twice. Ordinary confirmation latency and confirmations spanning an injected
outage are reported separately. CPU time/peak RSS refer to the child server process; synthetic
client CPU is excluded from those process figures. Client and server share a host, however,
so client workload can still compete for CPU.

Six verdict regression tests ensure that a completed-looking session cannot pass with missing
confirmations, missing database records, inconsistent scores, failed recovery or excessive delay.
CI runs those checks and a shorter 12-person, 10-question benchmark with QR and disconnects.

## Scope and limits

A loopback benchmark tests server/protocol behavior under the chosen load. It does not exercise
a classroom's access point, NAT, mobile radio, the reverse proxy/TLS path or browser rendering.
It uses small deterministic questions, not the private course bank. Accelerated rounds are
useful stress tests but do not replace a full-length lesson soak test or server-restart test.

In a real class, screen locking and Wi-Fi changes can still disconnect a phone. The practical
reliability goal is automatic reconnection plus preserved accepted answers and scores. A student
who reconnects after the next round begins can still miss a question. The benchmark detects
that as a failure rather than counting a successful TCP reconnect as full recovery.

For production confidence, repeat on a separate instance on the VPS, then rehearse with several
real phones on the classroom Wi-Fi. Keep test traffic out of the active classroom session.
The legacy `loadtest.py` now requires explicit permission to reset its target and refuses an
occupied session; use the isolated benchmark for routine checks.

## Recorded results — 29 October 2026

Each row below is a single measured run, not a capacity guarantee. All runs use 30
questions and write real attendance, answers and results into a disposable database.
Local runs below predate the teacher-update optimization. The controlled VPS comparison
uses the same benchmark, configuration, generated bank and limits before and after it.

| Run / raw JSON | Received final summary | Confirmed answers | Complete correct reviews | Ordinary answer p99 | Recovery max | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| [Local, 60 students](benchmarks/local-60.json) | 60/60 | 1800/1800 | 60/60 | 13.73 ms | — ms | Pass |
| [Local, 100 + QR + losses](benchmarks/local-100-reconnect-qr.json) | 100/100 | 3000/3000 | 100/100 | 21.16 ms | 1128.11 ms | Pass |
| [VPS, before optimization](benchmarks/vps-half-core-before.json) | 100/100 | 2878/3000 | 71/100 | 3031.28 ms | 11700.1 ms | Fail |
| [VPS, after optimization](benchmarks/vps-half-core-after.json) | 100/100 | 3000/3000 | 100/100 | 308.33 ms | 1298.05 ms | Pass |

In the VPS failure, all 100 clients received a final summary and no spontaneous
connection drops occurred, yet answers were missing. This is why joining or receiving
`sessionend` alone is not a sufficient reliability check. The failed raw report is retained.

The VPS has 2 logical CPUs and about 4 GB RAM. Both the synthetic clients and child
server ran inside a separate container capped at **0.5 CPU and 512 MiB**, with no network
other than loopback, no published ports, read-only source and temporary storage. The
existing application container was neither restarted nor replaced. Its deployed
`backend/main.py` still matched the older `ee06853` source during inspection; the measured
optimized code is not yet deployed. The existing image
supplied dependencies; public application source was mounted separately for this test.

Both VPS runs used:

```bash
python tools/reliability_test.py --students 100 --rounds 30 --disconnects --qr \
  --idle 5 --outage 1 --recovery-grace 2 --output /output/report.json
```

The baseline application source was `e68acef`. The optimized variant batches connection
notifications within the existing 300 ms teacher-update window and sends detailed answer
history only after finishing. Final breakdowns and CSV export still receive full history.
The same 122 deliberate transport aborts were injected in both VPS runs. After optimization,
all 3000 unique acknowledgements, all final scores and all stored results matched.

The questions have a 5-second deadline and QR rotates every second, so this deliberately
stresses short recovery windows. Real classroom defaults are less aggressive, but network
and browser behavior can be worse than loopback. Fault injection uses detectable transport
closure, not a silent packet blackhole. Test server restart and undetectable stale connections
separately before claiming resilience to those failures.

Raw JSON includes all latency distributions, CPU time, server peak RSS, integrity counters
and errors. The local 100-student run also includes 65 seconds of idle connections.
