"""
Provedores de pesquisa (adapters). Todos seguem o mesmo contrato:

    await provider.search(query, limit=5, **opções) -> list[SearchResult]

Sem chave (funcionam direto):  Wikipedia · GitHub · arXiv
Com chave (no .env):           Tavily (web geral e notícias) · Brave Search (web e notícias)

`SiteSearch` restringe um provedor geral a domínios confiáveis de uma
categoria (ex.: MARVEL OFFICIAL → marvel.com; GOVERNMENT → gov.br).
"""
from __future__ import annotations

import html
import logging
import re
import xml.etree.ElementTree as ET
from abc import ABC, abstractmethod
from urllib.parse import quote

import httpx

from knowledge.ranking import SearchResult

log = logging.getLogger("jarvis.search")
UA = {"User-Agent": "JARVIS/0.3 (assistente pessoal; uso pessoal) httpx"}


class SearchError(Exception):
    def __init__(self, provider: str, message: str):
        super().__init__(f"{provider}: {message}")
        self.provider = provider


def _clean(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


class SearchProvider(ABC):
    name = "base"
    category = "general"        # categoria padrão dos resultados
    needs_key = False
    timeout = 12.0

    @property
    def available(self) -> bool:
        return True

    @abstractmethod
    async def search(self, query: str, limit: int = 5, **opts) -> list[SearchResult]: ...

    async def _get(self, url: str, **kw) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=self.timeout, headers={**UA, **kw.pop("headers", {})}, follow_redirects=True) as c:
                r = await c.get(url, **kw)
        except httpx.HTTPError as e:
            raise SearchError(self.name, f"sem conexão ({e.__class__.__name__})")
        if r.status_code >= 400:
            raise SearchError(self.name, f"respondeu {r.status_code}")
        return r

    async def _post(self, url: str, **kw) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=self.timeout, headers={**UA, **kw.pop("headers", {})}) as c:
                r = await c.post(url, **kw)
        except httpx.HTTPError as e:
            raise SearchError(self.name, f"sem conexão ({e.__class__.__name__})")
        if r.status_code in (401, 403):
            raise SearchError(self.name, "chave recusada")
        if r.status_code >= 400:
            raise SearchError(self.name, f"respondeu {r.status_code}")
        return r


class WikipediaProvider(SearchProvider):
    name = "wikipedia"
    category = "wikipedia"

    def __init__(self, langs: tuple[str, ...] = ("pt", "en")):
        self.langs = langs

    async def search(self, query: str, limit: int = 4, **opts) -> list[SearchResult]:
        for lang in opts.get("langs") or self.langs:
            base = f"https://{lang}.wikipedia.org/w/api.php"
            r = await self._get(base, params={"action": "query", "list": "search", "srsearch": query, "srlimit": limit,
                                              "format": "json", "utf8": 1})
            hits = r.json().get("query", {}).get("search", [])
            if not hits:
                continue
            titles = [h["title"] for h in hits]
            ex = await self._get(base, params={"action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1,
                                               "titles": "|".join(titles), "format": "json", "utf8": 1})
            extracts = {p.get("title"): p.get("extract", "") for p in ex.json().get("query", {}).get("pages", {}).values()}
            return [SearchResult(title=f"{t} — Wikipédia ({lang})", url=f"https://{lang}.wikipedia.org/wiki/{quote(t.replace(' ', '_'))}",
                                 snippet=_clean(h.get("snippet", "")), provider=self.name, category="wikipedia",
                                 content=(extracts.get(t) or "")[:4000] or None)
                    for t, h in zip(titles, hits)]
        return []


class GitHubProvider(SearchProvider):
    name = "github"
    category = "github"

    def __init__(self, token: str = ""):
        self.token = token

    async def search(self, query: str, limit: int = 5, **opts) -> list[SearchResult]:
        headers = {"Accept": "application/vnd.github+json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        r = await self._get("https://api.github.com/search/repositories", params={"q": query, "sort": "stars", "per_page": limit}, headers=headers)
        return [SearchResult(title=f"{it['full_name']} ★{it.get('stargazers_count', 0)}", url=it["html_url"],
                             snippet=(it.get("description") or "")[:300], provider=self.name, category="github",
                             published=(it.get("pushed_at") or "")[:10] or None)
                for it in r.json().get("items", [])[:limit]]


class ArxivProvider(SearchProvider):
    name = "arxiv"
    category = "academic"

    async def search(self, query: str, limit: int = 5, **opts) -> list[SearchResult]:
        r = await self._get("https://export.arxiv.org/api/query", params={"search_query": f"all:{query}", "max_results": limit})
        ns = {"a": "http://www.w3.org/2005/Atom"}
        try:
            root = ET.fromstring(r.text)
        except ET.ParseError:
            raise SearchError(self.name, "resposta inválida")
        out = []
        for e in root.findall("a:entry", ns):
            title = " ".join((e.findtext("a:title", "", ns) or "").split())
            link = e.findtext("a:id", "", ns) or ""
            out.append(SearchResult(title=title, url=link.replace("http://", "https://"), snippet=" ".join((e.findtext("a:summary", "", ns) or "").split())[:500],
                                    provider=self.name, category="academic", published=(e.findtext("a:published", "", ns) or "")[:10] or None))
        return out


class TavilyProvider(SearchProvider):
    name = "tavily"
    needs_key = True

    def __init__(self, api_key: str = ""):
        self.api_key = api_key

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    async def search(self, query: str, limit: int = 5, **opts) -> list[SearchResult]:
        if not self.api_key:
            raise SearchError(self.name, "TAVILY_API_KEY não configurada")
        body = {"query": query, "max_results": limit, "search_depth": "basic", "topic": "news" if opts.get("news") else "general"}
        if opts.get("domains"):
            body["include_domains"] = opts["domains"]
        r = await self._post("https://api.tavily.com/search", json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        cat = "news" if opts.get("news") else opts.get("category", "general")
        return [SearchResult(title=x.get("title", ""), url=x.get("url", ""), snippet=(x.get("content") or "")[:500], provider=self.name,
                             category=cat, published=x.get("published_date"))
                for x in r.json().get("results", [])]


class BraveProvider(SearchProvider):
    name = "brave"
    needs_key = True

    def __init__(self, api_key: str = ""):
        self.api_key = api_key

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    async def search(self, query: str, limit: int = 5, **opts) -> list[SearchResult]:
        if not self.api_key:
            raise SearchError(self.name, "BRAVE_API_KEY não configurada")
        q = query + "".join(f" site:{d}" for d in (opts.get("domains") or [])[:1])
        kind = "news" if opts.get("news") else "web"
        r = await self._get(f"https://api.search.brave.com/res/v1/{kind}/search", params={"q": q, "count": limit},
                            headers={"X-Subscription-Token": self.api_key, "Accept": "application/json"})
        data = r.json()
        items = data.get("results", []) if kind == "news" else data.get("web", {}).get("results", [])
        cat = "news" if opts.get("news") else opts.get("category", "general")
        return [SearchResult(title=_clean(x.get("title", "")), url=x.get("url", ""), snippet=_clean(x.get("description", ""))[:500],
                             provider=self.name, category=cat, published=x.get("age") or x.get("page_age"))
                for x in items[:limit]]


class SiteSearch(SearchProvider):
    """Categoria de fontes confiáveis = provedor geral + lista de domínios."""

    def __init__(self, name: str, category: str, base: SearchProvider, domains: list[str]):
        self.name = name
        self.category = category
        self.base = base
        self.domains = domains

    @property
    def available(self) -> bool:
        return self.base.available

    async def search(self, query: str, limit: int = 5, **opts) -> list[SearchResult]:
        res = await self.base.search(query, limit, domains=self.domains, category=self.category)
        for r in res:
            r.provider, r.category = self.name, self.category
        return res
