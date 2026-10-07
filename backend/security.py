"""
Защита входа: TOTP-код (HMAC по окну времени) и одноразовые nonce.
Точный порт логики из server.js — коды входа совместимы (тот же алгоритм и алфавит).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

TOTP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 символа, без похожих 0/O/1/I


class Security:
    def __init__(self, config):
        self.config = config
        qr = config.get("qrRotation", {}) or {}
        self.secret = (qr.get("secret") or "").strip() or secrets.token_hex(16)
        self._nonces = {}  # nonce -> expiry (epoch ms)
        self.NONCE_TTL = 120_000

    # ---------- TOTP ----------
    def _interval_ms(self):
        return max(1, self.config["qrRotation"].get("intervalSec", 8) or 8) * 1000

    def _now_ms(self):
        return int(time.time() * 1000)

    def token_window(self):
        return self._now_ms() // self._interval_ms()

    def totp_for(self, win):
        h = hmac.new(self.secret.encode(), str(win).encode(), hashlib.sha256).digest()
        return "".join(TOTP_ALPHABET[h[i] & 31] for i in range(6))

    def current_token(self):
        return self.totp_for(self.token_window())

    def token_ok(self, tok):
        if not self.config["qrRotation"].get("enabled"):
            return True
        if not tok:
            return False
        t = str(tok).strip().upper()
        w = self.token_window()
        grace = self.config["qrRotation"].get("graceWindows")
        grace = 1 if grace is None else grace
        return any(t == self.totp_for(w - d) for d in range(grace + 1))

    # ---------- nonce ----------
    def issue_nonce(self):
        n = secrets.token_urlsafe(12)
        self._nonces[n] = self._now_ms() + self.NONCE_TTL
        return n

    def consume_nonce(self, n):
        if not n:
            return False
        exp = self._nonces.pop(n, None)
        if not exp:
            return False
        return exp > self._now_ms()

    def sweep(self):
        now = self._now_ms()
        for n in [k for k, e in self._nonces.items() if e <= now]:
            self._nonces.pop(n, None)


# ---------- loopback (для debug-режима с localhost) ----------
def is_loopback(ip):
    a = (ip or "").replace("::ffff:", "")
    return a in ("127.0.0.1", "::1", "localhost") or a.startswith("127.")
