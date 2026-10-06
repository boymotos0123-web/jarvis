"""
Microfone. A captura acontece no navegador (permissão do próprio navegador).
O servidor só sabe se a interface informou que o microfone está ativo.
"""
from __future__ import annotations


class Microphone:
    def __init__(self):
        self.active = False      # atualizado pela interface (/api/voice/state)

    def status(self) -> str:
        return "active" if self.active else "browser"
