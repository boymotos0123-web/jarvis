"""
Abstração do modelo de linguagem.

O resto do JARVIS conversa só com `LLMProvider` (generate / chat / stream).
Trocar de provedor = mudar MODEL_PROVIDER no .env, sem tocar no código.

Provedores incluídos (HTTP puro, sem SDKs):
- openai      → API da OpenAI (e qualquer API compatível: groq, openrouter, lmstudio)
- ollama      → modelos locais via Ollama
- anthropic   → API da Anthropic
- none        → nenhum modelo: o JARVIS avisa que o modelo está indisponível
"""
from __future__ import annotations

import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator

import httpx

log = logging.getLogger("jarvis.llm")


@dataclass
class Message:
    role: str      # system | user | assistant
    content: str

    def to_dict(self) -> dict:
        return {"role": self.role, "content": self.content}


class LLMError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class LLMProvider(ABC):
    provider: str = "none"

    def __init__(self, model: str = "", temperature: float | None = None, max_tokens: int = 1024, timeout: float = 60):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout

    @abstractmethod
    async def chat(self, messages: list[Message]) -> str:
        """Recebe a conversa completa e devolve o texto da resposta."""

    async def generate(self, prompt: str, system: str | None = None) -> str:
        msgs = ([Message("system", system)] if system else []) + [Message("user", prompt)]
        return await self.chat(msgs)

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """Streaming. Padrão: entrega a resposta inteira de uma vez.
        Provedores podem sobrescrever para enviar pedaços conforme chegam."""
        yield await self.chat(messages)

    @abstractmethod
    async def health(self) -> tuple[bool, str | None]:
        """(disponível, mensagem de erro)"""

    # ---------- utilitários HTTP ----------
    def _raise_for(self, status: int, body: str) -> None:
        if status in (401, 403):
            raise LLMError("MODEL_AUTH_FAILED", "A chave da API foi recusada. Confira API_KEY no .env.")
        if status == 404:
            raise LLMError("MODEL_NOT_FOUND", f"Modelo '{self.model}' não encontrado no provedor. Confira MODEL_NAME.")
        if status == 429:
            raise LLMError("MODEL_RATE_LIMITED", "Limite de uso do provedor atingido (ou sem créditos). Tente mais tarde.")
        if status >= 400:
            raise LLMError("MODEL_ERROR", f"O provedor respondeu com erro {status}: {body[:300]}")

    async def _stream_lines(self, url: str, payload: dict, headers: dict) -> AsyncIterator[str]:
        """Faz POST com streaming e entrega as linhas da resposta."""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, read=self.timeout)) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as r:
                    if r.status_code >= 400:
                        body = (await r.aread()).decode(errors="replace")
                        self._raise_for(r.status_code, body)
                    async for line in r.aiter_lines():
                        if line:
                            yield line
        except httpx.TimeoutException:
            raise LLMError("MODEL_TIMEOUT", "O modelo demorou demais para responder.")
        except httpx.HTTPError as e:
            raise LLMError("MODEL_UNAVAILABLE", f"Não consegui conectar ao modelo ({e.__class__.__name__}).")

    async def _post(self, url: str, payload: dict, headers: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException:
            raise LLMError("MODEL_TIMEOUT", "O modelo demorou demais para responder.")
        except httpx.HTTPError as e:
            raise LLMError("MODEL_UNAVAILABLE", f"Não consegui conectar ao modelo ({e.__class__.__name__}).")
        if r.status_code == 401 or r.status_code == 403:
            raise LLMError("MODEL_AUTH_FAILED", "A chave da API foi recusada. Confira API_KEY no .env.")
        if r.status_code == 404:
            raise LLMError("MODEL_NOT_FOUND", f"Modelo '{self.model}' não encontrado no provedor. Confira MODEL_NAME.")
        if r.status_code == 429:
            raise LLMError("MODEL_RATE_LIMITED", "Limite de uso do provedor atingido (ou sem créditos). Tente mais tarde.")
        if r.status_code >= 400:
            detail = r.text[:300]
            raise LLMError("MODEL_ERROR", f"O provedor respondeu com erro {r.status_code}: {detail}")
        return r.json()


class NoModelProvider(LLMProvider):
    provider = "none"

    async def chat(self, messages: list[Message]) -> str:
        raise LLMError("MODEL_UNAVAILABLE", "Nenhum modelo de IA configurado. Defina MODEL_PROVIDER e MODEL_NAME no .env.")

    async def health(self) -> tuple[bool, str | None]:
        return False, "Nenhum modelo configurado (MODEL_PROVIDER=none)"


class OpenAICompatibleProvider(LLMProvider):
    """OpenAI e APIs compatíveis (/chat/completions)."""
    provider = "openai"
    DEFAULT_URLS = {
        "openai": "https://api.openai.com/v1",
        "groq": "https://api.groq.com/openai/v1",
        "openrouter": "https://openrouter.ai/api/v1",
        "lmstudio": "http://localhost:1234/v1",
    }

    def __init__(self, provider: str, api_key: str, base_url: str = "", **kw):
        super().__init__(**kw)
        self.provider = provider
        self.api_key = api_key
        self.base_url = (base_url or self.DEFAULT_URLS.get(provider, self.DEFAULT_URLS["openai"])).rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    async def chat(self, messages: list[Message]) -> str:
        payload: dict = {"model": self.model, "messages": [m.to_dict() for m in messages]}
        if self.temperature is not None:   # alguns modelos novos só aceitam a temperatura padrão
            payload["temperature"] = self.temperature
        data = await self._post(f"{self.base_url}/chat/completions", payload, self._headers())
        try:
            return (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError):
            raise LLMError("MODEL_BAD_RESPONSE", "Resposta do modelo em formato inesperado.")

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        payload: dict = {"model": self.model, "messages": [m.to_dict() for m in messages], "stream": True}
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        async for line in self._stream_lines(f"{self.base_url}/chat/completions", payload, self._headers()):
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                delta = json.loads(data)["choices"][0]["delta"].get("content")
            except (ValueError, KeyError, IndexError, TypeError):
                continue
            if delta:
                yield delta

    async def health(self) -> tuple[bool, str | None]:
        if self.provider != "lmstudio" and not self.api_key:
            return False, "API_KEY não definida no .env"
        if not self.model:
            return False, "MODEL_NAME não definido no .env"
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(f"{self.base_url}/models", headers=self._headers())
            if r.status_code in (401, 403):
                return False, "Chave da API recusada"
            if r.status_code >= 400:
                return False, f"Provedor respondeu {r.status_code}"
            return True, None
        except httpx.HTTPError as e:
            return False, f"Sem conexão com o provedor ({e.__class__.__name__})"


class OllamaProvider(LLMProvider):
    provider = "ollama"

    def __init__(self, base_url: str = "", **kw):
        super().__init__(**kw)
        self.base_url = (base_url or "http://localhost:11434").rstrip("/")

    async def chat(self, messages: list[Message]) -> str:
        payload: dict = {"model": self.model, "messages": [m.to_dict() for m in messages], "stream": False}
        if self.temperature is not None:
            payload["options"] = {"temperature": self.temperature}
        data = await self._post(f"{self.base_url}/api/chat", payload, {})
        try:
            return (data["message"]["content"] or "").strip()
        except (KeyError, TypeError):
            raise LLMError("MODEL_BAD_RESPONSE", "Resposta do Ollama em formato inesperado.")

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        payload: dict = {"model": self.model, "messages": [m.to_dict() for m in messages], "stream": True}
        if self.temperature is not None:
            payload["options"] = {"temperature": self.temperature}
        async for line in self._stream_lines(f"{self.base_url}/api/chat", payload, {}):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            piece = (obj.get("message") or {}).get("content")
            if piece:
                yield piece
            if obj.get("done"):
                break

    async def health(self) -> tuple[bool, str | None]:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(f"{self.base_url}/api/tags")
            names = [m.get("name", "") for m in r.json().get("models", [])]
            if not any(n == self.model or n.split(":")[0] == self.model for n in names):
                return False, f"Modelo '{self.model}' não baixado. Rode: ollama pull {self.model}"
            return True, None
        except (httpx.HTTPError, ValueError):
            return False, "Ollama não está rodando (http://localhost:11434)"


class AnthropicProvider(LLMProvider):
    provider = "anthropic"

    def __init__(self, api_key: str, base_url: str = "", **kw):
        super().__init__(**kw)
        self.api_key = api_key
        self.base_url = (base_url or "https://api.anthropic.com").rstrip("/")

    def _headers(self) -> dict:
        return {"x-api-key": self.api_key, "anthropic-version": "2023-06-01"}

    async def chat(self, messages: list[Message]) -> str:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        convo = [m.to_dict() for m in messages if m.role != "system"]
        payload: dict = {"model": self.model, "max_tokens": self.max_tokens, "messages": convo}
        if system:
            payload["system"] = system
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        data = await self._post(f"{self.base_url}/v1/messages", payload, self._headers())
        try:
            return "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text").strip()
        except (KeyError, TypeError):
            raise LLMError("MODEL_BAD_RESPONSE", "Resposta da Anthropic em formato inesperado.")

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        payload: dict = {"model": self.model, "max_tokens": self.max_tokens, "stream": True,
                         "messages": [m.to_dict() for m in messages if m.role != "system"]}
        if system:
            payload["system"] = system
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        async for line in self._stream_lines(f"{self.base_url}/v1/messages", payload, self._headers()):
            if not line.startswith("data:"):
                continue
            try:
                obj = json.loads(line[5:].strip())
            except ValueError:
                continue
            if obj.get("type") == "content_block_delta" and obj.get("delta", {}).get("type") == "text_delta":
                yield obj["delta"]["text"]
            elif obj.get("type") == "message_stop":
                break

    async def health(self) -> tuple[bool, str | None]:
        if not self.api_key:
            return False, "API_KEY não definida no .env"
        if not self.model:
            return False, "MODEL_NAME não definido no .env"
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(f"{self.base_url}/v1/models", headers=self._headers())
            if r.status_code in (401, 403):
                return False, "Chave da API recusada"
            return (r.status_code < 400), (None if r.status_code < 400 else f"Provedor respondeu {r.status_code}")
        except httpx.HTTPError as e:
            return False, f"Sem conexão com o provedor ({e.__class__.__name__})"


def create_provider(config) -> LLMProvider:
    """Fábrica: escolhe o provedor a partir do Config."""
    kw = dict(model=config.model_name, temperature=config.model_temperature,
              max_tokens=config.max_tokens, timeout=config.model_timeout)
    p = config.model_provider
    if p in OpenAICompatibleProvider.DEFAULT_URLS:
        return OpenAICompatibleProvider(p, config.api_key, config.model_base_url, **kw)
    if p == "ollama":
        return OllamaProvider(config.model_base_url, **kw)
    if p == "anthropic":
        return AnthropicProvider(config.api_key, config.model_base_url, **kw)
    if p not in ("", "none"):
        log.warning("MODEL_PROVIDER desconhecido: %s — usando 'none'", p)
    return NoModelProvider(**kw)


class HealthCache:
    """Evita bater no provedor a cada /api/status."""

    def __init__(self, provider: LLMProvider, ttl: float = 30):
        self.provider = provider
        self.ttl = ttl
        self._at = 0.0
        self._value: tuple[bool, str | None] = (False, "ainda não verificado")

    async def get(self, force: bool = False) -> tuple[bool, str | None]:
        if force or time.time() - self._at > self.ttl:
            self._value = await self.provider.health()
            self._at = time.time()
        return self._value
