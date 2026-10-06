"""
Arquivos autorizados.

O JARVIS só enxerga a pasta de trabalho (WORKSPACE_DIR, padrão: ./workspace).
Qualquer caminho que tente sair dela (ex.: ..\\..\\Windows) é recusado.
Ler/listar/buscar = risco baixo. Criar/editar = risco médio (pede confirmação).
"""
from __future__ import annotations

import re
from pathlib import Path

from core.permissions import Risk
from tools import Tool, ToolError, ToolResult

MAX_READ = 20_000        # caracteres devolvidos ao ler
MAX_WRITE = 200_000
TEXT_EXT = {".txt", ".md", ".json", ".csv", ".py", ".js", ".html", ".css", ".log", ".yaml", ".yml", ".ini", ".toml", ".xml"}

_READ = re.compile(r"^(?:jarvis[,\s]+)?(?:leia|ler|l[eê]|abra|abrir|mostre|mostra|exiba)\s+(?:o\s+|meu\s+|o\s+meu\s+)?arquivo\s+[\"'“]?([^\"'”]+?)[\"'”]?\s*[.!?]*$", re.I)
_LIST = re.compile(r"(?:liste|listar|mostre|mostra|quais\s+s[aã]o)\s+(?:os\s+)?(?:meus\s+)?arquivos", re.I)
_SEARCH = re.compile(r"(?:procure|busque|pesquise|encontre)\s+(?:por\s+)?[\"'“]?(.+?)[\"'”]?\s+n(?:os|o)\s+(?:meus\s+)?arquivos", re.I)


class FilesTool(Tool):
    name = "files"
    description = "Lista, lê, busca e cria arquivos de texto dentro da pasta de trabalho autorizada."
    parameters = {
        "action": {"type": "string", "required": True, "enum": ["list", "read", "search", "write"]},
        "path": {"type": "string", "description": "caminho relativo à pasta de trabalho", "default": "."},
        "query": {"type": "string", "description": "texto a procurar (search)"},
        "content": {"type": "string", "description": "conteúdo do arquivo (write)"},
    }
    priority = 30

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def safe_path(self, rel: str) -> Path:
        p = (self.root / (rel or ".")).resolve()
        if p != self.root and self.root not in p.parents:
            raise ToolError("PATH_NOT_ALLOWED", "Esse caminho está fora da pasta autorizada do JARVIS.")
        return p

    def match(self, text: str) -> dict | None:
        if (m := _SEARCH.search(text)):
            return {"action": "search", "query": m.group(1)}
        if (m := _READ.match(text.strip())):
            return {"action": "read", "path": m.group(1).strip()}
        if _LIST.search(text):
            return {"action": "list", "path": "."}
        return None

    def risk_for(self, args: dict) -> Risk:
        """Criar arquivo novo = baixo risco; SOBRESCREVER um existente = alto (irreversível)."""
        if args.get("action") != "write":
            return Risk.LOW
        try:
            return Risk.HIGH if self.safe_path(args.get("path", "")).exists() else Risk.LOW
        except ToolError:
            return Risk.HIGH

    def describe(self, args: dict) -> str:
        if args.get("action") == "write":
            exists = self.safe_path(args.get("path", "")).exists()
            return f"{'sobrescrever' if exists else 'criar'} o arquivo “{args.get('path')}” na pasta de trabalho"
        return super().describe(args)

    def _rel(self, p: Path) -> str:
        return str(p.relative_to(self.root)).replace("\\", "/") or "."

    def execute(self, action: str, path: str = ".", query: str = "", content: str = "") -> ToolResult:
        if action == "list":
            d = self.safe_path(path)
            if not d.is_dir():
                return ToolResult.fail("NOT_A_DIRECTORY", f"“{path}” não é uma pasta.")
            entries = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
            items = [{"name": e.name, "type": "dir" if e.is_dir() else "file", "size": e.stat().st_size if e.is_file() else None} for e in entries]
            if not items:
                return ToolResult(True, "A pasta de trabalho está vazia.", {"items": []})
            lines = "\n".join(f"• {i['name']}{'/' if i['type'] == 'dir' else ''}" for i in items[:50])
            return ToolResult(True, f"Arquivos em {self._rel(d)}:\n{lines}", {"items": items})

        if action == "read":
            f = self.safe_path(path)
            if not f.is_file():
                return ToolResult.fail("FILE_NOT_FOUND", f"Não encontrei “{path}” na pasta de trabalho ({self.root}).")
            if f.suffix.lower() not in TEXT_EXT:
                return ToolResult.fail("UNSUPPORTED_FILE", "Por enquanto só leio arquivos de texto.")
            text = f.read_text(encoding="utf-8", errors="replace")
            cut = text[:MAX_READ]
            note = "\n…(arquivo cortado)" if len(text) > MAX_READ else ""
            preview = cut[:1500] + ("\n…" if len(cut) > 1500 else "")
            return ToolResult(True, f"Conteúdo de {self._rel(f)}:\n\n{preview}", {"path": self._rel(f), "content": cut + note, "chars": len(text)}, summarize=True)

        if action == "search":
            if not query:
                raise ToolError("INVALID_ARGS", "Informe o que procurar.")
            q = query.lower()
            hits = []
            for f in self.root.rglob("*"):
                if not f.is_file() or f.suffix.lower() not in TEXT_EXT:
                    continue
                if q in f.name.lower():
                    hits.append({"path": self._rel(f), "line": None, "text": "(nome do arquivo)"})
                try:
                    for i, line in enumerate(f.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                        if q in line.lower():
                            hits.append({"path": self._rel(f), "line": i, "text": line.strip()[:160]})
                            if len(hits) >= 30:
                                break
                except OSError:
                    continue
                if len(hits) >= 30:
                    break
            if not hits:
                return ToolResult(True, f"Nada encontrado para “{query}” nos arquivos.", {"hits": []})
            lines = "\n".join(f"• {h['path']}{':' + str(h['line']) if h['line'] else ''} — {h['text']}" for h in hits[:10])
            return ToolResult(True, f"Encontrei {len(hits)} ocorrência(s):\n{lines}", {"hits": hits})

        if action == "write":
            if len(content) > MAX_WRITE:
                raise ToolError("CONTENT_TOO_LARGE", "Conteúdo grande demais.")
            f = self.safe_path(path)
            if f.suffix.lower() not in TEXT_EXT:
                raise ToolError("UNSUPPORTED_FILE", "Só crio arquivos de texto (.txt, .md, .py, ...).")
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(content, encoding="utf-8")
            return ToolResult(True, f"Arquivo salvo: {self._rel(f)} ({len(content)} caracteres).", {"path": self._rel(f)})

        raise ToolError("INVALID_ARGS", f"Ação desconhecida: {action}")
