"""
Memória do JARVIS (SQLite).

- `MemoryStore`: fatos e notas de longo prazo, separados por categoria.
  Fatos com `key` (ex.: "projeto atual") são únicos e atualizados no lugar.
- `ConversationStore`: conversas e mensagens (histórico).

A busca atual é por palavras-chave. A interface `MemoryStore.search()` é o
ponto onde, no futuro, entram embeddings + banco vetorial sem mudar quem usa.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from database import Database

CATEGORIES = ("pessoal", "projetos", "preferencias", "conhecimento", "conversas", "sistema", "contexto")

_STOPWORDS = {
    "a", "o", "as", "os", "um", "uma", "de", "da", "do", "das", "dos", "e", "é", "que", "qual", "quais",
    "meu", "minha", "meus", "minhas", "seu", "sua", "para", "pra", "por", "com", "em", "no", "na", "nos", "nas",
    "eu", "voce", "você", "me", "isso", "esse", "essa", "ser", "sao", "são", "como", "jarvis",
}


def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def normalize_key(text: str) -> str:
    """'Meu Projeto Atual' -> 'projeto atual' (minúsculo, sem acento, sem artigos/pronomes iniciais)."""
    t = strip_accents(text.lower()).strip(" .!?,;:\"'")
    t = re.sub(r"^(o|a|os|as|meu|minha|meus|minhas)\s+", "", t)
    t = re.sub(r"\s+", " ", t)
    return t


def keywords(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", strip_accents(text.lower()))
    return [w for w in words if len(w) > 2 and w not in _STOPWORDS]


@dataclass
class Memory:
    id: int
    category: str
    key: str | None
    content: str
    source: str
    importance: float
    created_at: str
    updated_at: str

    def to_dict(self) -> dict:
        return dict(self.__dict__)


class MemoryStore:
    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def _row(r: dict | None) -> Memory | None:
        return Memory(**r) if r else None

    def remember(self, content: str, category: str = "pessoal", key: str | None = None,
                 source: str = "user", importance: float = 0.5) -> Memory:
        if category not in CATEGORIES:
            raise ValueError(f"categoria inválida: {category}")
        content = content.strip()
        if not content:
            raise ValueError("conteúdo vazio")
        nkey = normalize_key(key) if key else None
        if nkey:
            existing = self.db.one("SELECT id FROM memories WHERE key = ?", (nkey,))
            if existing:
                self.db.execute(
                    "UPDATE memories SET content = ?, category = ?, source = ?, importance = ?, updated_at = datetime('now') WHERE id = ?",
                    (content, category, source, importance, existing["id"]),
                )
                return self.get(existing["id"])  # type: ignore[return-value]
        cur = self.db.execute(
            "INSERT INTO memories (category, key, content, source, importance) VALUES (?, ?, ?, ?, ?)",
            (category, nkey, content, source, importance),
        )
        return self.get(cur.lastrowid)  # type: ignore[return-value]

    def get(self, memory_id: int) -> Memory | None:
        return self._row(self.db.one("SELECT * FROM memories WHERE id = ?", (memory_id,)))

    def recall(self, key: str) -> Memory | None:
        """Busca exata pela chave; se não houver, tenta uma chave que contenha o termo."""
        nkey = normalize_key(key)
        hit = self.db.one("SELECT * FROM memories WHERE key = ?", (nkey,))
        if not hit and nkey:
            hit = self.db.one(
                "SELECT * FROM memories WHERE key LIKE ? ORDER BY length(key) LIMIT 1", (f"%{nkey}%",)
            )
        return self._row(hit)

    def list(self, category: str | None = None, limit: int = 500) -> list[Memory]:
        if category:
            rows = self.db.all("SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC, id DESC LIMIT ?", (category, limit))
        else:
            rows = self.db.all("SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?", (limit,))
        return [Memory(**r) for r in rows]

    def search(self, query: str, limit: int = 5, category: str | None = None) -> list[Memory]:
        """Pontua memórias pelas palavras-chave em comum com a consulta."""
        terms = keywords(query)
        if not terms:
            return []
        scored: list[tuple[float, Memory]] = []
        for m in self.list(category):
            hay = strip_accents(f"{m.key or ''} {m.content}".lower())
            score = sum(1 for t in terms if t in hay)
            if score:
                scored.append((score + m.importance, m))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in scored[:limit]]

    def forget(self, memory_id: int) -> bool:
        return self.db.execute("DELETE FROM memories WHERE id = ?", (memory_id,)).rowcount > 0

    def counts(self) -> dict[str, int]:
        rows = self.db.all("SELECT category, COUNT(*) AS n FROM memories GROUP BY category")
        out = {c: 0 for c in CATEGORIES}
        out.update({r["category"]: r["n"] for r in rows})
        return out


class ConversationStore:
    def __init__(self, db: Database):
        self.db = db

    def create(self, title: str | None = None) -> int:
        return self.db.execute("INSERT INTO conversations (title) VALUES (?)", (title,)).lastrowid

    def exists(self, conversation_id: int) -> bool:
        return self.db.one("SELECT id FROM conversations WHERE id = ?", (conversation_id,)) is not None

    def latest(self) -> int | None:
        r = self.db.one("SELECT id FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 1")
        return r["id"] if r else None

    def add(self, conversation_id: int, role: str, content: str, route: str | None = None) -> int:
        mid = self.db.execute(
            "INSERT INTO messages (conversation_id, role, content, route) VALUES (?, ?, ?, ?)",
            (conversation_id, role, content, route),
        ).lastrowid
        self.db.execute("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", (conversation_id,))
        return mid

    def history(self, conversation_id: int, limit: int = 50) -> list[dict]:
        rows = self.db.all(
            "SELECT id, role, content, route, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
            (conversation_id, limit),
        )
        return list(reversed(rows))
