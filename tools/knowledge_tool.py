"""
Conhecimento estruturado (base local + grafo), com separação de universos.
Responde perguntas como "quem é Tony Stark?", "qual armadura apareceu primeiro
no MCU?", "qual a relação dele com o Homem-Aranha?".
"""
from __future__ import annotations

import re

from core.memory import strip_accents
from tools import Tool, ToolResult

_ASK = re.compile(r"^(?:jarvis[,\s]+)?(?:quem|o\s+que|qual|quais|quando|como|onde|por\s*que|me\s+(?:fala|fale|conta|conte|explica|explique)|explica|explique|"
                  r"compare|compara|diferen[cç]a|rela[cç][aã]o|existe|existem)|\?$|\b(criou|criado|inventou|apareceu|primeir[oa]|vers[aã]o|vers[oõ]es|universo|mcu|quadrinhos)\b", re.I)

INSTRUCTIONS = ("Responda com base no CONHECIMENTO abaixo. Ele está separado por universo: NÃO misture universos — "
                "se a pergunta não especificar, diga como é em cada um (ex.: 'No MCU... Nos quadrinhos...'). "
                "Fatos marcados como 'verificar' devem ser apresentados com cautela. Se o conhecimento não responder, "
                "diga que não tem informação suficiente (pode usar o que você sabe, deixando claro que é conhecimento geral do modelo).")


class KnowledgeTool(Tool):
    name = "knowledge"
    description = ("Base de conhecimento local (Tony Stark, Homem de Ferro e armaduras, J.A.R.V.I.S., Vingadores, Homem-Aranha, "
                   "lançadores de teia...) com fatos separados por universo (MCU, quadrinhos, SSU, animação, jogos) e grafo de relações.")
    parameters = {"question": {"type": "string", "required": True, "description": "a pergunta"},
                  "entities": {"type": "string", "description": "slugs extras separados por vírgula (contexto da conversa)"}}
    priority = 40

    def __init__(self, engine):
        self.engine = engine

    def match(self, text: str) -> dict | None:
        if self.engine.needs_current_info(text):
            return None   # informação atual → pesquisa web
        if self.engine.kb.detect(text) and _ASK.search(strip_accents(text.strip())):
            return {"question": text}
        return None

    def execute(self, question: str, entities: str = "") -> ToolResult:
        extra = [e.strip() for e in entities.split(",") if e.strip()]
        block, sources, slugs, wanted = self.engine.kb.context_for(question, extra)
        if not block:
            return ToolResult.fail("KNOWLEDGE_NOT_FOUND", "Não tenho esse assunto na base de conhecimento.")
        return ToolResult(True, self.engine.kb.offline_answer(question, extra) or block,
                          {"knowledge": block, "sources": sources, "entities": slugs, "universes": wanted,
                           "instructions": INSTRUCTIONS, "topic": self.engine.kb.name(slugs[0]) if slugs else None},
                          summarize=True)
