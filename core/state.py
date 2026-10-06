"""
Estado REAL do JARVIS.

Tudo que a interface mostra como ONLINE / CONECTADO vem daqui. Nada é marcado
como conectado sem que o módulo correspondente tenha confirmado.
"""
from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from enum import Enum


class Phase(str, Enum):
    """Fases que a interface mostra (◉ THINKING, ◉ SEARCHING...)."""
    IDLE = "IDLE"
    LISTENING = "LISTENING"            # o microfone fica no navegador; a interface informa esta fase
    THINKING = "THINKING"
    SEARCHING = "SEARCHING"
    READING = "READING"
    PROCESSING = "PROCESSING"
    SPEAKING = "SPEAKING"              # a voz também é tocada no navegador
    EXECUTING = "EXECUTING"
    WAITING_CONFIRMATION = "WAITING_CONFIRMATION"
    ERROR = "ERROR"


@dataclass
class ModelStatus:
    provider: str = "none"
    name: str = ""
    available: bool = False
    error: str | None = "Nenhum modelo configurado"
    checked_at: float = 0.0


@dataclass
class JarvisState:
    online: bool = False
    phase: Phase = Phase.IDLE
    started_at: float = field(default_factory=time.time)
    model: ModelStatus = field(default_factory=ModelStatus)
    processing: bool = False
    active_tool: str | None = None
    current_project: str = "jarvis"
    microphone: str = "not_connected"      # not_connected | connected
    speaker: str = "not_connected"
    camera: str = "not_connected"
    vision_model: str = "not_configured"

    def __post_init__(self):
        self._lock = threading.RLock()

    def update(self, **changes) -> None:
        with self._lock:
            for k, v in changes.items():
                if not hasattr(self, k):
                    raise AttributeError(f"estado desconhecido: {k}")
                setattr(self, k, v)

    def set_phase(self, phase: Phase, events=None, **info) -> None:
        """Muda a fase e avisa a interface (evento STATE_CHANGED)."""
        with self._lock:
            changed = self.phase != phase
            self.phase = phase
        if events is not None and (changed or info):
            from core.events import EventType
            events.emit(EventType.STATE_CHANGED, phase=phase.value, **info)

    def snapshot(self) -> dict:
        with self._lock:
            data = asdict(self)
        data["uptime_seconds"] = int(time.time() - self.started_at)
        return data
