"""Alto-falante. A reprodução acontece no navegador; o servidor gera o áudio (voz neural) quando disponível."""
from __future__ import annotations


class Speaker:
    def __init__(self):
        self.speaking = False    # atualizado pela interface

    def status(self) -> str:
        return "speaking" if self.speaking else "browser"
