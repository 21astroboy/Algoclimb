"""
Защита входа: TOTP-код (HMAC по окну времени), одноразовые nonce, IP-allowlist.
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


# ---------- IP allowlist ----------
def _ip_to_int(ip):
    p = ip.replace("::ffff:", "").split(".")
    if len(p) != 4:
        return None
    try:
        q = [int(x) for x in p]
    except ValueError:
        return None
    if any(x < 0 or x > 255 for x in q):
        return None
    return (q[0] << 24) + (q[1] << 16) + (q[2] << 8) + q[3]


def _in_cidr(ip, cidr):
    net, bits_s = cidr.split("/")
    bits = int(bits_s)
    a, b = _ip_to_int(ip), _ip_to_int(net)
    if a is None or b is None:
        return False
    mask = 0 if bits == 0 else ((~0 << (32 - bits)) & 0xFFFFFFFF)
    return (a & mask) == (b & mask)


def is_loopback(ip):
    a = (ip or "").replace("::ffff:", "")
    return a in ("127.0.0.1", "::1", "localhost") or a.startswith("127.")


def ip_allowed(config, ip):
    al = config.get("ipAllowlist", {}) or {}
    if not al.get("enabled"):
        return True
    if ip in ("127.0.0.1", "::1"):
        return True
    return any(_in_cidr(ip, c) for c in al.get("cidrs", []))
