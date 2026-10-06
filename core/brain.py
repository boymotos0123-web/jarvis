"""
BRAIN — orquestrador do JARVIS (fase 3: conversa natural + streaming + conhecimento).

Fluxo de uma mensagem:
  USUÁRIO → CONVERSATION ENGINE (comandos, referências, assunto)
          → confirmação pendente? → comando (para/continua/repete...)?
          → tarefa de várias etapas? → PLANNER
          → ROUTER (ferramenta) ou KNOWLEDGE ENGINE (base local / pesquisa automática)
          → MODELO com streaming (pode pedir ferramentas)
          → RESPOSTA + FONTES → histórico, eventos, métricas → INTERFACE

`handle_stream()` entrega eventos em tempo real:
  start · state · delta · sources · tool · step · confirm · done (e error)
`handle()` é a versão de uma resposta só (usada pela CLI e pelos testes).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable

from core.context import ContextBuilder
from core.conversation import Command, ConversationEngine, TurnAnalysis
from core.events import EventBus, EventType
from core.memory import ConversationStore, strip_accents
from core.metrics import MetricsRecorder, RequestMetrics
from core.permissions import Decision, PermissionManager
from core.planner import is_multistep, make_plan
from core.router import Router
from core.state import JarvisState, Phase
from models.llm import LLMError, LLMProvider, Message
from tools import ToolRegistry, ToolResult

log = logging.getLogger("jarvis.brain")
Sink = Callable[[dict], Awaitable[None]]

NO_MODEL_HINT = ("\nMesmo sem o modelo, já consigo: fazer cálculos, guardar e consultar memórias, responder pela base de "
                 "conhecimento, pesquisar fontes, ler arquivos da pasta de trabalho e mostrar o status do sistema.")
_QUESTION = re.compile(r"\?\s*$|^(?:jarvis[,\s]+)?(quem|o que|qual|quais|quando|onde|como|por que|quanto|existe|tem)\b", re.I)
_KNOWLEDGE_CUE = re.compile(r"\b(mcu|quadrinhos?|hqs?|universo|vers[aã]o|vers[oõ]es|armadura|traje|criou|criado|inventou|"
                            r"primeir[oa]|depois|diferen[cç]a|rela[cç][aã]o|filme|filmes|anima[cç][aã]o|jogo)\b", re.I)
SEARCH_TOOLS = {"web", "research"}


@dataclass
class BrainReply:
    text: str
    conversation_id: int
    route: str = "llm"                 # llm | tool | confirm | cancelled | command | plan | error
    tool: str | None = None
    pending: dict | None = None
    error: dict | None = None
    message_id: int | None = None
    data: dict = field(default_factory=dict)
    sources: list[dict] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"reply": self.text, "conversation_id": self.conversation_id, "message_id": self.message_id,
                "route": {"type": self.route, "tool": self.tool}, "pending_confirmation": self.pending,
                "sources": self.sources, "tools_used": self.tools_used}


class Brain:
    MAX_TOOL_ROUNDS = 5

    def __init__(self, llm: LLMProvider, router: Router, context: ContextBuilder, tools: ToolRegistry,
                 permissions: PermissionManager, conversations: ConversationStore, events: EventBus, state: JarvisState,
                 conversation: ConversationEngine | None = None, knowledge=None, metrics: MetricsRecorder | None = None):
        self.llm = llm
        self.router = router
        self.context = context
        self.tools = tools
        self.permissions = permissions
        self.conversations = conversations
        self.events = events
        self.state = state
        self.conversation = conversation or ConversationEngine(getattr(conversations, "db", None))
        self.knowledge = knowledge
        self.metrics = metrics
        self._tasks: dict[int, asyncio.Task] = {}

    # ==================================================================
    # Entradas públicas
    # ==================================================================
    async def handle(self, text: str, conversation_id: int | None = None, client: dict | None = None) -> BrainReply:
        reply = None
        async for ev in self.handle_stream(text, conversation_id, client):
            if ev["event"] == "done":
                reply = ev["_reply"]
        return reply

    async def handle_stream(self, text: str, conversation_id: int | None = None, client: dict | None = None) -> AsyncIterator[dict]:
        text = (text or "").strip()
        if not text:
            raise ValueError("Mensagem vazia.")
        if not conversation_id or not self.conversations.exists(conversation_id):
            conversation_id = self.conversations.create()
        conv = conversation_id
        queue: asyncio.Queue = asyncio.Queue()

        async def sink(ev: dict) -> None:
            await queue.put(ev)

        task = asyncio.create_task(self._run(text, conv, client or {}, sink))
        self._tasks[conv] = task
        yield {"event": "start", "conversation_id": conv}
        try:
            while True:
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                if getter in done:
                    ev = getter.result()
                    yield ev
                    if ev["event"] == "done":
                        break
                else:
                    getter.cancel()
                    if task.cancelled() or task.exception():   # tarefa morreu sem 'done'
                        while not queue.empty():
                            ev = queue.get_nowait()
                            yield ev
                            if ev["event"] == "done":
                                return
                        if task.done() and not task.cancelled() and task.exception():
                            raise task.exception()
                        break
        finally:
            if not task.done():           # cliente desconectou → cancela a geração
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
            self._tasks.pop(conv, None)

    def cancel(self, conversation_id: int) -> bool:
        task = self._tasks.get(conversation_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    # ==================================================================
    # Execução
    # ==================================================================
    async def _run(self, text: str, conv: int, client: dict, sink: Sink) -> None:
        self.conversations.add(conv, "user", text)
        self.events.emit(EventType.MESSAGE_RECEIVED, conversation_id=conv, chars=len(text))
        metrics = RequestMetrics(conv)
        analysis = self.conversation.analyze(conv, text)
        partial: list[str] = []
        self.state.update(processing=True)
        reply: BrainReply | None = None
        cancelled = False
        try:
            await self._phase(sink, Phase.THINKING)
            reply = await self._dispatch(text, conv, client, analysis, sink, metrics, partial)
        except LLMError as e:
            hint = NO_MODEL_HINT if e.code == "MODEL_UNAVAILABLE" else ""
            reply = BrainReply(e.message + hint, conv, route="error", error={"code": e.code, "message": e.message})
            self.events.emit(EventType.AI_ERROR, conversation_id=conv, code=e.code)
            metrics.error = e.code
        except asyncio.CancelledError:
            cancelled = True
            reply = BrainReply("".join(partial).strip() or "(interrompido)", conv, route="cancelled")
            self.events.emit(EventType.GENERATION_CANCELLED, conversation_id=conv)
        except Exception as e:   # erro inesperado: registra e responde com calma
            log.exception("erro no cérebro")
            reply = BrainReply("Tive um problema interno ao processar isso. Já registrei no log.", conv, route="error",
                               error={"code": "INTERNAL_ERROR", "message": str(e)[:200]})
            metrics.error = "INTERNAL_ERROR"
        finally:
            self.state.update(processing=False, active_tool=None)

        reply = reply or BrainReply("…", conv)
        route_label = f"tool:{reply.tool}" if reply.tool and reply.route == "tool" else reply.route
        reply.message_id = self.conversations.add(conv, "assistant", reply.text, route=route_label)
        if reply.sources:
            self.conversations.db.execute("UPDATE messages SET sources = ? WHERE id = ?",
                                          (json.dumps(reply.sources, ensure_ascii=False)[:20000], reply.message_id))
        self.conversation.record(conv, text, reply.text, reply.route, reply.tool,
                                 query=reply.data.get("query"), sources=reply.sources or None,
                                 topic=reply.data.get("topic") if isinstance(reply.data.get("topic"), str) else None,
                                 analysis=analysis)
        metrics.route, metrics.tools, metrics.sources = reply.route, reply.tools_used, len(reply.sources)
        if self.metrics:
            self.events.emit(EventType.METRICS, **self.metrics.save(metrics))
        self.events.emit(EventType.AI_RESPONSE, conversation_id=conv, route=reply.route, tool=reply.tool)
        final_phase = Phase.ERROR if reply.route == "error" else Phase.WAITING_CONFIRMATION if reply.route == "confirm" else Phase.IDLE
        self.state.set_phase(final_phase, self.events, conversation_id=conv)
        done = {"event": "done", "_reply": reply, **reply.to_dict(), "error": reply.error, "metrics": metrics.to_dict()}
        if cancelled:
            await sink(done)
            raise asyncio.CancelledError
        await sink({"event": "state", "phase": final_phase.value})
        await sink(done)

    async def _phase(self, sink: Sink, phase: Phase, **info) -> None:
        self.state.set_phase(phase, self.events, **info)
        await sink({"event": "state", "phase": phase.value, **info})

    # ------------------------------------------------------------------
    async def _dispatch(self, text, conv, client, a: TurnAnalysis, sink, metrics, partial) -> BrainReply:
        # 1) resposta a uma confirmação pendente
        verdict, action = self.permissions.resolve(conv, text)
        if verdict == "yes" and action:
            result = await self._execute(action.tool, action.args, sink, metrics)
            return await self._reply_from_tool(action.tool, result, text, conv, client, a, sink, metrics, partial)
        if verdict == "no" and action:
            return BrainReply("Ok, cancelei. Nada foi executado.", conv, route="cancelled", tool=action.tool)

        # 2) comandos de conversa
        if a.command in (Command.STOP, Command.CANCEL):
            msg = "Ok, parei." if a.command == Command.STOP else "Cancelado."
            return BrainReply(msg, conv, route="command")
        if a.command == Command.REPEAT:
            last = self.conversation.state(conv).last_answer
            return BrainReply(last or "Ainda não disse nada nesta conversa.", conv, route="command")

        # 3) tarefa com várias etapas
        if a.command == Command.NONE and is_multistep(text) and self.state.model.available:
            plan_reply = await self._plan_flow(text, conv, client, a, sink, metrics, partial)
            if plan_reply:
                return plan_reply

        # 4) ferramenta pelo roteador (com a frase já sem referências)
        if a.command == Command.NONE:
            route = self.router.route(a.standalone)
            if route.kind == "tool" and route.tool:
                args, keep_topic = dict(route.args), None
                if route.tool in SEARCH_TOOLS:
                    key = "query" if "query" in args else "question" if "question" in args else None
                    if key:
                        args[key], changed = self.conversation.contextualize_query(conv, args[key])
                        keep_topic = self.conversation.state(conv).topic if changed else None
                reply = await self._tool_flow(route.tool, args, text, conv, client, a, sink, metrics, partial)
                if keep_topic:
                    reply.data = {**reply.data, "topic": keep_topic}
                return reply
            contextual = self._contextual_knowledge(text, conv)
            if contextual:
                return await self._tool_flow("knowledge", contextual, text, conv, client, a, sink, metrics, partial)
            auto = self._auto_search(text, a)
            if auto:
                auto["query"], changed = self.conversation.contextualize_query(conv, auto["query"])
                keep_topic = self.conversation.state(conv).topic if changed else None
                reply = await self._tool_flow("web", auto, text, conv, client, a, sink, metrics, partial)
                if keep_topic:
                    reply.data = {**reply.data, "topic": keep_topic}
                return reply

        # 5) modelo (com instrução do comando e contexto da conversa)
        notes = [a.note]
        instr = self.conversation.command_instruction(a.command)
        if instr:
            notes.append(instr)
        if self.knowledge and self.knowledge.needs_current_info(text) and not self.knowledge.general.available:
            notes.append("A pesquisa web geral NÃO está configurada: se a pergunta exigir informação atual, diga que não "
                         "consegue verificar agora em vez de supor.")
        return await self._llm_flow(text, conv, client, notes, sink, metrics, partial)

    # ------------------------------------------------------------------
    def _contextual_knowledge(self, text: str, conv: int) -> dict | None:
        """'Qual a diferença entre MCU e quadrinhos?' logo depois de falar do Tony → base de conhecimento com o Tony."""
        if not self.knowledge or not self.tools.get("knowledge"):
            return None
        topic = self.conversation.state(conv).topic
        if not topic or not (_KNOWLEDGE_CUE.search(text) and _QUESTION.search(text.strip())):
            return None
        slugs = self.knowledge.kb.detect(topic)
        if not slugs or self.knowledge.needs_current_info(text):
            return None
        return {"question": text, "entities": ",".join(slugs)}

    def _auto_search(self, text: str, a: TurnAnalysis) -> dict | None:
        """O JARVIS decide pesquisar sozinho quando a pergunta é sobre algo atual."""
        if not self.knowledge or not self.tools.get("web") or not self.knowledge.general.available:
            return None
        if self.knowledge.needs_current_info(text) and _QUESTION.search(text.strip()):
            return {"query": a.standalone.strip(" ?")}
        return None

    def _gate(self, name: str, args: dict, conv: int) -> tuple[BrainReply | None, dict]:
        tool = self.tools.get(name)
        if not tool:
            return BrainReply(f"Não tenho a ferramenta “{name}”.", conv, route="error",
                              error={"code": "TOOL_NOT_FOUND", "message": name}), args
        try:
            args = tool.validate(args)
            risk = tool.risk_for(args)
            description = tool.describe(args)
        except Exception as e:
            return BrainReply(f"Não consegui preparar essa ação: {e}", conv, route="error", tool=name,
                              error={"code": "INVALID_ARGS", "message": str(e)}), args
        decision = self.permissions.decide(name, risk)
        if decision == Decision.DENY:
            return BrainReply("Essa ação está bloqueada pelas permissões do JARVIS.", conv, route="error", tool=name,
                              error={"code": "PERMISSION_DENIED", "message": name}), args
        if decision == Decision.CONFIRM:
            pending = self.permissions.request(conv, name, args, risk, description)
            self.events.emit(EventType.CONFIRMATION_REQUIRED, conversation_id=conv, tool=name, risk=risk.value)
            return BrainReply(f"Posso {description}? Responda “sim” para confirmar ou “não” para cancelar.",
                              conv, route="confirm", tool=name, pending=pending.public()), args
        return None, args

    async def _execute(self, name: str, args: dict, sink: Sink, metrics: RequestMetrics) -> ToolResult:
        phase = Phase.SEARCHING if name in SEARCH_TOOLS else Phase.EXECUTING
        await self._phase(sink, phase, tool=name)
        self.state.update(active_tool=name)
        self.events.emit(EventType.TOOL_STARTED, tool=name)
        await sink({"event": "tool", "tool": name, "status": "started"})
        t0 = time.perf_counter()
        if name in SEARCH_TOOLS:
            self.events.emit(EventType.SEARCH_STARTED, tool=name)
        result = await self.tools.arun(name, args)
        ms = round((time.perf_counter() - t0) * 1000, 1)
        if name in SEARCH_TOOLS:
            metrics.search_ms = (metrics.search_ms or 0) + ms
            self.events.emit(EventType.SEARCH_FINISHED, tool=name, results=len(result.data.get("sources", [])), ms=ms)
        metrics.tools.append(name)
        self.events.emit(EventType.TOOL_FINISHED, tool=name, ok=result.ok, code=result.error_code)
        if result.data.get("memory_changed"):
            self.events.emit(EventType.MEMORY_UPDATED, source="chat")
        if result.data.get("sources"):
            await sink({"event": "sources", "items": result.data["sources"], "conflicts": result.data.get("conflicts", [])})
        await sink({"event": "tool", "tool": name, "status": "finished", "ok": result.ok})
        self.state.update(active_tool=None)
        return result

    async def _tool_flow(self, name, args, text, conv, client, a, sink, metrics, partial) -> BrainReply:
        blocked, args = self._gate(name, args, conv)
        if blocked:
            if blocked.pending:
                await sink({"event": "confirm", "pending": blocked.pending})
            return blocked
        result = await self._execute(name, args, sink, metrics)
        return await self._reply_from_tool(name, result, text, conv, client, a, sink, metrics, partial)

    async def _reply_from_tool(self, name, result: ToolResult, text, conv, client, a, sink, metrics, partial) -> BrainReply:
        sources = result.data.get("sources", [])
        base = dict(conv=conv, route="tool", tool=name, data=result.data, sources=sources, tools_used=list(metrics.tools))
        if result.ok and result.summarize and self.state.model.available:
            try:
                if result.data.get("prompt_override"):
                    msgs = [Message("system", self.context.personality.system_prompt()), Message("user", result.data["prompt_override"])]
                else:
                    msgs = self.context.build(text, conv, client, [a.note] if a else None)
                    msgs += [Message("assistant", f'TOOL_CALL {{"tool": "{name}"}}'), Message("user", self._tool_feedback(name, result))]
                await self._phase(sink, Phase.PROCESSING)
                answer, call = await self._stream_llm(msgs, sink, metrics, partial)
                if answer and not call:
                    return BrainReply(answer, conv, "tool", name, data=result.data, sources=sources, tools_used=list(metrics.tools))
            except LLMError as e:
                log.info("resumo pelo modelo falhou (%s); usando resposta direta da ferramenta", e.code)
        await self._emit_text(result.message, sink, partial)
        return BrainReply(result.message, base["conv"], "tool", name, data=result.data, sources=sources,
                          tools_used=list(metrics.tools), error=None if result.ok else {"code": result.error_code, "message": result.message})

    @staticmethod
    def _tool_feedback(name: str, result: ToolResult) -> str:
        data = {k: v for k, v in result.data.items() if k not in ("sources", "instructions", "prompt_override", "topic")}
        payload = json.dumps({"ok": result.ok, "message": result.message if not data.get("knowledge") else "", "data": data},
                             ensure_ascii=False, default=str)[:9000]
        instr = result.data.get("instructions") or "Agora responda ao meu pedido usando esse resultado."
        return f"RESULTADO DA FERRAMENTA {name}: {payload}\n\n{instr}"

    # ------------------------------------------------------------------
    async def _emit_text(self, text: str, sink: Sink, partial: list[str]) -> None:
        partial.append(text)
        await sink({"event": "delta", "text": text})

    async def _stream_llm(self, msgs: list[Message], sink: Sink, metrics: RequestMetrics, partial: list[str]) -> tuple[str, tuple | None]:
        """Transmite a resposta do modelo pedaço a pedaço. Se ela for um TOOL_CALL, não mostra ao usuário."""
        t0 = time.perf_counter()
        buf, out, streaming = "", [], False
        await self._phase(sink, Phase.THINKING)
        async for piece in self.llm.stream(msgs):
            if metrics.llm_first_ms is None:
                metrics.llm_first_ms = round((time.perf_counter() - t0) * 1000, 1)
            out.append(piece)
            if streaming:
                await self._emit_text(piece, sink, partial)
                continue
            buf += piece
            head = buf.lstrip()
            if head.startswith("TOOL_CALL") or "TOOL_CALL".startswith(head):
                continue                       # pode ser pedido de ferramenta: segura
            streaming = True
            await self._phase(sink, Phase.PROCESSING)   # gerando texto (a fala acontece no navegador)
            await self._emit_text(buf, sink, partial)
        metrics.llm_total_ms = round((metrics.llm_total_ms or 0) + (time.perf_counter() - t0) * 1000, 1)
        full = "".join(out).strip()
        call = None if streaming else self.router.parse_tool_request(full)
        if not streaming and not call and full:
            await self._emit_text(full, sink, partial)
        return full, call

    async def _llm_flow(self, text, conv, client, notes, sink, metrics, partial) -> BrainReply:
        if self.state.model.available:
            await self.context.compress(conv, self.llm)
        msgs = self.context.build(text, conv, client, notes)
        used: list[str] = []
        sources: list[dict] = []
        data: dict = {}
        for _ in range(self.MAX_TOOL_ROUNDS):
            self.events.emit(EventType.AI_THINKING, conversation_id=conv)
            out, call = await self._stream_llm(msgs, sink, metrics, partial)
            if not call:
                return BrainReply(out or "…", conv, route="tool" if used else "llm", tool=used[-1] if used else None,
                                  sources=sources, tools_used=used, data=data)
            name, args = call
            blocked, args = self._gate(name, args, conv)
            if blocked and blocked.route == "confirm":
                await sink({"event": "confirm", "pending": blocked.pending})
                return blocked
            if blocked:
                feedback = f"A ferramenta {name} não pôde ser usada: {blocked.text}"
            else:
                result = await self._execute(name, args, sink, metrics)
                used.append(name)
                sources += result.data.get("sources", [])
                for k in ("query", "topic"):
                    if result.data.get(k):
                        data[k] = result.data[k]
                feedback = self._tool_feedback(name, result)
            msgs += [Message("assistant", out), Message("user", feedback)]
        return BrainReply("Não consegui concluir esse pedido com as ferramentas disponíveis.", conv,
                          route="error", error={"code": "TOOL_LOOP", "message": "limite de ferramentas atingido"})

    # ------------------------------------------------------------------
    async def _plan_flow(self, text, conv, client, a, sink, metrics, partial) -> BrainReply | None:
        allowed = {t.name for t in self.tools.all() if t.name not in ("camera", "devices")}
        steps = await make_plan(self.llm, text, self.tools.catalog(), allowed)
        if len(steps) < 2:
            return None           # não compensa: segue o fluxo normal
        await sink({"event": "plan", "steps": [{"tool": s.tool, "goal": s.goal} for s in steps]})
        outputs, sources = [], []
        for i, step in enumerate(steps, 1):
            self.events.emit(EventType.STEP_STARTED, index=i, total=len(steps), tool=step.tool, goal=step.goal)
            await sink({"event": "step", "index": i, "total": len(steps), "tool": step.tool, "goal": step.goal})
            blocked, args = self._gate(step.tool, step.args, conv)
            if blocked and blocked.route == "confirm":
                blocked.text = f"Antes da etapa {i} ({step.goal}): {blocked.text} As demais etapas ficaram pausadas."
                await sink({"event": "confirm", "pending": blocked.pending})
                return blocked
            if blocked:
                outputs.append(f"ETAPA {i} ({step.goal}): não executada — {blocked.text}")
                continue
            res = await self._execute(step.tool, args, sink, metrics)
            sources += res.data.get("sources", [])
            body = res.data.get("knowledge") or json.dumps(res.data.get("results") or res.message, ensure_ascii=False)[:3000]
            outputs.append(f"ETAPA {i} ({step.goal}) via {step.tool}: {'ok' if res.ok else 'falhou'}\n{body}")
        msgs = self.context.build(text, conv, client, [a.note])
        msgs += [Message("assistant", "(executei o plano)"),
                 Message("user", "RESULTADOS DAS ETAPAS:\n\n" + "\n\n".join(outputs) +
                         "\n\nAgora responda ao pedido original de forma organizada e curta, citando as fontes como [n] quando houver. "
                         "Não invente nada além dos resultados.")]
        await self._phase(sink, Phase.PROCESSING)
        answer, _ = await self._stream_llm(msgs, sink, metrics, partial)
        return BrainReply(answer, conv, route="plan", tool=None, sources=sources, tools_used=list(metrics.tools),
                          data={"steps": [s.__dict__ for s in steps]})
