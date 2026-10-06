"""
Permissões e segurança.

Toda ferramenta declara um nível de risco. O modelo de IA NUNCA executa uma
ação MEDIUM/HIGH direto: o PermissionManager guarda a ação como pendente e o
JARVIS pergunta ao usuário. Só um "sim" explícito na mesma conversa executa.
"""
from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from core.memory import strip_accents


class Risk(str, Enum):
    LOW = "low"         # cálculos, consultas, leitura autorizada
    MEDIUM = "medium"   # criar/modificar arquivos, abrir programas
    HIGH = "high"       # excluir, alterar configurações, ações externas/destrutivas


class Decision(str, Enum):
    ALLOW = "allow"
    CONFIRM = "confirm"
    DENY = "deny"


@dataclass
class PendingAction:
    id: str
    conversation_id: int
    tool: str
    args: dict[str, Any]
    risk: Risk
    description: str
    created_at: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {"id": self.id, "tool": self.tool, "risk": self.risk.value, "description": self.description}


_YES = re.compile(r"^(sim|s|pode|pode sim|confirmo|confirmar|ok|claro|manda|faz|faca|yes|y|isso)\b")
_NO = re.compile(r"^(nao|n|cancela|cancelar|negativo|para|pare|no)\b")


class PermissionManager:
    TTL_SECONDS = 300  # uma confirmação vale por 5 minutos

    def __init__(self, policy: dict[Risk, Decision] | None = None, blocked_tools: set[str] | None = None, medium: str = "confirm"):
        # Baixo risco: automático. Alto risco: SEMPRE confirmação. Médio: configurável (PERMISSION_MEDIUM).
        self.policy = policy or {Risk.LOW: Decision.ALLOW,
                                 Risk.MEDIUM: Decision.ALLOW if medium == "allow" else Decision.CONFIRM,
                                 Risk.HIGH: Decision.CONFIRM}
        self.policy[Risk.HIGH] = Decision.CONFIRM if self.policy.get(Risk.HIGH) != Decision.DENY else Decision.DENY
        self.blocked_tools = blocked_tools or set()
        self._pending: dict[int, PendingAction] = {}

    def decide(self, tool: str, risk: Risk) -> Decision:
        if tool in self.blocked_tools:
            return Decision.DENY
        return self.policy.get(risk, Decision.CONFIRM)

    # ---------- confirmações ----------
    def request(self, conversation_id: int, tool: str, args: dict, risk: Risk, description: str) -> PendingAction:
        action = PendingAction(secrets.token_hex(4), conversation_id, tool, args, risk, description)
        self._pending[conversation_id] = action  # só uma pendência por conversa
        return action

    def pending(self, conversation_id: int) -> PendingAction | None:
        action = self._pending.get(conversation_id)
        if action and time.time() - action.created_at > self.TTL_SECONDS:
            self._pending.pop(conversation_id, None)
            return None
        return action

    def resolve(self, conversation_id: int, text: str) -> tuple[str, PendingAction | None]:
        """Retorna ('yes'|'no'|'none', ação). 'none' = a mensagem não responde à pendência."""
        action = self.pending(conversation_id)
        if not action:
            return "none", None
        t = strip_accents(text.lower()).strip(" .!?")
        if _YES.match(t):
            self._pending.pop(conversation_id, None)
            return "yes", action
        if _NO.match(t):
            self._pending.pop(conversation_id, None)
            return "no", action
        # mudou de assunto: a pendência é descartada por segurança
        self._pending.pop(conversation_id, None)
        return "none", action
