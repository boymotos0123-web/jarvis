"""Câmera: informa o estado real do módulo de visão. Sem câmera = sem detecções."""
from __future__ import annotations

import re

from tools import Tool, ToolResult

_ASK = re.compile(r"c[aâ]mera\s+(?:est[aá]|t[aá])\s+(?:ligad|conectad|funcionand)|status\s+da\s+c[aâ]mera"
                  r"|o\s+que\s+(?:voc[eê]|vc)\s+(?:est[aá]\s+)?vendo|analis[ae]\s+(?:essa|esta|a)\s+imagem", re.I)


class CameraTool(Tool):
    name = "camera"
    description = "Informa se a câmera/visão está disponível."
    parameters = {}
    priority = 85

    def __init__(self, vision):
        self.vision = vision

    def match(self, text: str) -> dict | None:
        return {} if _ASK.search(text) else None

    def execute(self) -> ToolResult:
        s = self.vision.status()
        if s["camera"] != "connected":
            return ToolResult(True, "Sinal óptico ausente: nenhuma câmera está conectada ao JARVIS ainda. "
                                    "A visão computacional entra na FASE 6.", {"vision": s})
        return ToolResult(True, "Câmera conectada.", {"vision": s})
