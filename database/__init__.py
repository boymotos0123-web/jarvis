"""
Camada de banco de dados (SQLite).

- `Database` abre a conexão e aplica as migrations de `database/migrations/`
  em ordem (001_..., 002_...), registrando cada uma em `schema_migrations`.
- Para evoluir o banco, crie um novo arquivo NNN_descricao.sql — nunca edite
  uma migration que já foi aplicada.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger("jarvis.database")
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False + lock: o servidor usa várias threads
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._lock = threading.RLock()

    # ---------- migrations ----------
    def migrate(self) -> list[str]:
        applied: list[str] = []
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
            )
            done = {r["name"] for r in self._conn.execute("SELECT name FROM schema_migrations")}
            for file in sorted(MIGRATIONS_DIR.glob("*.sql")):
                if file.name in done:
                    continue
                self._conn.executescript(file.read_text(encoding="utf-8"))
                self._conn.execute("INSERT INTO schema_migrations (name) VALUES (?)", (file.name,))
                self._conn.commit()
                applied.append(file.name)
                log.info("migration aplicada: %s", file.name)
        return applied

    # ---------- helpers ----------
    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur

    def executemany(self, sql: str, rows: Iterable[Iterable[Any]]) -> None:
        with self._lock:
            self._conn.executemany(sql, [tuple(r) for r in rows])
            self._conn.commit()

    def transaction(self, statements: list[tuple[str, Iterable[Any]]]) -> None:
        """Executa várias instruções de uma vez (tudo ou nada)."""
        with self._lock:
            try:
                for sql, params in statements:
                    self._conn.execute(sql, tuple(params))
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    def ping(self) -> bool:
        try:
            self.one("SELECT 1 AS ok")
            return True
        except sqlite3.Error:
            return False

    def close(self) -> None:
        with self._lock:
            self._conn.close()
