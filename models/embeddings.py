"""
Embeddings (FASE futura — busca semântica na memória).

Hoje a memória busca por palavras-chave. Quando houver um provedor de
embeddings, `MemoryStore.search()` passa a usar `EmbeddingProvider.embed()`
sem mudar quem chama a busca.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class EmbeddingProvider(ABC):
    name = "none"

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]: ...

    def status(self) -> dict:
        return {"provider": self.name, "available": True}


class NoEmbeddings(EmbeddingProvider):
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("Embeddings ainda não configurados (disponível futuramente).")

    def status(self) -> dict:
        return {"provider": "none", "available": False, "note": "busca por palavras-chave ativa"}
