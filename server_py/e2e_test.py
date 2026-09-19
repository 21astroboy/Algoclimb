"""Сквозной тест игрового цикла FastAPI-бэкенда через реальные WebSocket-соединения."""
import asyncio
import json
import sys

import websockets

import bank

BASE = "ws://127.0.0.1:8099"
KEY = "TESTKEY99"

CHOICE_ID = "asd_bst_search"   # lvl1, answer index 0
GRAPH_ID = "gb_matrix"         # lvl2, requiredEdges

results = {"ok": [], "fail": []}


def check(name, cond):
    (results["ok"] if cond else results["fail"]).append(name)
    print(("  PASS " if cond else "  FAIL ") + name)


async def recv_until(ws, typ, timeout=8):
    """Читать сообщения, пока не встретится нужный тип; вернуть его (и копить прочее)."""
    got = []
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        m = json.loads(raw)
        got.append(m)
        if m.get("type") == typ:
            return m, got


async def drain(ws, seconds=0.4):
    out = []
    try:
        while True:
            raw = await asyncio.wait_for(ws.recv(), seconds)
            out.append(json.loads(raw))
    except asyncio.TimeoutError:
        return out


def correct_choice_index(pub_options):
    t = bank.BY_ID[CHOICE_ID]
    correct_text = t["options"][t["answer"]]
    return pub_options.index(correct_text)


async def main():
    # --- teacher ---
    teacher = await websockets.connect(f"{BASE}/teacher?role=teacher&key={KEY}")
    init = await drain(teacher, 1.0)
    types = {m["type"] for m in init}
    check("teacher receives answerkey", "answerkey" in types)
    check("teacher receives catalog", "catalog" in types)
    check("teacher receives state", "state" in types)

    # --- two students join (debug/localhost -> без токена) ---
    st1 = await websockets.connect(f"{BASE}/?role=student")
    await st1.send(json.dumps({"type": "join", "nick": "Alice", "icon": "🦊"}))
    j1, _ = await recv_until(st1, "joined")
    check("student1 joined", j1.get("nick") == "Alice" and j1.get("status") == "lobby")

    st2 = await websockets.connect(f"{BASE}/?role=student")
    await st2.send(json.dumps({"type": "join", "nick": "Bob", "icon": "🐼"}))
    j2, _ = await recv_until(st2, "joined")
    check("student2 joined", j2.get("nick") == "Bob")

    await drain(teacher, 0.5)

    # --- start a real (non-test) session with our 2 known tasks ---
    await teacher.send(json.dumps({"type": "start", "taskIds": [CHOICE_ID, GRAPH_ID], "test": False}))

    # both students should get task #0 (choice)
    t1, _ = await recv_until(st1, "task")
    t2, _ = await recv_until(st2, "task")
    check("round0 is choice task", t1["task"]["type"] == "choice" and t1["task"]["id"] == CHOICE_ID)
    check("round0 total==2", t1["total"] == 2)

    # Alice answers correctly, Bob answers wrong
    ci = correct_choice_index(t1["task"]["options"])
    wrong = 1 - ci if len(t1["task"]["options"]) > 1 else ci
    await st1.send(json.dumps({"type": "answer", "taskId": CHOICE_ID, "payload": {"choice": ci}}))
    a1, _ = await recv_until(st1, "answered")
    check("Alice choice correct", a1["correct"] is True and a1["points"] > 0)
    check("Alice basePoints=40 (100*1*0.4)", a1["basePoints"] == 40)
    check("Alice streak=1", a1["streak"] == 1)

    await st2.send(json.dumps({"type": "answer", "taskId": CHOICE_ID, "payload": {"choice": wrong}}))
    a2, _ = await recv_until(st2, "answered")
    check("Bob choice wrong", a2["correct"] is False and a2["points"] == 0)

    # both answered -> round should end, then reveal -> round1 begins
    r1, _ = await recv_until(st1, "roundover")
    check("Alice roundover correct", r1["correct"] is True)

    # round1 (graph) task arrives after reveal
    t1b, _ = await recv_until(st1, "task", timeout=6)
    await recv_until(st2, "task", timeout=6)
    check("round1 is graph task", t1b["task"]["type"] == "graph" and t1b["task"]["id"] == GRAPH_ID)

    # both answer graph correctly
    edges = bank.answer_edges(bank.BY_ID[GRAPH_ID])["edges"]
    await st1.send(json.dumps({"type": "answer", "taskId": GRAPH_ID, "payload": {"edges": edges}}))
    a1b, _ = await recv_until(st1, "answered")
    check("Alice graph correct", a1b["correct"] is True)
    check("Alice streak=2 -> streakBonus=25", a1b["streak"] == 2 and a1b["streakBonus"] == 25)
    check("Alice graph basePoints=80 (lvl2)", a1b["basePoints"] == 80)

    await st2.send(json.dumps({"type": "answer", "taskId": GRAPH_ID, "payload": {"edges": edges}}))
    a2b, _ = await recv_until(st2, "answered")
    check("Bob graph correct", a2b["correct"] is True)
    check("Bob streak reset then =1 -> no streakBonus", a2b["streak"] == 1 and a2b["streakBonus"] == 0)

    # session end
    end1, _ = await recv_until(st1, "sessionend", timeout=6)
    end2, _ = await recv_until(st2, "sessionend", timeout=6)
    check("Alice place=1 (higher score)", end1["place"] == 1)
    check("Alice score>Bob score", end1["score"] > end2["score"])
    check("Alice correct==2", end1["correct"] == 2)
    check("Bob correct==1", end2["correct"] == 1)
    check("review has 2 entries with explanations", len(end1["review"]) == 2)
    check("review carries correctAnswer", bool(end1["review"][0]["correctAnswer"]))

    # teacher final state
    tfin = await drain(teacher, 1.0)
    states = [m for m in tfin if m["type"] == "state"]
    check("teacher final state finished", states and states[-1]["session"]["status"] == "finished")

    await st1.close(); await st2.close(); await teacher.close()


asyncio.run(main())
print("\nRESULT:", len(results["ok"]), "passed,", len(results["fail"]), "failed")
if results["fail"]:
    print("FAILED:", results["fail"])
    sys.exit(1)
