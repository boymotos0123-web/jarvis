"""
VOICE ENGINE

MICROFONE → DETECÇÃO DE VOZ (VAD) → FALA→TEXTO → CONVERSATION ENGINE → BRAIN → LLM (streaming)
→ PROSÓDIA (frases + estilo) → TEXTO→FALA → ÁUDIO

Captura e reprodução acontecem no navegador (é onde estão o microfone e o
alto-falante do usuário). O servidor oferece: voz neural (/api/voice/tts),
Whisper opcional (/api/voice/stt) e o plano de prosódia.
Interrupções (barge-in): parar, continuar, cancelar e reformular são tratadas
na interface (áudio) e no Conversation Engine (texto).
"""
from __future__ import annotations

from models.speech_to_text import SpeechToText, create_stt
from models.text_to_speech import TextToSpeech, create_tts
from voice.microphone import Microphone
from voice.speaker import Speaker


class VoiceService:
    def __init__(self, stt: SpeechToText | None = None, tts: TextToSpeech | None = None,
                 stt_provider: str = "browser", tts_provider: str = "edge", tts_voice: str = "pt-BR-AntonioNeural",
                 whisper_model: str = "small"):
        self.microphone = Microphone()
        self.speaker = Speaker()
        self.stt = stt or create_stt(stt_provider, whisper_model)
        self.tts = tts or create_tts(tts_provider, tts_voice)

    def status(self) -> dict:
        return {
            "microphone": self.microphone.status(),
            "speaker": self.speaker.status(),
            "speech_to_text": self.stt.status(),
            "text_to_speech": self.tts.status(),
            "ready": True,
            "capture": "navegador",
        }
