"""
Montagem do contexto enviado ao modelo — só o que é relevante.

Camadas de memória (spec da fase 3):
- SHORT_TERM_MEMORY     → estado da conversa (assunto, última pesquisa) — Conversation Engine
- CONVERSATION_MEMORY   → resumo das partes antigas + mensagens recentes
- LONG_TERM_MEMORY      → fatos do usuário relevantes para ESTA mensagem (não a memória inteira)
- PROJECT_MEMORY        → projeto atual + memórias da categoria "projetos" relevantes
- KNOWLEDGE_MEMORY      → entra pelas ferramentas de conhecimento/pesquisa quando necessário

Compressão: quando a conversa cresce, as mensagens antigas viram um resumo
(gerado pelo modelo) guardado em conversations.summary.
"""
from __future__ import annotations

from datetime import datetime

from core.memory import ConversationStore, MemoryStore
from core.personality import Personality
from core.state import JarvisState
from models.llm import LLMError, Message

TOOL_PROTOCOL = """FERRAMENTAS
Você pode usar ferramentas. Para usar uma, responda SOMENTE com uma linha neste formato, sem mais nada:
TOOL_CALL {"tool": "<nome>", "args": {<argumentos>}}
Depois você recebe o resultado e responde ao usuário em linguagem natural. Pode encadear ferramentas (uma por vez).
Use ferramenta só quando necessário. Para fatos atuais (notícias, preços, lançamentos, "hoje"), use a ferramenta web.
Nunca invente o resultado de uma ferramenta.
Disponíveis:
"""

COMPRESS_AFTER = 24     # mensagens não resumidas antes de comprimir
KEEP_RECENT = 12        # mensagens recentes que sempre vão inteiras
MEMORY_BUDGET = 1800    # caracteres de memória de longo prazo no prompt


class ContextBuilder:
    def __init__(self, personality: Personality, memory: MemoryStore, conversations: ConversationStore,
                 state: JarvisState, registry, projects=None, history_limit: int = 12):
        self.personality = personality
        self.memory = memory
        self.conversations = conversations
        self.state = state
        self.registry = registry
        self.projects = projects
        self.history_limit = history_limit

    # ---------- camadas ----------
    def _situation(self, client: dict | None) -> str:
        client = client or {}
        lines = [f"- Data/hora do servidor: {datetime.now().strftime('%d/%m/%Y %H:%M')}"]
        if client.get("local_time"):
            lines.append(f"- Horário local do usuário: {client['local_time']}")
        if client.get("location"):
            lines.append(f"- Localização do usuário: {client['location']}")
        if client.get("weather"):
            lines.append(f"- Clima local: {client['weather']}")
        if client.get("voice"):
            lines.append("- O usuário está falando por VOZ: responda de forma ainda mais curta e falada.")
        if self.projects:
            p = self.projects.get_project(self.state.current_project)
            if p:
                doing = [m["title"] for m in p.get("milestones", []) if m["status"] == "in_progress"]
                lines.append(f"- Projeto atual: {p['name']} ({p['status']}, {p['progress']}% concluído"
                             + (f"; em andamento: {', '.join(doing)}" if doing else "") + ")")
        s = self.state
        lines.append(f"- Módulos: câmera={s.camera}, visão={s.vision_model}; voz via navegador")
        return "\n".join(lines)

    def _memories(self, message: str) -> str:
        """Só o relevante: busca pela mensagem + fatos-chave + preferências, dentro de um orçamento."""
        picked, seen = [], set()
        for m in (self.memory.search(message, limit=6)
                  + [m for m in self.memory.list("preferencias", 10)][:5]
                  + [m for m in self.memory.list(limit=60) if m.key][:8]):
            if m.id in seen:
                continue
            seen.add(m.id)
            picked.append(f"- [{m.category}] {m.content}")
        out, size = [], 0
        for line in picked:
            if size + len(line) > MEMORY_BUDGET:
                break
            out.append(line)
            size += len(line)
        return "\n".join(out) if out else "- (nada salvo ainda)"

    def system_prompt(self, message: str, client: dict | None, notes: list[str] | None = None, summary: str | None = None) -> str:
        parts = [
            self.personality.system_prompt(),
            f"SITUAÇÃO\n{self._situation(client)}",
            f"MEMÓRIA DE LONGO PRAZO (fatos salvos sobre o usuário, só os relevantes)\n{self._memories(message)}",
        ]
        if summary:
            parts.append(f"RESUMO DA CONVERSA ATÉ AQUI\n{summary}")
        if notes:
            parts.append("CONTEXTO DA CONVERSA (memória de curto prazo)\n" + "\n".join(f"- {n}" for n in notes if n))
        parts.append(TOOL_PROTOCOL + self.registry.catalog())
        return "\n\n".join(parts)

    # ---------- histórico ----------
    def _conv_meta(self, conversation_id: int) -> dict:
        try:
            return self.conversations.db.one("SELECT summary, summary_until FROM conversations WHERE id = ?", (conversation_id,)) or {}
        except Exception:
            return {}

    def build(self, message: str, conversation_id: int, client: dict | None = None, notes: list[str] | None = None) -> list[Message]:
        meta = self._conv_meta(conversation_id)
        until = meta.get("summary_until") or 0
        history = [h for h in self.conversations.history(conversation_id, limit=self.history_limit + 1) if h["id"] > until]
        past = [h for h in history[:-1] if h["role"] in ("user", "assistant") and h.get("route") not in ("error", "cancelled")]
        msgs: list[Message] = [Message("system", self.system_prompt(message, client, notes, meta.get("summary")))]
        for h in past + [{"role": "user", "content": message}]:
            if len(msgs) > 1 and msgs[-1].role == h["role"]:
                msgs[-1] = Message(h["role"], msgs[-1].content + "\n\n" + h["content"])
            else:
                msgs.append(Message(h["role"], h["content"]))
        if len(msgs) > 1 and msgs[1].role == "assistant":
            msgs.pop(1)
        return msgs

    async def compress(self, conversation_id: int, llm) -> bool:
        """Resume as mensagens antigas quando a conversa fica longa (economiza tempo e tokens)."""
        meta = self._conv_meta(conversation_id)
        until = meta.get("summary_until") or 0
        rows = [h for h in self.conversations.history(conversation_id, limit=400) if h["id"] > until]
        if len(rows) <= COMPRESS_AFTER:
            return False
        old = rows[:-KEEP_RECENT]
        transcript = "\n".join(f"{'Usuário' if h['role'] == 'user' else 'JARVIS'}: {h['content'][:600]}" for h in old)
        prompt = ("Resuma esta conversa em até 8 linhas objetivas, mantendo nomes, decisões, assuntos em aberto e preferências "
                  "que o usuário expressou. Texto simples.\n\n" + (f"RESUMO ANTERIOR:\n{meta['summary']}\n\n" if meta.get("summary") else "")
                  + "TRECHO:\n" + transcript)
        try:
            summary = (await llm.chat([Message("user", prompt)])).strip()
        except LLMError:
            return False
        self.conversations.db.execute("UPDATE conversations SET summary = ?, summary_until = ? WHERE id = ?",
                                      (summary[:4000], old[-1]["id"], conversation_id))
        return True
