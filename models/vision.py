"""
Modelo de visão (FASE 6). Recebe um frame e devolve detecções.

Nenhum modelo está configurado ainda: `status()` diz isso com clareza e
`detect()` recusa em vez de inventar objetos.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class Detection:
    label: str
    confidence: float
    box: tuple[float, float, float, float]   # x, y, largura, altura (0..1)


class VisionModel(ABC):
    name = "none"

    @abstractmethod
    def detect(self, frame) -> list[Detection]: ...

    def status(self) -> dict:
        return {"model": self.name, "available": True}


class NoVisionModel(VisionModel):
    def detect(self, frame) -> list[Detection]:
        raise NotImplementedError("Modelo de visão não configurado (FASE 6).")

    def status(self) -> dict:
        return {"model": "none", "available": False, "note": "disponível futuramente (FASE 6)"}
