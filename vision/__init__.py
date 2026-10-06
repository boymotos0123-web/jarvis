"""
Visão (FASE 6): CÂMERA → FRAME → MODELO → DETECÇÃO → TRACKING → CONTEXTO → JARVIS.

`VisionService` reúne câmera, detector, tracker e gestos e informa o estado
real. Sem câmera, `start()` recusa — nunca inventa detecções.
"""
from __future__ import annotations

from vision.detection import ObjectDetector
from vision.gestures import GestureEngine
from vision.tracking import ObjectTracker


class CameraNotConnected(Exception):
    pass


class VisionService:
    def __init__(self, detector: ObjectDetector | None = None):
        self.camera_connected = False
        self.detector = detector or ObjectDetector()
        self.tracker = ObjectTracker()
        self.gestures = GestureEngine()

    def status(self) -> dict:
        return {
            "camera": "connected" if self.camera_connected else "not_connected",
            "signal": "ok" if self.camera_connected else "SINAL ÓPTICO AUSENTE",
            "detector": self.detector.status(),
            "tracking": self.tracker.status(),
            "gestures": self.gestures.status(),
        }

    def start(self) -> dict:
        if not self.camera_connected:
            raise CameraNotConnected("Nenhuma câmera conectada ao JARVIS. A integração de câmera chega na FASE 6.")
        return self.status()
