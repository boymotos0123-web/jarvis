"""
Base de conhecimento local + grafo de conhecimento (SQLite).

- Entidades (Tony Stark, Mark III, Peter Parker...), fatos com metadados de
  canon (universo, fonte, época, confiança, status, última verificação) e
  relações (criou, usou, mentor de, evoluiu para...).
- `detect()` acha entidades citadas numa frase.
- `context_for()` monta o bloco de conhecimento para o modelo, SEPARADO por
  universo — nunca mistura MCU com quadrinhos.
- `connections(a, b)` encontra relações diretas e caminhos de 2 passos
  ("quais tecnologias do Tony o Peter usou?").

Novas bases (outros temas) entram com outro arquivo *_seed.json nesta pasta.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

from core.memory import strip_accents
from knowledge import universes as U

SEED_DIR = Path(__file__).resolve().parent

PREDICATES = {
    "created": ("criou", "foi criado por"),
    "used": ("usou", "foi usado por"),
    "identity_of": ("é a identidade de / atua como", "é a identidade de"),
    "member_of": ("é membro de", "tem como membro"),
    "worked_at": ("trabalhou em", "teve como integrante"),
    "mentor_of": ("é mentor de", "teve como mentor"),
    "evolved_into": ("evoluiu para", "veio de"),
    "part_of": ("faz parte de", "inclui"),
    "replaced": ("substituiu", "foi substituído por"),
    "ally_of": ("é aliado de", "é aliado de"),
    "enemy_of": ("é inimigo de", "é inimigo de"),
}


def _n(text: str) -> str:
    t = strip_accents(text.lower())
    t = re.sub(r"\.(?=\s|$)", " ", t)                 # ponto final de frase não faz parte do nome
    return " " + re.sub(r"[^a-z0-9.\- ]+", " ", t) + " "


class KnowledgeBase:
    def __init__(self, db):
        self.db = db
        self._aliases: list[tuple[str, str]] = []

    # ---------- carga ----------
    def load_seeds(self) -> int:
        """Carrega os *_seed.json — só quando o arquivo mudou (hash guardado em settings)."""
        n = 0
        for f in sorted(SEED_DIR.glob("*_seed.json")):
            raw = f.read_bytes()
            digest = hashlib.sha1(raw).hexdigest()
            key = f"kb_seed:{f.name}"
            row = self.db.one("SELECT value FROM settings WHERE key = ?", (key,))
            if row and row["value"] == digest:
                continue
            n += self.load_seed(json.loads(raw.decode("utf-8")))
            self.db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, digest))
        self._build_aliases()
        return n

    def load_seed(self, data: dict) -> int:
        """Idempotente: recarrega entidades, fatos e relações da semente."""
        slugs = [e["slug"] for e in data["entities"]]
        marks = ",".join("?" * len(slugs))
        st: list[tuple[str, tuple]] = [(f"DELETE FROM kb_facts WHERE entity IN ({marks})", tuple(slugs)),
                                       (f"DELETE FROM kb_relations WHERE subject IN ({marks})", tuple(slugs))]
        st += [("INSERT OR REPLACE INTO kb_entities (slug, name, type, aliases, summary) VALUES (?, ?, ?, ?, ?)",
                (e["slug"], e["name"], e["type"], json.dumps(e.get("aliases", []), ensure_ascii=False), e.get("summary", "")))
               for e in data["entities"]]
        st += [("INSERT INTO kb_facts (entity, fact, universe, source, era, continuity, confidence, canonical_status, last_verified) VALUES (?,?,?,?,?,?,?,?,?)",
                (f["entity"], f["fact"], f["universe"], f["source"], f.get("era"), f.get("continuity"), f.get("confidence", 0.8),
                 f.get("canonical_status", "canon"), f.get("last_verified")))
               for f in data.get("facts", [])]
        st += [("INSERT INTO kb_relations (subject, predicate, object, universe, source, confidence) VALUES (?,?,?,?,?,?)",
                (r["subject"], r["predicate"], r["object"], r["universe"], r["source"], r.get("confidence", 0.8)))
               for r in data.get("relations", [])]
        self.db.transaction(st)
        return len(slugs)

    def _build_aliases(self) -> None:
        pairs = []
        for e in self.db.all("SELECT slug, name, aliases FROM kb_entities"):
            for a in json.loads(e["aliases"]) + [e["name"], e["slug"]]:
                na = _n(a).strip()
                if len(na) >= 3:
                    pairs.append((na, e["slug"]))
        self._aliases = sorted(set(pairs), key=lambda p: -len(p[0]))   # o mais longo primeiro

    # ---------- consultas ----------
    def detect(self, text: str) -> list[str]:
        if not self._aliases:
            self._build_aliases()
        t = _n(re.sub(r"^\s*(ok[,\s]+)?jarvis[,!.\s]+", "", text, flags=re.I))   # "JARVIS," no início é vocativo
        found: dict[str, int] = {}
        for alias, slug in self._aliases:          # o alias mais longo vence ("homem de ferro" antes de "ferro")
            pos = t.find(f" {alias} ")
            if pos >= 0:
                t = t.replace(f" {alias} ", " " + " " * len(alias) + " ")   # apaga sem mudar as posições
                found[slug] = min(pos, found.get(slug, pos))
        return sorted(found, key=found.get)        # na ordem em que aparecem na frase

    def name(self, slug: str) -> str:
        row = self.db.one("SELECT name FROM kb_entities WHERE slug = ?", (slug,))
        return row["name"] if row else slug

    def entity(self, slug: str) -> dict | None:
        e = self.db.one("SELECT * FROM kb_entities WHERE slug = ?", (slug,))
        if not e:
            return None
        e["aliases"] = json.loads(e["aliases"])
        e["facts"] = self.facts([slug])
        e["relations"] = self.relations(slug)
        return e

    def facts(self, slugs: list[str], universes: list[str] | None = None) -> list[dict]:
        if not slugs:
            return []
        q = f"SELECT * FROM kb_facts WHERE entity IN ({','.join('?' * len(slugs))})"
        params: list = list(slugs)
        if universes:
            q += f" AND (universe IN ({','.join('?' * len(universes))}) OR universe = 'REAL_WORLD')"
            params += universes
        return self.db.all(q + " ORDER BY entity, universe, id", params)

    def relations(self, slug: str, universes: list[str] | None = None) -> list[dict]:
        rows = self.db.all(
            "SELECT r.*, s.name AS subject_name, o.name AS object_name FROM kb_relations r "
            "JOIN kb_entities s ON s.slug = r.subject JOIN kb_entities o ON o.slug = r.object "
            "WHERE r.subject = ? OR r.object = ?", (slug, slug))
        return [r for r in rows if not universes or r["universe"] in universes]

    def connections(self, a: str, b: str, universes: list[str] | None = None) -> list[dict]:
        """Relações diretas entre a e b + caminhos de 2 passos (a → X ← b, a → X → b...)."""
        out = []
        ra, rb = self.relations(a, universes), self.relations(b, universes)
        for r in ra:
            if b in (r["subject"], r["object"]):
                out.append({"path": [r], "via": None})
        other = lambda r, me: r["object"] if r["subject"] == me else r["subject"]   # noqa: E731
        by_mid_b = defaultdict(list)
        for r in rb:
            by_mid_b[(other(r, b), r["universe"])].append(r)
        for r in ra:
            mid = other(r, a)
            if mid in (a, b):
                continue
            for r2 in by_mid_b.get((mid, r["universe"]), []):
                out.append({"path": [r, r2], "via": mid})
        return out

    # ---------- texto para o modelo / resposta offline ----------
    @staticmethod
    def _rel_text(r: dict) -> str:
        verb = PREDICATES.get(r["predicate"], (r["predicate"],))[0]
        return f"{r['subject_name']} {verb} {r['object_name']}"

    def context_for(self, question: str, extra_slugs: list[str] | None = None) -> tuple[str, list[dict], list[str], list[str]]:
        """Retorna (bloco de texto, fontes, entidades, universos pedidos)."""
        slugs = self.detect(question)
        for s in extra_slugs or []:
            if s not in slugs:
                slugs.append(s)
        wanted = U.detect(question)
        if not slugs:
            return "", [], [], wanted
        facts = self.facts(slugs[:6], wanted or None)
        by_u: dict[str, list[dict]] = defaultdict(list)
        for f in facts:
            by_u[f["universe"]].append(f)
        names = {e["slug"]: e["name"] for e in self.db.all(f"SELECT slug, name FROM kb_entities WHERE slug IN ({','.join('?' * len(slugs))})", slugs)}
        lines = []
        for u in sorted(by_u, key=lambda x: list(U.UNIVERSES).index(x) if x in U.UNIVERSES else 99):
            lines.append(f"[{U.label(u)}]")
            for f in by_u[u]:
                flag = "" if f["confidence"] >= 0.9 else " (confiança média — verificar)"
                if f["canonical_status"] != "canon":
                    flag += f" (status: {f['canonical_status']})"
                lines.append(f"- {names.get(f['entity'], f['entity'])}: {f['fact']} [fonte: {f['source']}]{flag}")
        rels = []
        if len(slugs) >= 2:
            for c in self.connections(slugs[0], slugs[1], wanted or None)[:8]:
                rels.append(" → ".join(self._rel_text(r) for r in c["path"]) + f" [{U.label(c['path'][0]['universe'])}]")
        else:
            for r in self.relations(slugs[0], wanted or None)[:10]:
                rels.append(f"{self._rel_text(r)} [{U.label(r['universe'])}]")
        if rels:
            lines.append("[Relações do grafo]")
            lines += [f"- {x}" for x in rels]
        sources = []
        for f in facts:
            key = (f["source"], f["universe"])
            if key not in {(s["title"], s["universe"]) for s in sources}:
                sources.append({"title": f["source"], "url": "", "universe": f["universe"], "tier_label": "Base de conhecimento local",
                                "provider": "kb", "confidence": f["confidence"], "last_verified": f["last_verified"]})
        return "\n".join(lines), sources[:12], slugs, wanted

    def offline_answer(self, question: str, extra_slugs: list[str] | None = None) -> str | None:
        """Resposta sem modelo: os fatos organizados por universo."""
        block, _, slugs, wanted = self.context_for(question, extra_slugs)
        if not block:
            return None
        head = "Isto é o que tenho na base de conhecimento"
        if wanted:
            head += " (" + ", ".join(U.label(u) for u in wanted) + ")"
        return head + ", separado por universo:\n" + re.sub(r" \[fonte: [^\]]+\]", "", block)

    def stats(self) -> dict:
        return {
            "entities": self.db.one("SELECT COUNT(*) AS n FROM kb_entities")["n"],
            "facts": self.db.one("SELECT COUNT(*) AS n FROM kb_facts")["n"],
            "relations": self.db.one("SELECT COUNT(*) AS n FROM kb_relations")["n"],
            "universes": [r["universe"] for r in self.db.all("SELECT DISTINCT universe FROM kb_facts")],
        }
