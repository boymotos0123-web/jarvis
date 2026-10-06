"""
Ranking de fontes por confiabilidade.

Prioridade:
 1. fonte oficial   2. documentação oficial   3. acadêmico   4. institucional/enciclopédia
 5. técnica confiável   6. mídia reconhecida   7. outras (blogs, fã-wikis...)

Também detecta um tipo simples de conflito: fontes bem colocadas que citam
anos diferentes para a mesma pergunta de "quando".
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from urllib.parse import urlparse

TIER_LABELS = {1: "Fonte oficial", 2: "Documentação oficial", 3: "Acadêmica", 4: "Institucional / enciclopédia",
               5: "Técnica confiável", 6: "Mídia reconhecida", 7: "Outra fonte"}

_OFFICIAL = ["marvel.com", "marvelstudios.com", "disney.com", "disneyplus.com", "sony.com", "sonypictures.com", "openai.com",
             "anthropic.com", "microsoft.com", "apple.com", "google.com", "nvidia.com", "python.org", "gov.br", "planalto.gov.br"]
_DOCS = ["docs.", "developer.", "developers.", "readthedocs.io", "learn.microsoft.com", "developer.mozilla.org",
         "platform.openai.com", "docs.python.org", "fastapi.tiangolo.com", "react.dev"]
_ACADEMIC = ["arxiv.org", "doi.org", "nature.com", "science.org", "ieee.org", "acm.org", "springer.com", "sciencedirect.com",
             "ncbi.nlm.nih.gov", "pubmed", "scielo", "scholar.google", "researchgate.net", "jstor.org"]
_INSTITUTIONAL = ["wikipedia.org", "britannica.com", "w3.org", "who.int", "un.org", "ibge.gov.br", "embrapa.br", "unesco.org"]
_TECH = ["github.com", "gitlab.com", "stackoverflow.com", "pypi.org", "npmjs.com", "huggingface.co", "kaggle.com"]
_MEDIA = ["reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "cnn.com", "nytimes.com", "theguardian.com", "theverge.com",
          "wired.com", "techcrunch.com", "arstechnica.com", "g1.globo.com", "globo.com", "folha.uol.com.br", "estadao.com.br",
          "uol.com.br", "cnnbrasil.com.br", "tecmundo.com.br", "olhardigital.com.br", "ign.com", "variety.com",
          "hollywoodreporter.com", "deadline.com", "omelete.com.br"]
_FAN = ["fandom.com", "reddit.com", "quora.com", "medium.com", "blogspot.", "wordpress."]


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""
    provider: str = ""
    category: str = "general"
    published: str | None = None
    content: str | None = None          # texto lido da página (preenchido pelo reader)
    tier: int = 7
    tier_label: str = ""
    score: float = 0.0
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["domain"] = domain_of(self.url)
        if d.get("content"):
            d["content"] = d["content"][:600]
        return d


def domain_of(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def _matches(host: str, patterns: list[str]) -> bool:
    for p in patterns:
        if p.endswith("."):
            if host.startswith(p) or f".{p}" in host:
                return True
        elif host == p or host.endswith("." + p) or (p in host and "." not in p):
            return True
    return False


def tier_of(url: str) -> int:
    host = domain_of(url)
    if not host:
        return 7
    if _matches(host, _FAN):
        return 7
    if _matches(host, _DOCS) or host.startswith("docs.") or host.startswith("developer."):
        return 2          # antes de "oficial": docs.python.org é documentação, python.org é a fonte oficial
    if host.endswith(".gov") or host.endswith(".gov.br") or host.endswith(".mil") or _matches(host, _OFFICIAL):
        return 1
    if host.endswith(".edu") or host.endswith(".edu.br") or _matches(host, _ACADEMIC):
        return 3
    if _matches(host, _INSTITUTIONAL) or host.endswith(".int"):
        return 4
    if _matches(host, _TECH):
        return 5
    if _matches(host, _MEDIA):
        return 6
    return 7


def rank(results: list[SearchResult], limit: int = 8) -> list[SearchResult]:
    """Ordena por confiabilidade + posição no provedor; remove URLs repetidas."""
    seen, out = set(), []
    for pos, r in enumerate(results):
        key = re.sub(r"[#?].*$", "", r.url.lower()).rstrip("/")
        if not r.url or key in seen:
            continue
        seen.add(key)
        r.tier = tier_of(r.url)
        r.tier_label = TIER_LABELS[r.tier]
        if r.tier == 7 and _matches(domain_of(r.url), _FAN):
            r.notes.append("fonte comunitária — confirme em fonte oficial")
        r.score = (8 - r.tier) * 10 - pos * 0.5 + (2 if r.snippet else 0)
        out.append(r)
    out.sort(key=lambda r: r.score, reverse=True)
    return out[:limit]


_YEAR = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")


def detect_conflicts(question: str, results: list[SearchResult]) -> list[str]:
    """Se a pergunta é sobre 'quando/ano' e as melhores fontes citam anos diferentes, avisa."""
    if not re.search(r"\b(quando|que ano|qual ano|em que ano|data|lan[cç]ad|estreou|primeir)", question, re.I):
        return []
    per_source = []
    for r in results[:5]:
        years = _YEAR.findall(f"{r.snippet} {r.content or ''}"[:1500])
        if years:
            per_source.append((domain_of(r.url), Counter(years).most_common(1)[0][0]))
    distinct = {y for _, y in per_source}
    if len(per_source) >= 2 and len(distinct) > 1:
        detail = "; ".join(f"{d}: {y}" for d, y in per_source)
        return [f"As fontes citam anos diferentes ({detail})."]
    return []
