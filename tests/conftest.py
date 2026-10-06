"""Fixtures: um JARVIS completo com banco temporário e um modelo falso (sem internet)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config import Config  # noqa: E402
from main import build_jarvis  # noqa: E402
from models.llm import LLMError, LLMProvider, Message  # noqa: E402


class FakeLLM(LLMProvider):
    """Modelo de teste: responde com scripts definidos pelo teste e registra o que recebeu."""
    provider = "fake"

    def __init__(self, replies=None, available=True):
        super().__init__(model="fake-1")
        self.replies = list(replies or [])
        self.available = available
        self.calls: list[list[Message]] = []

    async def chat(self, messages):
        self.calls.append(list(messages))
        if not self.available:
            raise LLMError("MODEL_UNAVAILABLE", "modelo de teste indisponível")
        if self.replies:
            r = self.replies.pop(0)
            return r(messages) if callable(r) else r
        return "Olá! Sou o JARVIS. Como posso ajudar?"

    async def health(self):
        return (True, None) if self.available else (False, "indisponível")


class FakeProvider:
    """Provedor de pesquisa falso: devolve resultados prontos, nunca acessa a rede."""

    def __init__(self, name, category="general", results=None, available=True, error=None):
        self.name, self.category, self.results = name, category, results or {}
        self._available, self.error, self.queries = available, error, []

    @property
    def available(self):
        return self._available

    async def search(self, query, limit=5, **opts):
        from knowledge.providers import SearchError
        from knowledge.ranking import SearchResult
        self.queries.append(query)
        if self.error:
            raise SearchError(self.name, self.error)
        for key, items in self.results.items():
            if key.lower() in query.lower():
                return [SearchResult(provider=self.name, category=self.category, **i) for i in items][:limit]
        return []


def install_offline(j, general_available=False, data=None):
    """Troca TODOS os provedores por falsos. data = {categoria: {trecho_da_query: [resultados]}}."""
    data = data or {}
    general = FakeProvider("fake_web", "general", data.get("GENERAL_WEB", {}), available=general_available)
    j.knowledge.general = general
    cats = {"WIKIPEDIA": "wikipedia", "GITHUB": "github", "ACADEMIC": "academic"}
    for c in list(j.knowledge.providers):
        if c in ("GENERAL_WEB", "NEWS"):
            j.knowledge.providers[c] = FakeProvider("fake_web", "general", data.get(c, data.get("GENERAL_WEB", {})),
                                                    available=general_available)
        elif c in cats:
            j.knowledge.providers[c] = FakeProvider(f"fake_{cats[c]}", cats[c], data.get(c, {}))
        else:
            j.knowledge.providers[c] = FakeProvider(f"fake_{c.lower()}", c.lower(), data.get(c, {}), available=general_available)
    return j.knowledge.providers


@pytest.fixture
def config(tmp_path) -> Config:
    return Config(database_path=tmp_path / "test.db", workspace_dir=tmp_path / "workspace",
                  log_path=tmp_path / "jarvis.log", model_provider="fake", user_name="José Marcelo")


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def jarvis(config, fake_llm):
    import asyncio

    from main import startup
    j = build_jarvis(config, llm=fake_llm)
    install_offline(j)      # testes nunca acessam a internet
    asyncio.run(startup(j))
    yield j
    j.db.close()


@pytest.fixture
def ask(jarvis):
    """ask('texto') -> BrainReply, mantendo a mesma conversa."""
    import asyncio
    state = {"conv": None}

    def _ask(text: str):
        reply = asyncio.run(jarvis.brain.handle(text, state["conv"]))
        state["conv"] = reply.conversation_id
        return reply
    return _ask


@pytest.fixture
def offline_search(jarvis):
    """Pesquisa 'configurada' (web geral disponível), mas sem resultados para nada — sem rede."""
    return install_offline(jarvis, general_available=True)
