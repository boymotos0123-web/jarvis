"""
Roteador de capacidades.

Decide, para cada mensagem, se ela vai direto para uma ferramenta ou para o
modelo de IA. Cada ferramenta declara seus próprios padrões (`Tool.match`);
o Router só percorre as ferramentas em ordem de prioridade — sem uma cadeia
gigante de if/else espalhada pelo sistema.

Também interpreta pedidos de ferramenta feitos pelo modelo, no formato:
    TOOL_CALL {"tool": "calculator", "args": {"expression": "2+2"}}
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tools import ToolRegistry

log = logging.getLogger("jarvis.router")

TOOL_CALL_RE = re.compile(r"TOOL_CALL\s*(\{.*\})", re.S)


@dataclass
class Route:
    kind: str                      # "tool" | "llm"
    tool: str | None = None
    args: dict = field(default_factory=dict)


class Router:
    def __init__(self, registry: "ToolRegistry"):
        self.registry = registry

    def route(self, text: str) -> Route:
        for tool in self.registry.all():
            try:
                args = tool.match(text)
            except Exception:
                log.exception("match da ferramenta %s falhou", tool.name)
                continue
            if args is not None:
                log.info("rota: ferramenta %s", tool.name)
                return Route("tool", tool.name, args)
        log.info("rota: modelo de IA")
        return Route("llm")

    @staticmethod
    def parse_tool_request(text: str) -> tuple[str, dict] | None:
        m = TOOL_CALL_RE.search(text or "")
        if not m:
            return None
        raw = m.group(1)
        # o modelo às vezes escreve texto depois do JSON: corta no último '}' que fecha
        for end in range(len(raw), 0, -1):
            if raw[end - 1] != "}":
                continue
            try:
                obj = json.loads(raw[:end])
                break
            except json.JSONDecodeError:
                continue
        else:
            return None
        name = obj.get("tool") or obj.get("name")
        args = obj.get("args") or obj.get("arguments") or {}
        if not isinstance(name, str) or not isinstance(args, dict):
            return None
        return name, args
