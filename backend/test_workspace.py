"""Account isolation, one-use recovery and location attendance regressions."""

import asyncio
import secrets
import time
import unittest
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

import accounts
import db
import main
import workspace


class WorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.password = "test-only-long-password"
        cls.uid = secrets.token_hex(12)
        db._exec(
            "INSERT INTO users(id,email,name,subject,password,role,sections) VALUES(?,?,?,?,?,'admin','[]')",
            (
                cls.uid,
                cls.uid + "@example.org",
                "Test Owner",
                "Graphs",
                accounts.password_hash(cls.password),
            ),
        )
        cls.client.post(
            "/api/workspace/login",
            json={"email": cls.uid + "@example.org", "password": cls.password},
        ).raise_for_status()
        cls.teachers = []

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        ids = [cls.uid, *cls.teachers]
        for uid in ids:
            accounts.revoke_all(uid)
            for table, col in (
                ("users", "id"),
                ("account_tokens", "user_id"),
                ("teacher_sets", "owner_id"),
                ("session_owners", "owner_id"),
                ("teacher_requests", "owner_id"),
                ("room_owners", "owner_id"),
            ):
                db._exec(f"DELETE FROM {table} WHERE {col}=?", (uid,))
        for rid, g in list(main.rooms.items()):
            if g.owner_id in ids:
                main.rooms.pop(rid)
                g.snapshot_file.unlink(missing_ok=True)

    def teacher(self, sections=None):
        address = secrets.token_hex(8) + "@example.org"
        token = self.client.post(
            "/api/workspace/admin/invite",
            json={"email": address, "sections": sections or ["graphs"]},
        ).json()["token"]
        client = TestClient(main.app)
        r = client.post(
            "/api/workspace/activate",
            json={
                "token": token,
                "name": "Teacher",
                "subject": "Graphs",
                "password": self.password,
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.teachers.append(r.json()["id"])
        self.addCleanup(client.close)
        return client, r.json(), token

    def test_invitation_one_use_and_teacher_cannot_invite(self):
        c, _, token = self.teacher()
        self.assertEqual(
            c.post(
                "/api/workspace/activate",
                json={
                    "token": token,
                    "name": "Other",
                    "subject": "Graphs",
                    "password": self.password,
                },
            ).status_code,
            400,
        )
        self.assertEqual(c.get("/api/workspace/admin").status_code, 403)
        self.assertEqual(c.post("/api/workspace/admin/invite", json={}).status_code, 403)
        self.assertEqual(c.post("/api/workspace/login", json=[]).status_code, 400)

    def test_private_banks_and_removed_subject_permissions(self):
        c, u, _ = self.teacher()
        other, _, _ = self.teacher()
        task = {
            "id": "one",
            "title": "Unique private graph task",
            "prompt": "Pick",
            "type": "choice",
            "options": ["A", "B"],
            "answer": 0,
            "section": "graphs",
        }
        r = c.post(
            "/api/workspace/import",
            json={
                "title": "Private set",
                "section": "graphs",
                "mode": "permanent",
                "tasks": [task],
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(
            any(
                t["title"] == task["title"] for t in c.get("/api/workspace/catalog").json()["tasks"]
            )
        )
        self.assertFalse(
            any(
                t["title"] == task["title"]
                for t in other.get("/api/workspace/catalog").json()["tasks"]
            )
        )
        self.assertEqual(
            c.post(
                "/api/workspace/import",
                json={"title": "Bad", "section": "oop", "mode": "permanent", "tasks": [task]},
            ).status_code,
            403,
        )
        self.client.post(
            "/api/workspace/admin/users/" + u["id"], json={"sections": []}
        ).raise_for_status()
        self.assertEqual(c.get("/api/workspace/catalog").json()["tasks"], [])

    def test_api_keys_ownership_expiry_and_revocation(self):
        c, u, _ = self.teacher()
        other, _, _ = self.teacher()
        sid = db.create_session(1, {"sections": ["graphs"], "questions": [], "title": "Owned"})
        db._exec("INSERT INTO session_owners VALUES(?,?,?)", (sid, u["id"], "test"))
        self.addCleanup(db._exec, "DELETE FROM sessions WHERE id=?", (sid,))
        token = c.post("/api/workspace/keys", json={"name": "Research"}).json()
        self.assertEqual(
            other.post("/api/workspace/keys/" + token["id"] + "/revoke", json={}).status_code, 404
        )
        headers = {"Authorization": "Bearer " + token["token"]}
        self.assertEqual(c.get(f"/api/v1/sessions/{sid}", headers=headers).status_code, 200)
        self.assertEqual(other.get(f"/api/workspace/sessions/{sid}").status_code, 404)
        self.client.post(
            "/api/workspace/admin/users/" + u["id"], json={"sections": []}
        ).raise_for_status()
        self.assertEqual(c.get(f"/api/v1/sessions/{sid}", headers=headers).status_code, 403)
        db._exec("UPDATE developer_keys SET expires_at=0 WHERE id=?", (token["id"],))
        self.assertEqual(c.get("/api/v1/sessions", headers=headers).status_code, 401)

    def test_recovery_consumes_link_and_revokes_old_credentials(self):
        c, u, _ = self.teacher()
        key = c.post("/api/workspace/keys", json={"name": "Old"}).json()
        recovery = self.client.post(
            "/api/workspace/admin/invite", json={"kind": "recover", "user_id": u["id"]}
        ).json()
        fresh = TestClient(main.app)
        self.addCleanup(fresh.close)
        r = fresh.post(
            "/api/workspace/activate",
            json={"token": recovery["token"], "password": "new-long-password"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.get("/api/workspace/me").status_code, 401)
        self.assertEqual(
            fresh.get(
                "/api/v1/sessions", headers={"Authorization": "Bearer " + key["token"]}
            ).status_code,
            401,
        )
        self.assertEqual(
            fresh.post(
                "/api/workspace/activate",
                json={"token": recovery["token"], "password": "another-password"},
            ).status_code,
            400,
        )

    def test_password_change_requires_old_password_and_rotates_credentials(self):
        c, _u, _ = self.teacher()
        key = c.post("/api/workspace/keys", json={"name": "Old key"}).json()
        body = {
            "name": "Updated teacher",
            "subject": "Graphs",
            "password": "new-profile-password",
            "current_password": "wrong-password",
        }
        self.assertEqual(c.post("/api/workspace/account", json=body).status_code, 403)
        body["current_password"] = self.password
        self.assertEqual(c.post("/api/workspace/account", json=body).status_code, 200)
        self.assertEqual(c.get("/api/workspace/me").json()["name"], "Updated teacher")
        self.assertEqual(
            c.get(
                "/api/v1/sessions", headers={"Authorization": "Bearer " + key["token"]}
            ).status_code,
            401,
        )

    def test_room_isolation_geo_accuracy_and_manual_override(self):
        c, _u, _ = self.teacher()
        other, _, _ = self.teacher()
        rid = c.post("/api/workspace/rooms", json={}).json()["id"]
        rid2 = other.post("/api/workspace/rooms", json={}).json()["id"]
        self.assertNotEqual(rid, rid2)
        self.assertEqual(
            other.post(
                f"/api/workspace/rooms/{rid}/settings", json={"title": "Hijack"}
            ).status_code,
            404,
        )
        g = main.rooms[rid]
        g.by_nick["Student"] = {"resume": "private-resume", "nick": "Student"}
        r = c.post(
            f"/api/workspace/rooms/{rid}/settings",
            json={
                "title": "Class",
                "geo": {"latitude": 55, "longitude": 37, "accuracy": 10, "radius": 200},
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        loc = {
            "nick": "Student",
            "resume": "private-resume",
            "latitude": 55,
            "longitude": 37,
            "accuracy": 15,
            "timestamp": time.time() * 1000,
        }
        self.assertEqual(
            c.post(f"/api/attendance/{rid}", json={**loc, "resume": "wrong"}).status_code, 403
        )
        self.assertEqual(c.post(f"/api/attendance/{rid}", json=loc).json()["status"], "in_zone")
        self.assertNotIn("Student", main.rooms[rid2].by_nick)
        self.assertEqual(
            c.post(
                f"/api/workspace/rooms/{rid}/attendance",
                json={"nick": "Student", "status": "rejected"},
            ).status_code,
            200,
        )
        self.assertEqual(c.post(f"/api/attendance/{rid}", json=loc).json()["status"], "rejected")
        self.assertEqual(workspace.geo_status(0, 200, 500), "needs_review")
        self.assertEqual(workspace.geo_status(300, 200, 10), "outside")
        self.assertEqual(workspace.geo_status(190, 200, 20), "needs_review")
        self.assertLess(workspace.distance((55, 37), (55, 37)), 0.01)

    def test_csrf_and_legacy_master_key_blocked(self):
        self.assertEqual(
            self.client.post(
                "/api/workspace/logout", headers={"Origin": "https://evil.example"}, json={}
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/v1/auth/token",
                headers={"X-Teacher-Key": main.TEACHER_KEY},
                json={"name": "Bypass"},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.get("/export/analytics.xlsx", params={"key": main.TEACHER_KEY}).status_code,
            403,
        )

    def test_feedback_hidden_and_snapshots_are_independent(self):
        async def check():
            g = main.Game(self.uid, "unit-a")
            other = main.Game(self.uid, "unit-b")
            self.assertNotEqual(g.snapshot_file, other.snapshot_file)
            g.session["reveal"] = "teacher"
            g.session["test"] = True
            g.order = [
                {
                    "id": "q",
                    "title": "Q",
                    "prompt": "P",
                    "type": "choice",
                    "options": ["A", "B"],
                    "answer": 0,
                }
            ]
            s = {"nick": "Student", "answers": {}, "score": 0, "correct": 0}
            self.assertEqual(g.session_end_payload(s, [])["review"], [])
            ws = type("FakeWS", (), {"send_text": AsyncMock(), "scope": {}})()
            await g.send(ws, {"type": "answered", "correct": True, "points": 100})
            import json

            data = json.loads(ws.send_text.call_args.args[0])
            self.assertNotIn("correct", data)
            self.assertTrue(data["feedbackHidden"])

        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
