"""Provision the initial owner or a one-use recovery link through trusted server access.

Run with PYTHONPATH=backend and the same RUNTIME_DIR as the application.
Secrets are written only to a new mode-0600 file; never printed to stdout.
"""

import argparse
import json
import os
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import accounts
import catalog
import db

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--email", required=True)
parser.add_argument("--name", default="AlgoClimb Owner")
parser.add_argument("--subject", default="Teaching")
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--recover", action="store_true")
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
# Refuse to overwrite a credential file, even when the caller makes a mistake.
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    if args.recover:
        rows = db._all(
            "SELECT id FROM users WHERE email=? AND role='admin' AND active=1",
            (args.email.lower(),),
        )
        if not rows:
            raise SystemExit("Active owner not found.")
        token = secrets.token_urlsafe(32)
        uid = rows[0]["id"]
        db._exec("UPDATE account_tokens SET used=1 WHERE user_id=? AND kind='recover'", (uid,))
        db._exec(
            "INSERT INTO account_tokens(hash,user_id,email,kind,expires) VALUES(?,?,?,'recover',?)",
            (accounts.digest(token), uid, args.email.lower(), int(time.time()) + 3600),
        )
        data = {
            "email": args.email.lower(),
            "recovery_fragment": "#recover=" + token,
            "expires_in": 3600,
        }
    else:
        if accounts.initialized():
            raise SystemExit("An owner already exists; use --recover instead.")
        password = secrets.token_urlsafe(24)
        uid = secrets.token_hex(12)
        db._exec(
            "INSERT INTO users(id,email,name,subject,password,role,sections) VALUES(?,?,?,?,?,'admin',?)",
            (
                uid,
                args.email.lower(),
                args.name,
                args.subject,
                accounts.password_hash(password),
                json.dumps(list(catalog.SECTIONS)),
            ),
        )
        db._exec("UPDATE developer_keys SET revoked=1 WHERE owner_id IS NULL")
        data = {"email": args.email.lower(), "password": password}
    with os.fdopen(fd, "w") as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
    accounts.audit(uid, "owner_recovery_issued" if args.recover else "owner_provisioned", uid)
    print("Owner credentials written to the requested private file.")
except BaseException:
    try:
        os.close(fd)
    except OSError:
        pass
    args.output.unlink(missing_ok=True)
    raise
