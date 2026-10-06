"""
DEEP RESEARCH — pesquisa em profundidade.

PERGUNTA → DECOMPOSIÇÃO → BUSCA (paralela, várias fontes) → LEITURA → COMPARAÇÃO
→ VALIDAÇÃO (ranking + conflitos) → SÍNTESE → RESPOSTA COM FONTES

Sem modelo de IA, devolve as fontes encontradas e avisa que não pode sintetizar.
"""
from __future__ import annotations

import asyncio
import json
import re
import time

from knowledge.ranking import detect_conflicts, rank
from models.llm import LLMError, Message

MAX_SUBQUESTIONS = 4
MAX_READ = 4


async def decompose(llm, question: str) -> list[str]:
    prompt = ("Divida a pergunta abaixo em 2 a 4 subperguntas de pesquisa curtas e independentes, que juntas cobrem o assunto. "
              "Responda SOMENTE com um array JSON de strings.\n\nPergunta: " + question)
    try:
        raw = await llm.chat([Message("user", prompt)])
        m = re.search(r"\[.*\]", raw, re.S)
        items = json.loads(m.group(0)) if m else []
        subs = [str(x).strip() for x in items if str(x).strip()][:MAX_SUBQUESTIONS]
        return subs or [question]
    except (LLMError, ValueError, json.JSONDecodeError):
        return [question]


class DeepResearch:
    def __init__(self, engine, llm_getter, on_phase=None):
        self.engine = engine
        self.llm_getter = llm_getter          # função que devolve o provedor atual (pode mudar no restart)
        self.on_phase = on_phase or (lambda *a, **k: None)

    async def run(self, question: str, model_available: bool) -> dict:
        t0 = time.perf_counter()
        llm = self.llm_getter()
        subs = await decompose(llm, question) if model_available else [question]
        self.on_phase("SEARCHING", detail=f"{len(subs)} frente(s) de pesquisa")
        reports = await asyncio.gather(*(self.engine.search(q, limit=6) for q in subs))
        pool = [r for rep in reports for r in rep.results]
        errors = sorted({e for rep in reports for e in rep.errors})
        ranked = rank(pool, limit=8)
        self.on_phase("READING", detail=f"{min(MAX_READ, len(ranked))} fonte(s)")
        await self.engine.read_sources(ranked[:MAX_READ])
        conflicts = detect_conflicts(question, ranked)
        result = {"question": question, "subquestions": subs, "sources": [r.to_dict() for r in ranked],
                  "conflicts": conflicts, "errors": errors, "search_ms": round((time.perf_counter() - t0) * 1000)}
        if not ranked:
            result["text"] = "Não encontrei fontes para essa pesquisa." + (f" Problemas: {'; '.join(errors)}." if errors else "")
            return result
        if not model_available:
            lines = "\n".join(f"[{i}] {r.title} — {r.url}" for i, r in enumerate(ranked, 1))
            result["text"] = f"Encontrei {len(ranked)} fontes, mas sem o modelo de IA não consigo sintetizar:\n{lines}"
            return result
        self.on_phase("PROCESSING", detail="síntese")
        result["prompt"] = synthesis_prompt(question, subs, ranked, conflicts)
        return result


def synthesis_prompt(question: str, subs: list[str], ranked, conflicts: list[str]) -> str:
    blocks = []
    for i, r in enumerate(ranked, 1):
        body = (r.content or r.snippet or "")[:1800]
        blocks.append(f"[{i}] {r.title} ({r.tier_label}; {r.url})\n{body}")
    return (
        "Você vai escrever uma resposta de PESQUISA APROFUNDADA usando SOMENTE as fontes numeradas abaixo.\n"
        "Regras:\n- Cite as fontes no texto como [1], [2].\n- Organize em seções curtas com títulos simples em MAIÚSCULAS (sem Markdown).\n"
        "- Se o assunto envolver ficção com várias continuidades (filmes, quadrinhos, animações, jogos), separe por universo e não misture.\n"
        "- Se as fontes divergirem, diga 'Encontrei informações conflitantes entre as fontes' e explique.\n"
        "- Se faltar informação, diga que não há informação suficiente. Não invente.\n"
        "- Priorize fontes oficiais e de maior confiabilidade.\n\n"
        f"PERGUNTA: {question}\nFRENTES PESQUISADAS: {'; '.join(subs)}\n"
        + (f"CONFLITOS DETECTADOS: {' '.join(conflicts)}\n" if conflicts else "")
        + "\nFONTES:\n" + "\n\n".join(blocks)
    )
