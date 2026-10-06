"""
Navegador (FASE 7 — base). Por enquanto: abrir um site no navegador padrão,
com confirmação. Automação de páginas fica para depois.
"""
from __future__ import annotations

import re
import webbrowser
from urllib.parse import urlparse

from core.permissions import Risk
from tools import Tool, ToolError, ToolResult

_OPEN = re.compile(r"^(?:jarvis[,\s]+)?(?:abr[ae]|abrir|acesse|acessar|entre\s+(?:no|em)|v[aá]\s+para|ir\s+para)\s+(?:o\s+site\s+|a\s+p[aá]gina\s+|o\s+)?((?:https?://)?[\w\-]+(?:\.[\w\-]+)+(?:/\S*)?)\s*[.!]*$", re.I)


class BrowserTool(Tool):
    name = "browser"
    description = "Abre um endereço (http/https) no navegador padrão do computador."
    parameters = {"url": {"type": "string", "required": True, "description": "endereço do site"}}
    risk = Risk.LOW          # abrir uma página é baixo risco (fase 3)
    priority = 65

    @staticmethod
    def normalize(url: str) -> str:
        url = url.strip()
        if not re.match(r"^https?://", url, re.I):
            url = "https://" + url
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ToolError("INVALID_URL", "Endereço inválido.")
        return url

    def match(self, text: str) -> dict | None:
        if (m := _OPEN.match(text.strip())):
            return {"url": m.group(1)}
        return None

    def describe(self, args: dict) -> str:
        return f"abrir {self.normalize(args.get('url', ''))} no navegador"

    def execute(self, url: str) -> ToolResult:
        url = self.normalize(url)
        if not webbrowser.open(url, new=2):
            return ToolResult.fail("BROWSER_UNAVAILABLE", "Não consegui abrir o navegador neste computador.")
        return ToolResult(True, f"Abrindo {url}.", {"url": url})
