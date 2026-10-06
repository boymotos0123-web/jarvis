"""
Texto → fala.

- EdgeTTS: vozes neurais (pt-BR-AntonioNeural, pt-BR-FranciscaNeural...) via o
  pacote `edge-tts` (gratuito, precisa de internet). Aplica ritmo e entonação
  por frase (voice/prosody.py). É uma voz sintética comum — nenhuma voz de ator.
- Sem o pacote (ou sem internet), a interface usa a voz do navegador.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod


class TTSUnavailable(Exception):
    pass


class TextToSpeech(ABC):
    name = "none"

    @abstractmethod
    async def synthesize(self, text: str, rate: int = 0, pitch: int = 0) -> bytes: ...

    def status(self) -> dict:
        return {"engine": self.name, "available": True}


class NoTextToSpeech(TextToSpeech):
    async def synthesize(self, text: str, rate: int = 0, pitch: int = 0) -> bytes:
        raise TTSUnavailable("Voz do servidor não configurada — a interface usa a voz do navegador.")

    def status(self) -> dict:
        return {"engine": "browser", "available": False, "note": "a interface usa a voz do navegador (instale edge-tts para voz neural)"}


class EdgeTTS(TextToSpeech):
    name = "edge-tts"

    def __init__(self, voice: str = "pt-BR-AntonioNeural"):
        import edge_tts  # noqa: F401  (falha cedo se não estiver instalado)
        self.voice = voice
        self.last_ms = 0.0

    async def synthesize(self, text: str, rate: int = 0, pitch: int = 0) -> bytes:
        import edge_tts
        t0 = time.perf_counter()
        comm = edge_tts.Communicate(text, self.voice, rate=f"{rate:+d}%", pitch=f"{pitch:+d}Hz")
        audio = bytearray()
        try:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    audio.extend(chunk["data"])
        except Exception as e:   # sem internet / serviço fora
            raise TTSUnavailable(f"Voz neural indisponível agora ({e.__class__.__name__}).")
        self.last_ms = (time.perf_counter() - t0) * 1000
        if not audio:
            raise TTSUnavailable("A voz neural não devolveu áudio.")
        return bytes(audio)

    def status(self) -> dict:
        return {"engine": self.name, "voice": self.voice, "available": True}


def create_tts(provider: str, voice: str) -> TextToSpeech:
    if provider in ("edge", "edge-tts", "auto"):
        try:
            return EdgeTTS(voice)
        except ImportError:
            return NoTextToSpeech()
    return NoTextToSpeech()
