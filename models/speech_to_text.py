"""
Fala → texto.

- Padrão: o reconhecimento de fala do NAVEGADOR (Chrome/Edge). Roda na
  interface; o servidor só recebe o texto. A interface avisa o usuário de que
  o áudio é processado pelo serviço de fala do navegador.
- Opcional, local: Whisper via `faster-whisper` (pip install faster-whisper).
  A interface grava trechos com detecção de voz (VAD) e envia para /api/voice/stt.
"""
from __future__ import annotations

import os
import tempfile
import time
from abc import ABC, abstractmethod


class SpeechToText(ABC):
    name = "none"

    @abstractmethod
    def transcribe(self, audio: bytes, language: str = "pt") -> str: ...

    def status(self) -> dict:
        return {"engine": self.name, "available": True}


class BrowserSpeechToText(SpeechToText):
    """Marcador: o reconhecimento acontece no navegador."""
    name = "browser"

    def transcribe(self, audio: bytes, language: str = "pt") -> str:
        raise NotImplementedError("No modo 'browser' a transcrição acontece no navegador.")

    def status(self) -> dict:
        return {"engine": "browser", "available": True, "note": "reconhecimento de fala do navegador (Chrome/Edge)"}


class WhisperSpeechToText(SpeechToText):
    name = "whisper"

    def __init__(self, model_size: str = "small"):
        from faster_whisper import WhisperModel   # pesado: só carrega se configurado
        self.model = WhisperModel(model_size, device="auto", compute_type="int8")
        self.model_size = model_size
        self.last_ms = 0.0

    def transcribe(self, audio: bytes, language: str = "pt") -> str:
        t0 = time.perf_counter()
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
            f.write(audio)
            path = f.name
        try:
            segments, _ = self.model.transcribe(path, language=language, vad_filter=True)
            text = " ".join(s.text.strip() for s in segments).strip()
        finally:
            os.unlink(path)
        self.last_ms = (time.perf_counter() - t0) * 1000
        return text

    def status(self) -> dict:
        return {"engine": "whisper", "model": self.model_size, "available": True}


def create_stt(provider: str, model_size: str) -> SpeechToText:
    if provider == "whisper":
        try:
            return WhisperSpeechToText(model_size)
        except ImportError:
            return BrowserSpeechToText()
    return BrowserSpeechToText()
