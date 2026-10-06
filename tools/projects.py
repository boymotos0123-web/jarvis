"""
Projetos do usuário (tabela `projects` + `project_milestones`).

Por enquanto existe apenas o projeto JARVIS. Novos projetos são novas linhas
no banco — nada aqui limita a quantidade.
"""
from __future__ import annotations

import json
import re

from core.memory import strip_accents
from tools import Tool, ToolError, ToolResult

_LIST = re.compile(r"(?:quais\s+(?:s[aã]o\s+)?(?:os\s+)?meus\s+projetos|(?:liste|mostre|mostra)\s+(?:os\s+)?(?:meus\s+)?projetos)", re.I)
_STATUS = re.compile(r"(?:status|progresso|andamento)\s+(?:do|da)\s+(?:projeto\s+)?([\w\- ]+?)\s*\??$", re.I)
STATUSES = ("pending", "in_progress", "done")


class ProjectsTool(Tool):
    name = "projects"
    description = "Consulta os projetos do usuário, seus marcos e progresso."
    parameters = {
        "action": {"type": "string", "required": True, "enum": ["list", "get", "current"]},
        "slug": {"type": "string", "description": "identificador do projeto (ex.: jarvis)"},
    }
    priority = 15   # antes da memória: "quais são meus projetos" é consulta de projetos

    def __init__(self, db):
        self.db = db

    # ---------- dados (também usados pela API) ----------
    def _milestones(self, project_id: int) -> list[dict]:
        return self.db.all("SELECT id, position, title, status FROM project_milestones WHERE project_id = ? ORDER BY position", (project_id,))

    def _shape(self, row: dict, with_milestones: bool) -> dict:
        ms = self._milestones(row["id"])
        done = sum(1 for m in ms if m["status"] == "done") + 0.5 * sum(1 for m in ms if m["status"] == "in_progress")
        data = {
            "slug": row["slug"], "code": row["code"], "name": row["name"], "subtitle": row["subtitle"],
            "status": row["status"], "description": row["description"], "tags": json.loads(row["tags"] or "[]"),
            "progress": round(100 * done / len(ms)) if ms else 0,
        }
        if with_milestones:
            data["milestones"] = ms
        return data

    def list_projects(self) -> list[dict]:
        rows = self.db.all("SELECT * FROM projects WHERE visible = 1 ORDER BY id")
        return [self._shape(r, False) for r in rows]

    def get_project(self, slug: str) -> dict | None:
        row = self.db.one("SELECT * FROM projects WHERE slug = ? AND visible = 1", (slug.lower().strip(),))
        return self._shape(row, True) if row else None

    def current_slug(self) -> str:
        r = self.db.one("SELECT value FROM settings WHERE key = 'current_project'")
        return r["value"] if r else "jarvis"

    def set_milestone(self, slug: str, milestone_id: int, status: str) -> dict:
        if status not in STATUSES:
            raise ToolError("INVALID_ARGS", f"status deve ser um de: {', '.join(STATUSES)}")
        proj = self.db.one("SELECT id FROM projects WHERE slug = ?", (slug,))
        if not proj:
            raise ToolError("PROJECT_NOT_FOUND", f"Projeto '{slug}' não encontrado.")
        cur = self.db.execute("UPDATE project_milestones SET status = ? WHERE id = ? AND project_id = ?", (status, milestone_id, proj["id"]))
        if cur.rowcount == 0:
            raise ToolError("MILESTONE_NOT_FOUND", "Marco não encontrado.")
        return self.get_project(slug)  # type: ignore[return-value]

    # ---------- ferramenta ----------
    def match(self, text: str) -> dict | None:
        if _LIST.search(text):
            return {"action": "list"}
        if (m := _STATUS.search(text)):
            return {"action": "get", "slug": strip_accents(m.group(1).lower()).strip().replace(" ", "-")}
        return None

    def execute(self, action: str, slug: str = "") -> ToolResult:
        if action == "list":
            items = self.list_projects()
            lines = "\n".join(f"• {p['name']} — {p['status']} ({p['progress']}%)" for p in items)
            return ToolResult(True, f"Projetos ativos:\n{lines}" if items else "Nenhum projeto cadastrado.", {"projects": items})
        if action in ("get", "current"):
            target = slug or self.current_slug()
            p = self.get_project(target)
            if not p:
                return ToolResult.fail("PROJECT_NOT_FOUND", f"Não encontrei o projeto “{target}”.")
            done = [m["title"] for m in p["milestones"] if m["status"] == "done"]
            doing = [m["title"] for m in p["milestones"] if m["status"] == "in_progress"]
            msg = f"{p['name']} — {p['status']}, {p['progress']}% concluído."
            if doing:
                msg += f"\nEm andamento: {', '.join(doing)}."
            if done:
                msg += f"\nConcluído: {', '.join(done)}."
            return ToolResult(True, msg, {"project": p})
        raise ToolError("INVALID_ARGS", f"Ação desconhecida: {action}")
