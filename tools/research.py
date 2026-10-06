"""DEEP RESEARCH como ferramenta: 'pesquise tudo sobre...', 'faça uma pesquisa completa sobre...'."""
from __future__ import annotations

import re

from tools import Tool, ToolResult

_DEEP = re.compile(r"^(?:jarvis[,\s]+)?(?:pesquis[ae]r?|investigu?e|fa[cç]a\s+uma\s+pesquisa)\s+(?:(?:tudo|bem|mais)\s+)?(?:sobre\s+)?"
                   r"(?:.*(?:tudo\s+sobre|a\s+fundo|em\s+profundidade|profundamente|aprofundada|completa|detalhada).*|tudo\s+sobre\s+.+)$", re.I)
_CLEAN = re.compile(r"^(?:jarvis[,\s]+)?(?:pesquis[ae]r?|investigu?e|fa[cç]a\s+uma\s+pesquisa)\s+(?:completa\s+|detalhada\s+|aprofundada\s+|a\s+fundo\s+)?(?:tudo\s+)?(?:sobre\s+)?", re.I)


class ResearchTool(Tool):
    name = "research"
    description = "Pesquisa em profundidade: divide a pergunta, busca em várias fontes, lê as páginas, compara e sintetiza com fontes."
    parameters = {"question": {"type": "string", "required": True, "description": "o tema da pesquisa"}}
    priority = 45

    def __init__(self, research, model_available):
        self.research = research
        self.model_available = model_available     # função: o modelo está disponível agora?

    def match(self, text: str) -> dict | None:
        if _DEEP.match(text.strip()):
            q = _CLEAN.sub("", text.strip()).strip(" ?.!")
            return {"question": q or text}
        return None

    async def execute(self, question: str) -> ToolResult:
        r = await self.research.run(question, self.model_available())
        if not r["sources"]:
            return ToolResult.fail("NO_RESULTS", r["text"], **{k: r[k] for k in ("errors", "subquestions")})
        data = {"sources": r["sources"], "subquestions": r["subquestions"], "conflicts": r["conflicts"],
                "errors": r["errors"], "search_ms": r["search_ms"], "topic": question}
        if "prompt" in r:
            data["prompt_override"] = r["prompt"]
            return ToolResult(True, f"Pesquisei {len(r['sources'])} fontes.", data, summarize=True)
        return ToolResult(True, r["text"], data)
