"""
CONVERSATION ENGINE — continuidade da conversa.

Mantém, por conversa, a "memória de trabalho" (memória de curto prazo):
assunto atual, pilha de assuntos anteriores, última pesquisa, últimas fontes,
última resposta e última rota. Com isso:

- entende referências: "isso", "ele", "aquele projeto", "a outra opção"...
- reconhece comandos de conversa: para, cancela, continua, volta, repete,
  explica melhor, fala de outro jeito, resume;
- reescreve a mensagem como pergunta independente para as ferramentas
  ("quem criou isso?" → "quem criou armadura Mark III?");
- gera uma nota de contexto curta para o modelo.

Não chama o modelo: é rápido e determinístico. O modelo recebe o histórico
e esta nota, e faz o resto da interpretação.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from enum import Enum

from core.memory import strip_accents

_VOC = r"^(?:ok[,\s]+|e\s+a[ií][,\s]+)?(?:jarvis[,!.\s]+)?"


class Command(str, Enum):
    NONE = "none"
    STOP = "stop"               # para / espera
    CANCEL = "cancel"           # cancela / esquece
    CONTINUE = "continue"       # continua
    BACK = "back"               # volta ao assunto anterior
    REPEAT = "repeat"           # repete
    EXPLAIN_MORE = "explain"    # explica melhor
    REPHRASE = "rephrase"       # de outro jeito / mais simples
    SUMMARIZE = "summarize"     # resume isso


_COMMANDS: list[tuple[Command, re.Pattern]] = [
    (Command.STOP, re.compile(_VOC + r"(?:para|pare|parar|espera|espere|peraí|perai|silencio|chega|stop|calma|um momento)[.!]*$")),
    (Command.CANCEL, re.compile(_VOC + r"(?:cancela|cancele|cancelar|esquece|esqueca|deixa\s+pra\s+la|deixa\s+quieto|deixa)[.!]*$")),
    (Command.CONTINUE, re.compile(_VOC + r"(?:continua|continue|continuar|pode\s+continuar|segue|siga|prossiga|vai\s+em\s+frente|e\s+ai)[.!?]*$")),
    (Command.BACK, re.compile(_VOC + r"(?:volta|voltar|volte|volta\s+(?:pro|para\s+o|ao)\s+(?:assunto\s+)?anterior|o\s+anterior|a\s+anterior)[.!]*$")),
    (Command.REPEAT, re.compile(_VOC + r"(?:repete|repita|repetir|fala\s+de\s+novo|diz\s+de\s+novo|o\s+que\s+(?:voce|vc)\s+disse)[.!?]*$")),
    (Command.EXPLAIN_MORE, re.compile(_VOC + r"(?:me\s+)?(?:explica|explique|detalha|detalhe|aprofunda|aprofunde)\s*(?:melhor|mais|isso|isso\s+melhor)?[.!?]*$|^(?:jarvis[,\s]+)?(?:como\s+assim|mais\s+detalhes)[.!?]*$")),
    (Command.REPHRASE, re.compile(_VOC + r"(?:(?:fala|diz|explica|explique)\s+de\s+outro\s+jeito|reformula|reformule|simplifica|simplifique|mais\s+simples)[.!?]*$")),
    (Command.SUMMARIZE, re.compile(_VOC + r"(?:resume|resuma|resumir|faz\s+um\s+resumo)(?:\s+isso|\s+tudo)?[.!?]*$")),
]

# palavras que apontam para algo dito antes
_REFERENCE = re.compile(
    r"\b(isso|isto|aquilo|nisso|disso|daquilo|ele|ela|eles|elas|dele|dela|deles|delas|nele|nela|"
    r"esse|essa|esses|essas|desse|dessa|nesse|nessa|aquele|aquela|daquele|daquela|naquele|naquela|"
    r"o\s+mesmo|a\s+mesma|o\s+outro|a\s+outra|essa\s+parte|esse\s+projeto|aquele\s+projeto|a\s+outra\s+op[cç][aã]o)\b",
    re.I,
)
_OTHER_OPTION = re.compile(r"\b(n[aã]o[,\s]+)?(a\s+outra\s+op[cç][aã]o|o\s+outro|a\s+outra)\b", re.I)

# começo de pergunta/comando que não faz parte do assunto
_LEAD = re.compile(
    r"^(?:jarvis[,!.\s]+)?(?:me\s+(?:fala|fale|conta|conte|explica|explique|diz|diga)\s+(?:sobre|do|da|de|o\s+que\s+[eé])?\s*|"
    r"(?:pesquis[ae]r?|procur[ae]r?|busc[ae]r?)\s+(?:na\s+(?:web|internet)\s+)?(?:sobre\s+|por\s+|tudo\s+sobre\s+)?|"
    r"(?:quem|o\s+que|qual|quais|quando|onde|como|por\s+que|porque)\s+(?:[eé]|s[aã]o|foi|foram|era|eram|criou|fez|inventou)?\s*|"
    r"(?:explica|explique|resuma|resume|compare|compara)\s+)",
    re.I,
)
# "dele" → "de <assunto>", "nisso" → "em <assunto>"...
_CONTRACTIONS = {"dele": "de", "dela": "de", "deles": "de", "delas": "de", "disso": "de", "disto": "de", "daquilo": "de",
                 "desse": "de", "dessa": "de", "daquele": "de", "daquela": "de", "nele": "em", "nela": "em", "nisso": "em",
                 "nesse": "em", "nessa": "em", "naquele": "em", "naquela": "em"}
# palavras que, sozinhas, não dizem O QUE pesquisar ("pesquise as informações mais recentes")
_VAGUE = {"a", "o", "as", "os", "de", "do", "da", "dos", "das", "sobre", "isso", "isto", "ele", "ela", "mais", "informacao",
          "informacoes", "info", "infos", "recente", "recentes", "ultima", "ultimas", "ultimo", "ultimos", "novidade",
          "novidades", "noticia", "noticias", "atualizacao", "atualizacoes", "atual", "atuais", "dados", "tudo", "coisas",
          "nova", "novas", "novo", "novos", "agora", "hoje", "disso", "dele", "dela", "a respeito", "respeito", "na", "no",
          "web", "internet", "pra", "mim", "me", "por", "favor"}
_STOP_TOPIC = {"isso", "isto", "aquilo", "ele", "ela", "voce", "você", "eu", "me", "mim", "ok", "sim", "nao", "não", "obrigado", "valeu"}


@dataclass
class ConversationState:
    topic: str | None = None
    topic_stack: list[str] = field(default_factory=list)
    last_user: str = ""
    last_answer: str = ""
    last_query: str | None = None
    last_sources: list[dict] = field(default_factory=list)
    last_route: str | None = None
    last_tool: str | None = None
    last_options: list[str] = field(default_factory=list)   # opções enumeradas na última resposta


@dataclass
class TurnAnalysis:
    text: str
    command: Command = Command.NONE
    is_followup: bool = False
    references: list[str] = field(default_factory=list)
    topic: str | None = None
    standalone: str = ""            # mensagem reescrita sem referências (para ferramentas/pesquisa)
    note: str = ""                  # nota de contexto para o modelo


def _norm(text: str) -> str:
    return strip_accents(text.lower()).strip()


def extract_topic(text: str) -> str | None:
    """'Pesquise a evolução das armaduras do Tony Stark' -> 'a evolução das armaduras do Tony Stark'."""
    t = text.strip().rstrip("?!.")
    t = re.sub(r"^(?:jarvis[,!.\s]+)", "", t, flags=re.I)
    t = _LEAD.sub("", t, count=1).strip(" ,")
    words = t.split()
    if not words or len(words) > 12:
        words = words[:12]
    topic = " ".join(words).strip()
    if not topic or _norm(topic) in _STOP_TOPIC or len(topic) < 3 or _REFERENCE.fullmatch(topic):
        return None
    return topic


def extract_options(answer: str) -> list[str]:
    """Pega opções enumeradas ('1. X', 'Opção A: Y', '- Z') para entender 'a outra opção'."""
    opts = re.findall(r"(?:^|\n)\s*(?:\d+[.)]|op[cç][aã]o\s+\w+:|[-•])\s*(.{3,80})", answer, flags=re.I)
    return [o.strip() for o in opts][:6]


class ConversationEngine:
    def __init__(self, db=None):
        self.db = db
        self._states: dict[int, ConversationState] = {}
        self._lock = threading.Lock()

    def state(self, conversation_id: int) -> ConversationState:
        with self._lock:
            st = self._states.get(conversation_id)
            if st is None:
                st = ConversationState()
                if self.db is not None:   # recupera o assunto salvo (sobrevive a reinícios)
                    row = self.db.one("SELECT topic FROM conversations WHERE id = ?", (conversation_id,))
                    if row and row.get("topic"):
                        st.topic = row["topic"]
                self._states[conversation_id] = st
            return st

    # ------------------------------------------------------------------
    @staticmethod
    def classify_command(text: str) -> Command:
        t = _norm(text)
        for cmd, rx in _COMMANDS:
            if rx.match(t):
                return cmd
        return Command.NONE

    def analyze(self, conversation_id: int, text: str) -> TurnAnalysis:
        st = self.state(conversation_id)
        a = TurnAnalysis(text=text, standalone=text)
        a.command = self.classify_command(text)
        refs = [m.group(0) for m in _REFERENCE.finditer(text)]
        a.references = refs
        a.is_followup = bool(refs) and st.topic is not None
        a.topic = st.topic

        if a.is_followup:
            a.standalone = self._substitute(text, refs[0], st)
        notes = []
        if st.topic:
            notes.append(f"Assunto atual da conversa: {st.topic}.")
        if st.last_query:
            notes.append(f"Última pesquisa feita: “{st.last_query}”.")
        if a.is_followup:
            notes.append(f"A mensagem usa “{refs[0]}”, que provavelmente se refere a: {self._referent(refs[0], st)}.")
        if a.command == Command.BACK and st.topic_stack:
            notes.append(f"O usuário quer voltar ao assunto anterior: {st.topic_stack[-1]}.")
        a.note = " ".join(notes)
        return a

    @staticmethod
    def _referent(ref: str, st: ConversationState) -> str:
        if _OTHER_OPTION.search(ref) and len(st.last_options) > 1:
            return f"uma das outras opções citadas antes ({'; '.join(st.last_options)})"
        return st.topic or "o assunto anterior"

    def _substitute(self, text: str, ref: str, st: ConversationState) -> str:
        """Troca a primeira referência pelo assunto, para virar uma pergunta independente."""
        if _OTHER_OPTION.search(ref) and len(st.last_options) > 1:
            return text   # "a outra opção" fica para o modelo resolver com a lista de opções
        target = st.topic or ""
        if not target:
            return text
        prep = _CONTRACTIONS.get(_norm(ref))
        return re.sub(r"\b" + re.escape(ref) + r"\b", f"{prep} {target}" if prep else target, text, count=1, flags=re.I)

    def contextualize_query(self, conversation_id: int, query: str) -> tuple[str, bool]:
        """'as informações mais recentes' → 'as informações mais recentes sobre <assunto>'. Retorna (query, mudou?)."""
        st = self.state(conversation_id)
        words = re.findall(r"[a-z0-9]+", _norm(query))
        if st.topic and words and all(w in _VAGUE for w in words):
            return f"{query.strip()} sobre {st.topic}", True
        return query, False

    # ------------------------------------------------------------------
    def record(self, conversation_id: int, user_text: str, answer: str, route: str | None,
               tool: str | None = None, query: str | None = None, sources: list[dict] | None = None,
               topic: str | None = None, analysis: TurnAnalysis | None = None) -> ConversationState:
        st = self.state(conversation_id)
        new_topic = topic or query
        if not new_topic and analysis is not None and analysis.command == Command.NONE and not analysis.is_followup:
            new_topic = extract_topic(user_text)
        if analysis is not None and analysis.command == Command.BACK and st.topic_stack:
            new_topic = st.topic_stack.pop()
            st.topic = new_topic
        elif new_topic and new_topic != st.topic:
            if st.topic:
                st.topic_stack.append(st.topic)
                st.topic_stack[:] = st.topic_stack[-5:]
            st.topic = new_topic
        st.last_user = user_text
        if answer and route not in ("error", "cancelled"):
            st.last_answer = answer
            st.last_options = extract_options(answer) or st.last_options
        st.last_route, st.last_tool = route, tool
        if query:
            st.last_query = query
        if sources is not None:
            st.last_sources = sources
        if self.db is not None and st.topic:
            self.db.execute("UPDATE conversations SET topic = ? WHERE id = ?", (st.topic[:200], conversation_id))
        return st

    # instrução extra para o modelo, conforme o comando
    @staticmethod
    def command_instruction(cmd: Command) -> str | None:
        return {
            Command.CONTINUE: "Continue a sua resposta anterior de onde parou, sem repetir o que já disse.",
            Command.EXPLAIN_MORE: "Explique melhor a sua última resposta, com mais detalhes e um exemplo concreto.",
            Command.REPHRASE: "Reformule a sua última resposta de um jeito mais simples e direto.",
            Command.SUMMARIZE: "Resuma a sua última resposta (ou o assunto atual) em 2 ou 3 frases.",
            Command.BACK: "Retome o assunto anterior indicado no contexto.",
        }.get(cmd)
