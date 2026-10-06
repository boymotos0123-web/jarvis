"""Rastreamento de objetos entre frames (FASE 6). Ainda não implementado."""
from __future__ import annotations

from models.vision import Detection


class ObjectTracker:
    implemented = False

    def update(self, detections: list[Detection]) -> list[dict]:
        raise NotImplementedError("Rastreamento disponível futuramente (FASE 6).")

    def status(self) -> dict:
        return {"available": self.implemented, "note": "disponível futuramente (FASE 6)"}
