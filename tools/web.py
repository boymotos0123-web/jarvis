"""
Pesquisa na web — multi-fonte, com ranking e cache (knowledge/).

Fluxo: pergunta → escolha das categorias de fonte → busca em paralelo →
ranking por confiabilidade → o modelo responde citando [1], [2]...
Wikipedia, GitHub e arXiv funcionam sem chave; web geral e notícias precisam
de Tavily ou Brave. Nada é inventado: sem resultados, a ferramenta diz isso.
"""
from __future__ import annotations

import re

from tools import Tool, ToolResult

_SEARCH = re.compile(r"^(?:jarvis[,\s]+)?(?:pesquis[ae]r?|procur[ae]r?|busc[ae]r?|verifiqu?e)\s+(?:na\s+(?:web|internet)\s+)?(?:sobre\s+|por\s+)?(.{3,})$", re.I)
_DEEP = re.compile(r"tudo\s+sobre|a\s+fundo|em\s+profundidade|profundament|aprofundad|completa|detalhad", re.I)

INSTRUCTIONS = ("Responda usando SOMENTE os resultados da pesquisa abaixo. Cite as fontes no texto como [1], [2] "
                "(o número é a posição na lista). Prefira as fontes de maior confiabilidade. Se as fontes divergirem, diga "
                "'Encontrei informações conflitantes entre as fontes' e explique. Se os resultados não responderem, diga que "
                "não encontrou informação suficiente. Não invente nada além das fontes.")


class WebTool(Tool):
    name = "web"
    description = "Pesquisa informações atuais na internet em várias fontes (web, notícias, Wikipedia, GitHub, arXiv, oficiais) e devolve resultados ranqueados com links."
    parameters = {"query": {"type": "string", "required": True, "description": "o que pesquisar"}}
    priority = 50

    def __init__(self, engine):
        self.engine = engine

    @property
    def configured(self) -> bool:
        return self.engine.general.available

    def match(self, text: str) -> dict | None:
        m = _SEARCH.match(text.strip())
        if m and not _DEEP.search(text):
            return {"query": m.group(1).strip(" ?.!")}
        return None

    async def execute(self, query: str) -> ToolResult:
        rep = await self.engine.search(query)
        if not rep.results:
            why = f" ({'; '.join(rep.errors)})" if rep.errors else ""
            return ToolResult.fail("NO_RESULTS", f"Não encontrei resultados para “{query}”{why}.", query=query, errors=rep.errors)
        lines = "\n".join(f"[{i}] {r.title} — {r.url} ({r.tier_label})" for i, r in enumerate(rep.results, 1))
        listing = [{"n": i, "title": r.title, "url": r.url, "reliability": r.tier_label, "snippet": (r.content or r.snippet)[:700]}
                   for i, r in enumerate(rep.results, 1)]
        return ToolResult(True, f"Encontrei {len(rep.results)} fonte(s) para “{query}”:\n{lines}",
                          {"query": query, "results": listing, "sources": rep.sources(), "conflicts": rep.conflicts,
                           "errors": rep.errors, "search_ms": rep.elapsed_ms, "instructions": INSTRUCTIONS, "topic": query},
                          summarize=True)
