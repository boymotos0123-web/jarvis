"""
Motor de gestos (FASE 9): MÃO → CÂMERA/SENSOR → GESTURE ENGINE → JARVIS → INTERFACE.
Previsto: hand tracking, finger tracking e gestos espaciais. Ainda não implementado.
"""
from __future__ import annotations


class GestureEngine:
    implemented = False

    def process(self, frame) -> list[dict]:
        raise NotImplementedError("Reconhecimento de gestos disponível futuramente (FASE 9).")

    def status(self) -> dict:
        return {"available": self.implemented, "note": "disponível futuramente (FASE 9)"}
