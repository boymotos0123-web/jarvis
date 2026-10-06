"""Consulta de dispositivos (estado real vindo do DeviceManager)."""
from __future__ import annotations

import re

from tools import Tool, ToolResult

_ASK = re.compile(r"(?:quais|que)\s+dispositivos\s+(?:est[aã]o|tenho|eu\s+tenho|conectad)|dispositivos\s+conectados|status\s+dos\s+dispositivos"
                  r"|(?:axiom\s+band|smartphone|celular|[oó]culos)\s+(?:est[aá]|t[aá])\s+conectad", re.I)


class DevicesTool(Tool):
    name = "devices"
    description = "Lista os dispositivos do JARVIS e se estão realmente conectados."
    parameters = {}
    priority = 80

    def __init__(self, manager):
        self.manager = manager

    def match(self, text: str) -> dict | None:
        return {} if _ASK.search(text) else None

    def execute(self) -> ToolResult:
        items = self.manager.list()
        on = [d["name"] for d in items if d["status"] == "connected"]
        off = [d["name"] for d in items if d["status"] != "connected"]
        msg = f"Conectado: {', '.join(on) or 'nenhum'}."
        if off:
            msg += f"\nNão conectado (integração futura): {', '.join(off)}."
        return ToolResult(True, msg, {"devices": items})
