"""Provedores de IA: formato das requisições, leitura das respostas e tradução de erros (HTTP simulado)."""
import asyncio
import json

import httpx
import pytest

from config import Config
from models.llm import (AnthropicProvider, LLMError, Message, NoModelProvider, OllamaProvider,
                        OpenAICompatibleProvider, create_provider)

MSGS = [Message("system", "Você é JARVIS."), Message("user", "Olá")]


@pytest.fixture
def http(monkeypatch):
    """Intercepta o httpx.AsyncClient: cada teste define `handler(request) -> Response`."""
    box = {"handler": None, "requests": []}
    real = httpx.AsyncClient

    def factory(*a, **kw):
        def route(req):
            box["requests"].append(req)
            return box["handler"](req)
        kw["transport"] = httpx.MockTransport(route)
        return real(*a, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return box


def run(coro):
    return asyncio.run(coro)


def test_fabrica_de_provedores():
    assert isinstance(create_provider(Config(model_provider="openai")), OpenAICompatibleProvider)
    groq = create_provider(Config(model_provider="groq"))
    assert groq.base_url == "https://api.groq.com/openai/v1"
    assert isinstance(create_provider(Config(model_provider="ollama")), OllamaProvider)
    assert isinstance(create_provider(Config(model_provider="anthropic")), AnthropicProvider)
    assert isinstance(create_provider(Config(model_provider="xyz")), NoModelProvider)


def test_openai_chat(http):
    http["handler"] = lambda r: httpx.Response(200, json={"choices": [{"message": {"content": " Olá, José! "}}]})
    p = OpenAICompatibleProvider("openai", "sk-test", model="modelo-x")
    assert run(p.chat(MSGS)) == "Olá, José!"
    req = http["requests"][0]
    body = json.loads(req.content)
    assert str(req.url) == "https://api.openai.com/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-test"
    assert body["model"] == "modelo-x" and body["messages"][0] == {"role": "system", "content": "Você é JARVIS."}
    assert "temperature" not in body           # só envia se configurado


@pytest.mark.parametrize("status,code", [(401, "MODEL_AUTH_FAILED"), (404, "MODEL_NOT_FOUND"), (429, "MODEL_RATE_LIMITED"), (500, "MODEL_ERROR")])
def test_openai_erros(http, status, code):
    http["handler"] = lambda r: httpx.Response(status, text="erro")
    with pytest.raises(LLMError) as e:
        run(OpenAICompatibleProvider("openai", "k", model="m").chat(MSGS))
    assert e.value.code == code


def test_sem_conexao(http):
    def boom(r):
        raise httpx.ConnectError("recusado")
    http["handler"] = boom
    with pytest.raises(LLMError) as e:
        run(OllamaProvider(model="llama3.2").chat(MSGS))
    assert e.value.code == "MODEL_UNAVAILABLE"


def test_ollama_chat_e_health(http):
    def handler(r):
        if r.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "llama3.2:latest"}]})
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "Oi!"}})
    http["handler"] = handler
    p = OllamaProvider(model="llama3.2")
    assert run(p.chat(MSGS)) == "Oi!"
    assert json.loads(http["requests"][0].content)["stream"] is False
    assert run(p.health()) == (True, None)
    assert run(OllamaProvider(model="qwen").health())[0] is False


def test_anthropic_separa_system(http):
    http["handler"] = lambda r: httpx.Response(200, json={"content": [{"type": "text", "text": "Olá!"}]})
    p = AnthropicProvider("sk-ant", model="claude-x")
    assert run(p.chat(MSGS)) == "Olá!"
    req = http["requests"][0]
    body = json.loads(req.content)
    assert req.headers["x-api-key"] == "sk-ant"
    assert body["system"] == "Você é JARVIS." and body["messages"] == [{"role": "user", "content": "Olá"}]


def test_health_sem_chave():
    ok, err = run(OpenAICompatibleProvider("openai", "", model="m").health())
    assert not ok and "API_KEY" in err
