"""Detecção de objetos sobre frames da câmera (FASE 6). Usa um VisionModel."""
from __future__ import annotations

from models.vision import Detection, NoVisionModel, VisionModel


class ObjectDetector:
    def __init__(self, model: VisionModel | None = None):
        self.model = model or NoVisionModel()

    def detect(self, frame) -> list[Detection]:
        return self.model.detect(frame)

    def status(self) -> dict:
        return self.model.status()
