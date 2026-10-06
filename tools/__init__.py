"""
Ferramentas do JARVIS.

Cada ferramenta é independente e declara: nome, descrição, parâmetros,
risco, validação, execução e (opcional) padrões de linguagem natural que o
Router usa para acioná-la sem precisar do modelo de IA.
"""
from __future__ import annotations

import inspect
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from core.permissions import Risk

log = logging.getLogger("jarvis.tools")


@dataclass
class ToolResult:
    ok: bool
    message: str                          # texto pronto para o usuário (pt-BR)
    data: dict[str, Any] = field(default_factory=dict)
    summarize: bool = False               # True = o modelo deve redigir a resposta final a partir de `data`
    error_code: str | None = None

    @classmethod
    def fail(cls, code: str, message: str, **data) -> "ToolResult":
        return cls(ok=False, message=message, data=data, error_code=code)

    def to_dict(self) -> dict:
        return {"ok": self.ok, "message": self.message, "data": self.data, "error_code": self.error_code}


class ToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Tool(ABC):
    name: str = ""
    description: str = ""
    parameters: dict[str, dict] = {}      # {"arg": {"type": "string", "required": True, "description": "..."}}
    risk: Risk = Risk.LOW
    priority: int = 100                   # ordem de checagem no Router (menor = primeiro)

    def match(self, text: str) -> dict | None:
        """Retorna argumentos se a frase claramente pede esta ferramenta; senão None."""
        return None

    def risk_for(self, args: dict) -> Risk:
        return self.risk

    def describe(self, args: dict) -> str:
        """Descrição humana da ação (usada no pedido de confirmação)."""
        return f"usar a ferramenta {self.name}"

    def validate(self, args: dict) -> dict:
        clean: dict[str, Any] = {}
        for name, spec in self.parameters.items():
            if name not in args or args[name] in (None, ""):
                if spec.get("required"):
                    raise ToolError("INVALID_ARGS", f"Parâmetro obrigatório ausente: {name}")
                if "default" in spec:
                    clean[name] = spec["default"]
                continue
            value = args[name]
            kind = spec.get("type", "string")
            if kind == "string" and not isinstance(value, str):
                value = str(value)
            elif kind == "integer":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    raise ToolError("INVALID_ARGS", f"{name} deve ser um número inteiro")
            if "enum" in spec and value not in spec["enum"]:
                raise ToolError("INVALID_ARGS", f"{name} deve ser um de: {', '.join(spec['enum'])}")
            clean[name] = value
        return clean

    @abstractmethod
    def execute(self, **args) -> ToolResult: ...

    def spec(self) -> dict:
        return {"name": self.name, "description": self.description, "risk": self.risk.value, "parameters": self.parameters}


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> Tool:
        if not tool.name:
            raise ValueError("ferramenta sem nome")
        self._tools[tool.name] = tool
        return tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return sorted(self._tools.values(), key=lambda t: t.priority)

    def names(self) -> list[str]:
        return [t.name for t in self.all()]

    def catalog(self) -> str:
        """Texto com as ferramentas, para o prompt do modelo."""
        lines = []
        for t in self.all():
            params = ", ".join(
                f"{n}{'' if s.get('required') else '?'}: {s.get('type', 'string')}"
                + (f" ({'|'.join(s['enum'])})" if "enum" in s else "")
                for n, s in t.parameters.items()
            )
            lines.append(f"- {t.name}({params}) [risco {t.risk.value}]: {t.description}")
        return "\n".join(lines)

    async def arun(self, name: str, args: dict) -> ToolResult:
        """Executa ferramentas síncronas ou assíncronas (pesquisa web, deep research)."""
        tool = self.get(name)
        if not tool:
            return ToolResult.fail("TOOL_NOT_FOUND", f"Ferramenta desconhecida: {name}")
        try:
            clean = tool.validate(args or {})
            result = tool.execute(**clean)
            if inspect.isawaitable(result):
                result = await result
            log.info("ferramenta %s -> %s", name, "ok" if result.ok else result.error_code)
            return result
        except ToolError as e:
            log.info("ferramenta %s recusou: %s", name, e.code)
            return ToolResult.fail(e.code, e.message)
        except Exception as e:
            log.exception("ferramenta %s falhou", name)
            return ToolResult.fail("TOOL_FAILED", f"A ferramenta {name} falhou: {e}")

    def run(self, name: str, args: dict) -> ToolResult:
        tool = self.get(name)
        if not tool:
            return ToolResult.fail("TOOL_NOT_FOUND", f"Ferramenta desconhecida: {name}")
        try:
            clean = tool.validate(args or {})
            result = tool.execute(**clean)
            log.info("ferramenta %s -> %s", name, "ok" if result.ok else result.error_code)
            return result
        except ToolError as e:
            log.info("ferramenta %s recusou: %s", name, e.code)
            return ToolResult.fail(e.code, e.message)
        except Exception as e:  # nunca deixar uma ferramenta derrubar o núcleo
            log.exception("ferramenta %s falhou", name)
            return ToolResult.fail("TOOL_FAILED", f"A ferramenta {name} falhou: {e}")
