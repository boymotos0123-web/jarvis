"""
Ferramenta de memória: salvar, lembrar, listar e esquecer fatos do usuário.

Entende frases naturais como:
  "Meu projeto atual é o JARVIS."      → salva (chave: "projeto atual")
  "Lembre que eu acordo às 6h."        → salva nota
  "Qual é meu projeto atual?"          → consulta
  "O que você sabe sobre mim?"         → lista
  "Esqueça meu projeto atual"          → apaga (pede confirmação)
"""
from __future__ import annotations

import re

from core.memory import CATEGORIES, MemoryStore, normalize_key, strip_accents
from core.permissions import Risk
from tools import Tool, ToolError, ToolResult

_POSS = {"meu": "seu", "minha": "sua", "meus": "seus", "minhas": "suas"}
_VERB = r"(?:é|e|eh|são|sao)"

_SAVE_CMD = re.compile(r"^(?:jarvis[,\s]+)?(?:lembre(?:-se)?|lembra|anote|anota|guarde|guarda|salve|salva|memorize|grave)\s+(?:que\s+|de\s+que\s+|isso:?\s*)?(.+)$", re.I)
_STATEMENT = re.compile(rf"^(?:jarvis[,\s]+)?(?:o\s+|a\s+)?(meu|minha|meus|minhas)\s+(.{{2,40}}?)\s+{_VERB}\s+(.+?)[.!]*$", re.I)
_MORO = re.compile(r"^(?:jarvis[,\s]+)?eu\s+moro\s+(?:em|no|na|nos|nas)\s+(.+?)[.!]*$", re.I)
_NOME = re.compile(r"^(?:jarvis[,\s]+)?(?:me\s+chamo|pode\s+me\s+chamar\s+de|me\s+chame\s+de)\s+(.+?)[.!]*$", re.I)
_GOSTO = re.compile(r"^(?:jarvis[,\s]+)?eu\s+(gosto|adoro|amo|prefiro|odeio|não gosto|nao gosto)\s+(?:de\s+|da\s+|do\s+)?(.+?)[.!]*$", re.I)
_RECALL = re.compile(rf"^(?:jarvis[,\s]+)?(?:qual|quais)\s+{_VERB}\s+(?:o\s+|a\s+|os\s+|as\s+)?(meu|minha|meus|minhas)\s+(.+?)\s*\??$", re.I)
_WHERE = re.compile(r"^(?:jarvis[,\s]+)?onde\s+(?:é\s+que\s+)?eu\s+moro\s*\??$", re.I)
_MYNAME = re.compile(r"^(?:jarvis[,\s]+)?(?:como\s+(?:eu\s+)?me\s+chamo|como\s+prefiro\s+ser\s+chamado)\s*\??$", re.I)
_LIST = re.compile(r"o\s+que\s+(?:voc[eê]|vc)\s+(?:sabe|lembra)\s+(?:sobre|de)\s+mim|(?:liste|mostre|mostra)\s+(?:as\s+)?(?:suas\s+|minhas\s+)?mem[oó]rias", re.I)
_FORGET = re.compile(r"^(?:jarvis[,\s]+)?(?:esque[cç]a|esquece)\s+(?:que\s+|o\s+|a\s+)?(?:(meu|minha|meus|minhas)\s+)?(.+?)[.!]*$", re.I)

_REF_ONLY = re.compile(r"(isso|isto|essa informacao|esta informacao|essa info|o que eu disse|o que eu falei|essa memoria|essa nota|disso)")

_CATEGORY_HINTS = [
    ("projetos", ("projeto", "startup", "produto", "empresa", "jarvis", "app", "site", "loja", "marca")),
    ("preferencias", ("gosto", "prefer", "favorit", "cor", "comida", "musica", "time", "filme", "odeio", "adoro")),
    ("conhecimento", ("aprendi", "estudo", "sei ", "curso", "linguagem")),
]


def guess_category(text: str) -> str:
    t = strip_accents(text.lower())
    for cat, hints in _CATEGORY_HINTS:
        if any(h in t for h in hints):
            return cat
    return "pessoal"


def to_second_person(text: str) -> str:
    """'Meu projeto atual é o JARVIS.' -> 'Seu projeto atual é o JARVIS.'"""
    rules = [(r"^meu\b", "Seu"), (r"^minha\b", "Sua"), (r"^meus\b", "Seus"), (r"^minhas\b", "Suas"),
             (r"^eu moro\b", "Você mora"), (r"^eu gosto\b", "Você gosta"), (r"^eu adoro\b", "Você adora"),
             (r"^eu amo\b", "Você ama"), (r"^eu prefiro\b", "Você prefere"), (r"^eu odeio\b", "Você odeia"),
             (r"^eu n[aã]o gosto\b", "Você não gosta"), (r"^me chamo\b", "Você se chama")]
    for pat, rep in rules:
        new = re.sub(pat, rep, text, count=1, flags=re.I)
        if new != text:
            return new
    return text


def _sentence(text: str) -> str:
    text = text.strip().rstrip(".!")
    return text[:1].upper() + text[1:] + "."


class MemoryTool(Tool):
    name = "memory"
    description = "Memória de longo prazo do usuário: salvar, consultar, listar ou esquecer fatos."
    parameters = {
        "action": {"type": "string", "required": True, "enum": ["save", "recall", "list", "forget"]},
        "content": {"type": "string", "description": "frase a salvar (save)"},
        "key": {"type": "string", "description": "assunto do fato, ex.: 'projeto atual'"},
        "category": {"type": "string", "enum": list(CATEGORIES)},
        "possessive": {"type": "string", "enum": ["meu", "minha", "meus", "minhas"], "default": "meu"},
    }
    priority = 20

    def __init__(self, store: MemoryStore):
        self.store = store
        self.last_saved_id: int | None = None   # "esquece essa informação" → a última coisa salva

    # ---------- roteamento por linguagem natural ----------
    def match(self, text: str) -> dict | None:
        t = text.strip()
        if _LIST.search(t):
            return {"action": "list"}
        if (m := _WHERE.match(t)):
            return {"action": "recall", "key": "cidade onde mora", "possessive": "minha"}
        if _MYNAME.match(t):
            return {"action": "recall", "key": "nome", "possessive": "meu"}
        if (m := _RECALL.match(t)):
            return {"action": "recall", "key": m.group(2), "possessive": m.group(1).lower()}
        if t.endswith("?"):
            return None
        if (m := _FORGET.match(t)):
            return {"action": "forget", "key": m.group(2), "possessive": (m.group(1) or "meu").lower()}
        if (m := _SAVE_CMD.match(t)):
            inner = m.group(1).strip()
            return self._statement_args(inner) or {"action": "save", "content": _sentence(inner), "category": guess_category(inner)}
        return self._statement_args(t)

    def _statement_args(self, t: str) -> dict | None:
        if (m := _STATEMENT.match(t)):
            key = m.group(2).strip()
            if len(key.split()) > 5:
                return None
            return {"action": "save", "key": key, "content": _sentence(t), "category": guess_category(key + " " + m.group(3))}
        if (m := _MORO.match(t)):
            return {"action": "save", "key": "cidade onde mora", "content": _sentence(t), "category": "pessoal"}
        if (m := _NOME.match(t)):
            return {"action": "save", "key": "nome", "content": _sentence(t), "category": "pessoal"}
        if (m := _GOSTO.match(t)):
            return {"action": "save", "content": _sentence(t), "category": "preferencias"}
        return None

    def risk_for(self, args: dict) -> Risk:
        return Risk.HIGH if args.get("action") == "forget" else Risk.LOW   # apagar memória é irreversível

    def _target(self, key: str):
        if _REF_ONLY.fullmatch(normalize_key(key or "")) and self.last_saved_id:
            return self.store.get(self.last_saved_id)
        return self.store.recall(key)

    def describe(self, args: dict) -> str:
        if args.get("action") == "forget":
            hit = self._target(args.get("key", ""))
            return f"apagar da memória: “{hit.content}”" if hit else f"apagar da memória o que sei sobre {args.get('key')}"
        return super().describe(args)

    # ---------- execução ----------
    def execute(self, action: str, content: str = "", key: str = "", category: str = "", possessive: str = "meu") -> ToolResult:
        if action == "save":
            if not content:
                raise ToolError("INVALID_ARGS", "Nada para salvar.")
            mem = self.store.remember(content, category or guess_category(content), key or None)
            self.last_saved_id = mem.id
            conv = to_second_person(mem.content)
            return ToolResult(True, f"Anotado. {conv}" if conv != mem.content else f"Anotado: “{mem.content}”",
                              {"memory": mem.to_dict(), "memory_changed": True})

        if action == "recall":
            if not key:
                raise ToolError("INVALID_ARGS", "Informe o que devo lembrar.")
            mem = self.store.recall(key)
            if mem:
                return ToolResult(True, to_second_person(mem.content), {"memory": mem.to_dict()})
            poss = _POSS.get(possessive, "seu")
            return ToolResult(True, f"Ainda não sei qual é {poss} {normalize_key(key)}. Se quiser, me conte e eu guardo.",
                              {"memory": None})

        if action == "list":
            items = self.store.list(limit=15)
            if not items:
                return ToolResult(True, "Ainda não tenho nada salvo sobre você.", {"items": []})
            lines = "\n".join(f"• {to_second_person(m.content)}" for m in items)
            return ToolResult(True, f"Isto é o que tenho guardado:\n{lines}", {"items": [m.to_dict() for m in items]})

        if action == "forget":
            mem = self._target(key)
            if not mem:
                return ToolResult(True, f"Não encontrei nada sobre “{key}” na memória.", {})
            self.store.forget(mem.id)
            return ToolResult(True, f"Pronto, esqueci: “{mem.content}”", {"forgotten": mem.id, "memory_changed": True})

        raise ToolError("INVALID_ARGS", f"Ação desconhecida: {action}")
