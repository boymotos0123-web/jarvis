"""Knowledge Engine: base local, grafo, canon, ranking, cache e provedores (HTTP simulado, sem internet)."""
import asyncio
import functools
import json
import time

import httpx
import pytest

from knowledge import providers as P
from knowledge import universes as U
from knowledge.cache import SearchCache
from knowledge.ranking import SearchResult, detect_conflicts, rank, tier_of
from knowledge.reader import extract_text
from tests.conftest import install_offline


# ---------------------------------------------------------------- base local e grafo
def test_base_carregada_com_metadados_de_canon(jarvis):
    kb = jarvis.knowledge.kb
    st = kb.stats()
    assert st["entities"] >= 30 and st["facts"] >= 60 and st["relations"] >= 50
    assert {"MCU", "COMICS_616", "REAL_WORLD"} <= set(st["universes"])
    for f in kb.facts(["tony-stark"]):
        assert f["universe"] in U.UNIVERSES and f["source"] and f["canonical_status"] and f["last_verified"]
        assert 0 < f["confidence"] <= 1


def test_semente_so_recarrega_quando_muda(jarvis):
    assert jarvis.knowledge.kb.load_seeds() == 0          # hash igual → nada a fazer


def test_deteccao_de_entidades(jarvis):
    kb = jarvis.knowledge.kb
    assert kb.detect("JARVIS, quem é Tony Stark?") == ["tony-stark"]           # "JARVIS," é vocativo, não a IA
    assert kb.detect("o que o J.A.R.V.I.S. fazia?") == ["jarvis-ai"]
    assert kb.detect("a relação do Homem de Ferro com o Homem-Aranha") == ["iron-man", "spider-man"]
    assert kb.detect("me fala da Mark III.") == ["mark-iii"]
    assert kb.detect("qual a previsão do tempo?") == []


def test_universos_nao_se_misturam(jarvis):
    kb = jarvis.knowledge.kb
    mcu = kb.facts(["tony-stark"], ["MCU"])
    assert mcu and {f["universe"] for f in mcu} <= {"MCU", "REAL_WORLD"}
    block, sources, slugs, wanted = kb.context_for("Como o Tony Stark é nos quadrinhos?")
    assert wanted == ["COMICS_616"] and "[MCU" not in block and "[Quadrinhos (Terra-616" in block
    assert U.detect("e no filme do Sam Raimi?") == ["FILMS_OTHER"]
    assert U.detect("diferença entre o MCU e os quadrinhos") == ["MCU", "COMICS_616"]


def test_grafo_conexoes_tony_peter(jarvis):
    paths = jarvis.knowledge.kb.connections("tony-stark", "peter-parker")
    assert paths
    preds = {r["predicate"] for c in paths for r in c["path"]}
    assert "mentor_of" in preds or "created" in preds
    assert all(len({r["universe"] for r in c["path"]}) == 1 for c in paths)   # caminho nunca cruza universos


def test_resposta_offline_nao_inventa(jarvis):
    kb = jarvis.knowledge.kb
    assert kb.offline_answer("quem é o Batman?") is None
    txt = kb.offline_answer("quem criou o Homem-Aranha?")
    assert "Stan Lee" in txt and "[fonte:" not in txt


def test_ferramenta_conhecimento_nao_cobre_informacao_atual(jarvis):
    tool = jarvis.tools.get("knowledge")
    assert tool.match("quem é Tony Stark?")
    assert tool.match("quais as notícias de hoje sobre o Tony Stark?") is None
    r = tool.execute("quem é o Batman?")
    assert not r.ok and r.error_code == "KNOWLEDGE_NOT_FOUND"


# ---------------------------------------------------------------- ranking e conflitos
@pytest.mark.parametrize("url,tier", [
    ("https://www.marvel.com/x", 1), ("https://www.gov.br/receita", 1), ("https://docs.python.org/3/", 2),
    ("https://arxiv.org/abs/1", 3), ("https://pt.wikipedia.org/wiki/X", 4), ("https://github.com/a/b", 5),
    ("https://g1.globo.com/x", 6), ("https://marvel.fandom.com/wiki/X", 7), ("https://blogqualquer.net", 7),
])
def test_niveis_de_confianca(url, tier):
    assert tier_of(url) == tier


def test_rank_ordena_e_remove_duplicados():
    res = [SearchResult("fã", "https://marvel.fandom.com/a", "s"), SearchResult("blog", "https://x.net/a"),
           SearchResult("oficial", "https://www.marvel.com/a", "s"), SearchResult("dup", "https://www.marvel.com/a/#top")]
    out = rank(res)
    assert [r.title for r in out] == ["oficial", "fã", "blog"]
    assert out[0].tier_label == "Fonte oficial" and "comunitária" in out[1].notes[0]


def test_conflito_de_datas():
    res = [SearchResult("a", "https://www.marvel.com/a", "estreou em 2008"), SearchResult("b", "https://pt.wikipedia.org/b", "lançado em 2007")]
    assert detect_conflicts("quando estreou o Homem de Ferro?", res)
    assert detect_conflicts("quem é o Homem de Ferro?", res) == []


# ---------------------------------------------------------------- motor de pesquisa
def test_pesquisa_paralela_cache_e_erros(jarvis):
    install_offline(jarvis, general_available=False,
                    data={"WIKIPEDIA": {"reator": [{"title": "Reator Arc", "url": "https://pt.wikipedia.org/wiki/Reator", "snippet": "s"}]}})
    eng = jarvis.knowledge
    rep = asyncio.run(eng.search("reator arc", ["WIKIPEDIA", "GENERAL_WEB", "NEWS"]))
    assert [r.title for r in rep.results] == ["Reator Arc"]
    assert rep.errors == ["web geral e notícias: configure TAVILY_API_KEY ou BRAVE_API_KEY no .env"]   # sem duplicar
    assert rep.cached == 0
    rep2 = asyncio.run(eng.search("reator arc", ["WIKIPEDIA"]))
    assert rep2.cached == 1 and len(eng.providers["WIKIPEDIA"].queries) == 1   # 2ª vez veio do cache


def test_falha_de_provedor_nao_derruba_a_pesquisa(jarvis):
    provs = install_offline(jarvis, general_available=True,
                            data={"GENERAL_WEB": {"x": [{"title": "ok", "url": "https://a.com/1"}]}})
    provs["WIKIPEDIA"].error = "sem conexão (ConnectError)"
    rep = asyncio.run(jarvis.knowledge.search("x", ["WIKIPEDIA", "GENERAL_WEB"]))
    assert len(rep.results) == 1 and any("sem conexão" in e for e in rep.errors)


def test_escolha_de_categorias(jarvis):
    eng = jarvis.knowledge
    assert eng.choose_categories("notícias de hoje sobre IA")[0] == "NEWS"
    assert "GITHUB" in eng.choose_categories("melhor biblioteca python para áudio")
    assert "MARVEL_OFFICIAL" in eng.choose_categories("novidades do Homem-Aranha")
    assert "GOVERNMENT" in eng.choose_categories("lei do imposto de renda")
    assert eng.needs_current_info("qual o preço da RTX 5090 hoje?") and not eng.needs_current_info("quem é Tony Stark?")


def test_cache_expira(jarvis):
    c = SearchCache(jarvis.db)
    c.put("p", "Olá  Mundo", [1], ttl=60)
    assert c.get("p", "olá mundo") == [1]                 # normaliza caixa e espaços
    jarvis.db.execute("UPDATE search_cache SET created_at = ?", (time.time() - 120,))
    assert c.get("p", "olá mundo") is None


# ---------------------------------------------------------------- provedores (HTTP simulado)
@pytest.fixture
def fake_http(monkeypatch):
    routes = {}

    def handler(request: httpx.Request):
        for key, fn in routes.items():
            if key in str(request.url):
                return fn(request)
        return httpx.Response(404)
    monkeypatch.setattr(P.httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)))
    return routes


def test_wikipedia_provider(fake_http):
    def wiki(req):
        if req.url.params.get("list") == "search":
            return httpx.Response(200, json={"query": {"search": [{"title": "Homem de Ferro", "snippet": "<b>Homem</b> de Ferro"}]}})
        return httpx.Response(200, json={"query": {"pages": {"1": {"title": "Homem de Ferro", "extract": "Personagem da Marvel."}}}})
    fake_http["pt.wikipedia.org"] = wiki
    res = asyncio.run(P.WikipediaProvider().search("homem de ferro"))
    assert res[0].url == "https://pt.wikipedia.org/wiki/Homem_de_Ferro"
    assert res[0].snippet == "Homem de Ferro" and res[0].content == "Personagem da Marvel."


def test_github_provider(fake_http):
    fake_http["api.github.com"] = lambda req: httpx.Response(200, json={"items": [
        {"full_name": "a/jarvis", "html_url": "https://github.com/a/jarvis", "description": "assistente", "stargazers_count": 42,
         "pushed_at": "2026-09-01T00:00:00Z"}]})
    r = asyncio.run(P.GitHubProvider().search("jarvis"))[0]
    assert r.title == "a/jarvis ★42" and r.published == "2026-09-01"


def test_arxiv_provider(fake_http):
    atom = ('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1234</id>'
            '<title> Voice   Agents </title><summary>resumo</summary><published>2026-01-02T00:00:00Z</published></entry></feed>')
    fake_http["export.arxiv.org"] = lambda req: httpx.Response(200, text=atom)
    r = asyncio.run(P.ArxivProvider().search("voice"))[0]
    assert (r.title, r.url, r.published) == ("Voice Agents", "https://arxiv.org/abs/1234", "2026-01-02")


def test_tavily_provider_e_chave(fake_http):
    seen = {}

    def tavily(req):
        seen.update(json.loads(req.content))
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://www.marvel.com/n", "content": "c"}]})
    fake_http["api.tavily.com"] = tavily
    assert not P.TavilyProvider("").available
    res = asyncio.run(P.SiteSearch("marvel", "marvel_official", P.TavilyProvider("k"), ["marvel.com"]).search("x", news=False))
    assert res[0].provider == "marvel" and seen["include_domains"] == ["marvel.com"] and seen["auth"] == "Bearer k"
    fake_http["api.tavily.com"] = lambda req: httpx.Response(401)
    with pytest.raises(P.SearchError, match="chave recusada"):
        asyncio.run(P.TavilyProvider("ruim").search("x"))


def test_brave_provider(fake_http):
    fake_http["api.search.brave.com"] = lambda req: httpx.Response(200, json={"web": {"results": [
        {"title": "<strong>JARVIS</strong>", "url": "https://x.com", "description": "d"}]}})
    r = asyncio.run(P.BraveProvider("k").search("jarvis"))[0]
    assert r.title == "JARVIS"


def test_sem_conexao_vira_erro_claro(monkeypatch):
    def boom(req):
        raise httpx.ConnectError("offline")
    monkeypatch.setattr(P.httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(boom)))
    with pytest.raises(P.SearchError, match="sem conexão"):
        asyncio.run(P.GitHubProvider().search("x"))


def test_leitor_de_pagina():
    html = "<html><head><style>x{}</style><script>alert(1)</script></head><body><nav>menu</nav><p>Texto &amp; útil.</p></body></html>"
    t = extract_text(html)
    assert "Texto & útil." in t and "alert" not in t
