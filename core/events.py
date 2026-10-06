"""
Sistema de eventos (publish/subscribe) do JARVIS.

Qualquer módulo pode emitir um evento; a interface recebe os eventos ao vivo
pelo endpoint SSE /api/events/stream. Os eventos também ficam gravados na
tabela `events` (sem conteúdo de mensagens) para o log do sistema.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections import deque
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable

log = logging.getLogger("jarvis.events")


class EventType(str, Enum):
    JARVIS_READY = "JARVIS_READY"
    MESSAGE_RECEIVED = "MESSAGE_RECEIVED"
    AI_THINKING = "AI_THINKING"
    AI_RESPONSE = "AI_RESPONSE"
    AI_ERROR = "AI_ERROR"
    MEMORY_UPDATED = "MEMORY_UPDATED"
    TOOL_STARTED = "TOOL_STARTED"
    TOOL_FINISHED = "TOOL_FINISHED"
    CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED"
    PROJECT_UPDATED = "PROJECT_UPDATED"
    DEVICE_CONNECTED = "DEVICE_CONNECTED"
    DEVICE_DISCONNECTED = "DEVICE_DISCONNECTED"
    VISION_DETECTION = "VISION_DETECTION"
    VOICE_STARTED = "VOICE_STARTED"
    VOICE_FINISHED = "VOICE_FINISHED"
    MODEL_STATUS = "MODEL_STATUS"
    STATE_CHANGED = "STATE_CHANGED"          # fase atual: IDLE, THINKING, SEARCHING...
    SEARCH_STARTED = "SEARCH_STARTED"
    SEARCH_FINISHED = "SEARCH_FINISHED"
    STEP_STARTED = "STEP_STARTED"            # tarefas de várias etapas
    GENERATION_CANCELLED = "GENERATION_CANCELLED"
    METRICS = "METRICS"


# eventos frequentes demais para ir ao banco
_NOT_PERSISTED = {EventType.AI_THINKING, EventType.STATE_CHANGED}

Listener = Callable[[dict], None]


class EventBus:
    def __init__(self, db=None, history: int = 200):
        self._db = db
        self._listeners: list[Listener] = []
        self._queues: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._recent: deque[dict] = deque(maxlen=history)
        self._lock = threading.Lock()

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def emit(self, type_: EventType, **payload: Any) -> dict:
        event = {
            "type": type_.value,
            "payload": payload,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            self._recent.append(event)
            queues = list(self._queues)
        if self._db is not None and type_ not in _NOT_PERSISTED:
            try:
                self._db.execute("INSERT INTO events (type, payload) VALUES (?, ?)",
                                 (type_.value, json.dumps(payload, ensure_ascii=False, default=str)))
            except Exception:  # o log de eventos nunca derruba o sistema
                log.exception("falha ao gravar evento %s", type_.value)
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception:
                log.exception("listener de evento falhou")
        for loop, q in queues:
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except RuntimeError:
                pass  # loop encerrado
        log.debug("evento %s %s", type_.value, payload)
        return event

    def recent(self, limit: int = 50) -> list[dict]:
        with self._lock:
            return list(self._recent)[-limit:]

    # ---------- streaming (SSE) ----------
    def open_queue(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        with self._lock:
            self._queues.add((asyncio.get_running_loop(), q))
        return q

    def close_queue(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._queues = {item for item in self._queues if item[1] is not q}
