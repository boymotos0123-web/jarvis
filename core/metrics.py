"""
Observabilidade: quanto tempo cada etapa levou (STT, pesquisa, 1º token do
modelo, total do modelo, TTS), quais ferramentas e quantas fontes foram usadas,
e erros. Nada do conteúdo das mensagens é gravado.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

log = logging.getLogger("jarvis.metrics")


@dataclass
class RequestMetrics:
    conversation_id: int
    started: float = field(default_factory=time.perf_counter)
    search_ms: float | None = None
    llm_first_ms: float | None = None
    llm_total_ms: float | None = None
    tools: list[str] = field(default_factory=list)
    sources: int = 0
    route: str | None = None
    error: str | None = None

    def elapsed(self) -> float:
        return round((time.perf_counter() - self.started) * 1000, 1)

    def to_dict(self) -> dict:
        return {"conversation_id": self.conversation_id, "route": self.route, "search_ms": self.search_ms,
                "llm_first_ms": self.llm_first_ms, "llm_total_ms": self.llm_total_ms, "total_ms": self.elapsed(),
                "tools": self.tools, "sources": self.sources, "error": self.error}


class MetricsRecorder:
    def __init__(self, db):
        self.db = db

    def save(self, m: RequestMetrics) -> dict:
        d = m.to_dict()
        self.db.execute(
            "INSERT INTO metrics (conversation_id, route, search_ms, llm_first_ms, llm_total_ms, total_ms, tools, sources, error) VALUES (?,?,?,?,?,?,?,?,?)",
            (m.conversation_id, m.route, m.search_ms, m.llm_first_ms, m.llm_total_ms, d["total_ms"], json.dumps(m.tools), m.sources, m.error))
        log.info("métricas conv=%s rota=%s total=%sms busca=%s llm1=%s llm=%s ferramentas=%s fontes=%s erro=%s",
                 m.conversation_id, m.route, d["total_ms"], m.search_ms, m.llm_first_ms, m.llm_total_ms, m.tools, m.sources, m.error)
        return d

    def client_report(self, conversation_id: int, stt_ms: float | None = None, tts_ms: float | None = None) -> bool:
        """A interface informa os tempos de STT/TTS (medidos no navegador) da última resposta."""
        row = self.db.one("SELECT id FROM metrics WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", (conversation_id,))
        if not row:
            return False
        self.db.execute("UPDATE metrics SET stt_ms = COALESCE(?, stt_ms), tts_ms = COALESCE(?, tts_ms) WHERE id = ?", (stt_ms, tts_ms, row["id"]))
        return True

    def recent(self, limit: int = 30) -> list[dict]:
        rows = self.db.all("SELECT * FROM metrics ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["tools"] = json.loads(r["tools"] or "[]")
        return rows

    def summary(self) -> dict:
        r = self.db.one("SELECT COUNT(*) AS n, AVG(total_ms) AS total, AVG(llm_first_ms) AS first, AVG(search_ms) AS search, "
                        "AVG(stt_ms) AS stt, AVG(tts_ms) AS tts FROM (SELECT * FROM metrics ORDER BY id DESC LIMIT 50)")
        return {k: (round(v, 1) if isinstance(v, float) else v) for k, v in (r or {}).items()}
