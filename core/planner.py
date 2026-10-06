"""
Tarefas de várias etapas (com limite).

"Pesquise o assunto, compare as opções e me dê a melhor."
→ o modelo monta um plano curto (até 5 etapas) usando SÓ ferramentas existentes
→ cada etapa passa pelas permissões (ação de risco alto interrompe o plano e pede confirmação)
→ os resultados vão para uma síntese final.

Não é automação ilimitada: não há loops, nem etapas inventadas fora do catálogo.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from core.memory import strip_accents
from models.llm import LLMError, Message

MAX_STEPS = 5
_VERBS = re.compile(r"\b(pesquis|procur|busc|compar|resum|analis|escolh|list|calcul|avali|organiz|recomend|verifiqu|cri[ae]|escrev|salv)\w*")


@dataclass
class Step:
    tool: str
    args: dict = field(default_factory=dict)
    goal: str = ""


def is_multistep(text: str) -> bool:
    t = strip_accents(text.lower())
    verbs = {m.group(1) for m in _VERBS.finditer(t)}
    return len(verbs) >= 2 and bool(re.search(r",|\be\b|\bdepois\b|\bentao\b|\bem seguida\b", t))


async def make_plan(llm, text: str, catalog: str, allowed: set[str]) -> list[Step]:
    prompt = (
        "Monte um plano curto para atender o pedido abaixo usando SOMENTE estas ferramentas:\n"
        f"{catalog}\n\n"
        "Responda SOMENTE com um array JSON de até 5 etapas no formato "
        '[{"tool": "<nome>", "args": {...}, "goal": "<objetivo curto>"}]. '
        "Não inclua a etapa final de resposta: ela é automática. Se nenhuma ferramenta for necessária, responda [].\n\n"
        f"PEDIDO: {text}"
    )
    try:
        raw = await llm.chat([Message("user", prompt)])
        m = re.search(r"\[.*\]", raw, re.S)
        items = json.loads(m.group(0)) if m else []
    except (LLMError, ValueError, json.JSONDecodeError):
        return []
    steps = []
    for it in items[:MAX_STEPS]:
        if isinstance(it, dict) and it.get("tool") in allowed and isinstance(it.get("args", {}), dict):
            steps.append(Step(it["tool"], it.get("args", {}), str(it.get("goal", ""))[:120]))
    return steps
