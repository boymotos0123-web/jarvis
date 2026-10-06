"""Cache de pesquisas no SQLite: a mesma consulta não é repetida dentro do prazo (TTL)."""
from __future__ import annotations

import hashlib
import json
import time

from core.memory import strip_accents

TTL = {"news": 30 * 60, "general": 12 * 3600, "wikipedia": 7 * 86400, "github": 24 * 3600, "academic": 7 * 86400, "page": 24 * 3600}


class SearchCache:
    def __init__(self, db):
        self.db = db
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key(provider: str, query: str, extra: str = "") -> str:
        q = " ".join(strip_accents(query.lower()).split())
        return hashlib.sha1(f"{provider}|{q}|{extra}".encode()).hexdigest()

    def get(self, provider: str, query: str, extra: str = ""):
        row = self.db.one("SELECT results, created_at, ttl FROM search_cache WHERE key = ?", (self.key(provider, query, extra),))
        if row and time.time() - row["created_at"] < row["ttl"]:
            self.hits += 1
            return json.loads(row["results"])
        self.misses += 1
        return None

    def put(self, provider: str, query: str, results, ttl: float, extra: str = "") -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO search_cache (key, provider, query, results, created_at, ttl) VALUES (?, ?, ?, ?, ?, ?)",
            (self.key(provider, query, extra), provider, query[:300], json.dumps(results, ensure_ascii=False), time.time(), ttl),
        )

    def purge(self) -> int:
        return self.db.execute("DELETE FROM search_cache WHERE ? - created_at > ttl", (time.time(),)).rowcount
