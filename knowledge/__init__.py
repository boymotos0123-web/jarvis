"""
KNOWLEDGE ENGINE — decide de onde vem cada resposta.

                    JARVIS
                       |
                KNOWLEDGE ENGINE
        ┌──────────────┼──────────────┐
      MEMORY          LLM / KB         WEB
        └──────────────┼──────────────┘
                 SOURCE RANKING
                       |
                 ANSWER ENGINE (brain)

- memória do usuário → ferramenta de memória (tools/memory_tool.py)
- conhecimento geral/estruturado → base local (kb.py) + modelo
- informação atual → pesquisa web multi-fonte (providers.py), com cache e ranking
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field

from core.memory import strip_accents
from knowledge.cache import TTL, SearchCache
from knowledge.kb import KnowledgeBase
from knowledge.providers import (ArxivProvider, BraveProvider, GitHubProvider, SearchError, SearchProvider, SiteSearch,
                                 TavilyProvider, WikipediaProvider)
from knowledge.ranking import SearchResult, detect_conflicts, rank
from knowledge.reader import read_page

log = logging.getLogger("jarvis.knowledge")

CATEGORIES = ["GENERAL_WEB", "NEWS", "WIKIPEDIA", "OFFICIAL_DOCUMENTATION", "TECHNICAL_DOCUMENTATION", "ACADEMIC",
              "GITHUB", "GOVERNMENT", "MARVEL_OFFICIAL"]

_CURRENT = re.compile(r"\b(hoje|agora|atualmente|atual|atuais|recentes?|ultim[oa]s?|noticias?|novidades?|lancamentos?|lancou|"
                      r"esta semana|este mes|este ano|ontem|preco|precos|cotacao|placar|resultado do jogo|previsao|"
                      r"20(2[5-9]|3\d)|ainda (esta|existe|funciona)|mais nov[oa])\b")
_NEWS = re.compile(r"\b(noticias?|novidades?|hoje|ontem|esta semana|aconteceu|anunci)")
_CODE = re.compile(r"\b(github|repositorio|biblioteca|lib|framework|sdk|api|codigo|python|javascript|npm|pip|pacote)\b")
_ACAD = re.compile(r"\b(artigo cientifico|paper|estudo cientifico|pesquisa cientifica|arxiv|academic|cientific)")
_GOV = re.compile(r"\b(lei|leis|governo|gov\.br|imposto|receita federal|inss|decreto|ministerio|prefeitura|detran)\b")
_DOCS = re.compile(r"\b(documentacao|docs?|manual|referencia oficial|especificac(ao|oes))\b")


@dataclass
class SearchReport:
    query: str
    results: list[SearchResult] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    cached: int = 0
    elapsed_ms: float = 0.0

    def sources(self) -> list[dict]:
        return [r.to_dict() for r in self.results]


class KnowledgeEngine:
    def __init__(self, db, tavily_key: str = "", brave_key: str = "", github_token: str = ""):
        self.db = db
        self.kb = KnowledgeBase(db)
        self.kb.load_seeds()
        self.cache = SearchCache(db)
        general: SearchProvider = TavilyProvider(tavily_key) if tavily_key else BraveProvider(brave_key)
        self.general = general
        self.providers: dict[str, SearchProvider] = {
            "GENERAL_WEB": general,
            "NEWS": general,
            "WIKIPEDIA": WikipediaProvider(),
            "GITHUB": GitHubProvider(github_token),
            "ACADEMIC": ArxivProvider(),
            "OFFICIAL_DOCUMENTATION": SiteSearch("official_docs", "official_docs", general,
                                                 ["docs.python.org", "developer.mozilla.org", "learn.microsoft.com", "platform.openai.com", "docs.anthropic.com"]),
            "TECHNICAL_DOCUMENTATION": SiteSearch("tech_docs", "tech_docs", general, ["readthedocs.io", "stackoverflow.com", "github.com"]),
            "GOVERNMENT": SiteSearch("government", "government", general, ["gov.br"]),
            "MARVEL_OFFICIAL": SiteSearch("marvel_official", "marvel_official", general, ["marvel.com"]),
        }

    # ---------- decisões ----------
    @staticmethod
    def needs_current_info(text: str) -> bool:
        return bool(_CURRENT.search(strip_accents(text.lower())))

    def choose_categories(self, query: str) -> list[str]:
        t = strip_accents(query.lower())
        cats: list[str] = []
        if _NEWS.search(t):
            cats.append("NEWS")
        if _CODE.search(t):
            cats += ["GITHUB", "TECHNICAL_DOCUMENTATION"]
        if _ACAD.search(t):
            cats.append("ACADEMIC")
        if _GOV.search(t):
            cats.append("GOVERNMENT")
        if _DOCS.search(t):
            cats.append("OFFICIAL_DOCUMENTATION")
        if self.kb.detect(query):
            cats.append("MARVEL_OFFICIAL")
        if "NEWS" not in cats:
            cats.append("GENERAL_WEB")
        cats.append("WIKIPEDIA")
        seen = []
        for c in cats:
            if c not in seen:
                seen.append(c)
        return seen

    def status(self) -> dict:
        return {
            "providers": {c: {"provider": p.name, "available": p.available} for c, p in self.providers.items()},
            "general_web": self.general.available,
            "cache": {"hits": self.cache.hits, "misses": self.cache.misses},
            "knowledge_base": self.kb.stats(),
        }

    # ---------- pesquisa ----------
    async def _one(self, category: str, query: str, limit: int) -> tuple[str, list[SearchResult], str | None, bool]:
        p = self.providers[category]
        if not p.available:
            return category, [], "web geral e notícias: configure TAVILY_API_KEY ou BRAVE_API_KEY no .env", False
        news = category == "NEWS"
        cached = self.cache.get(p.name, query, extra=f"{category}")
        if cached is not None:
            return category, [SearchResult(**{k: v for k, v in c.items() if k in SearchResult.__dataclass_fields__}) for c in cached], None, True
        try:
            res = await p.search(query, limit, news=news) if news else await p.search(query, limit)
        except SearchError as e:
            log.info("busca falhou: %s", e)
            return category, [], str(e), False
        ttl = TTL["news"] if news else TTL.get(p.category, TTL["general"])
        self.cache.put(p.name, query, [r.__dict__ for r in res], ttl, extra=f"{category}")
        return category, res, None, False

    async def search(self, query: str, categories: list[str] | None = None, limit: int = 8) -> SearchReport:
        t0 = time.perf_counter()
        cats = [c for c in (categories or self.choose_categories(query)) if c in self.providers]
        rep = SearchReport(query=query, categories=cats)
        outcomes = await asyncio.gather(*(self._one(c, query, 5) for c in cats))
        pool: list[SearchResult] = []
        for cat, res, err, cached in outcomes:
            if err and err not in rep.errors:
                rep.errors.append(err)
            if res:
                rep.providers.append(self.providers[cat].name)
                pool += res
            rep.cached += int(cached)
        rep.results = rank(pool, limit)
        rep.conflicts = detect_conflicts(query, rep.results)
        rep.elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return rep

    async def read_sources(self, results: list[SearchResult]) -> None:
        """Lê as páginas que ainda não têm texto (Wikipedia já vem com o resumo)."""
        async def one(r: SearchResult):
            if r.content:
                return
            cached = self.cache.get("page", r.url)
            if cached is not None:
                r.content = cached
                return
            try:
                r.content = await read_page(r.url)
                self.cache.put("page", r.url, r.content, TTL["page"])
            except Exception as e:  # página fora do ar, bloqueio etc. — segue com o resumo
                r.notes.append(f"não foi possível ler a página ({e.__class__.__name__})")
        await asyncio.gather(*(one(r) for r in results))
