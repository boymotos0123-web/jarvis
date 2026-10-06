"""
API HTTP do JARVIS (FastAPI) + entrega da interface.

Formato de resposta:
    sucesso → {"success": true,  "data": {...}}
    erro    → {"success": false, "error": {"code": "...", "message": "..."}}

Segurança:
- O servidor escuta só em 127.0.0.1 por padrão.
- Requisições que alteram algo (POST/PATCH/DELETE) exigem o cabeçalho
  X-JARVIS-Client — sites de terceiros abertos no navegador não conseguem
  enviá-lo, então não conseguem comandar o JARVIS.
- A interface é servida pelo próprio backend (mesma origem); não há CORS aberto.

Execute com:  python server.py   (equivale a python main.py)
"""
from __future__ import annotations

import asyncio
import os
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from config import VERSION, load_config
from core.events import EventType
from core.memory import CATEGORIES
from core.state import Phase
from models.embeddings import NoEmbeddings
from models.text_to_speech import TTSUnavailable
from tools import ToolError
from vision import CameraNotConnected
from voice.prosody import plan as prosody_plan

log = logging.getLogger("jarvis.api")
CLIENT_HEADER = "x-jarvis-client"


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status


def ok(data=None) -> dict:
    return {"success": True, "data": data if data is not None else {}}


def fail(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"success": False, "error": {"code": code, "message": message}}, status_code=status)


# ---------- modelos de entrada ----------
class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: int | None = None
    client: dict | None = None        # {"location": "...", "local_time": "...", "weather": "..."}


class MemoryIn(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    category: str = "pessoal"
    key: str | None = Field(default=None, max_length=80)


class MilestoneIn(BaseModel):
    status: str


class CancelIn(BaseModel):
    conversation_id: int


class TTSIn(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    rate: int = Field(default=0, ge=-50, le=50)
    pitch: int = Field(default=0, ge=-30, le=30)


class VoiceStateIn(BaseModel):
    listening: bool | None = None
    speaking: bool | None = None


class ClientMetricsIn(BaseModel):
    conversation_id: int
    stt_ms: float | None = None
    tts_ms: float | None = None


def sse(event: dict) -> str:
    body = {k: v for k, v in event.items() if not k.startswith("_")}
    return f"event: {event['event']}\ndata: {json.dumps(body, ensure_ascii=False, default=str)}\n\n"


# ----------------------------------------------------------------------------
def create_app(jarvis=None) -> FastAPI:
    if jarvis is None:
        from main import build_jarvis
        jarvis = build_jarvis()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        from main import startup
        await startup(jarvis)
        yield
        jarvis.state.update(online=False)

    app = FastAPI(title="JARVIS API", version=VERSION, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.jarvis = jarvis
    hosts = ["127.0.0.1", "localhost", "testserver", jarvis.config.host]
    if os.environ.get("CODESPACES") == "true":      # GitHub Codespaces: a porta encaminhada é privada (só você, logado no GitHub)
        hosts.append("*." + os.environ.get("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev"))
    hosts += [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)

    # ---------- erros no formato padrão ----------
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, e: ApiError):
        return fail(e.code, e.message, e.status)

    @app.exception_handler(ToolError)
    async def _tool_error(_: Request, e: ToolError):
        return fail(e.code, e.message, 400)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        return fail("INVALID_REQUEST", f"Requisição inválida: {where} {first.get('msg', '')}".strip(), 422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(e.status_code, "HTTP_ERROR")
        return fail(code, str(e.detail), e.status_code)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, e: Exception):
        log.exception("erro inesperado na API")
        return fail("INTERNAL_ERROR", "Erro interno do JARVIS. Veja logs/jarvis.log.", 500)

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
            if request.headers.get(CLIENT_HEADER) is None:
                return fail("FORBIDDEN", "Cabeçalho X-JARVIS-Client ausente.", 403)
        return await call_next(request)

    # ---------- status ----------
    @app.get("/api/status")
    async def status(deep: bool = False):
        model = await jarvis.refresh_model_status(force=deep)
        return ok({
            "version": VERSION,
            "online": jarvis.state.online,
            "model": {"provider": model.provider, "name": model.name, "available": model.available, "error": model.error},
            "state": jarvis.state.snapshot(),
            "database": "ok" if jarvis.db.ping() else "error",
            "modules": {
                "voice": jarvis.voice.status(),
                "vision": jarvis.vision.status(),
                "web_search": {"configured": jarvis.tools.get("web").configured, "free_sources": ["wikipedia", "github", "arxiv"]},
                "knowledge": jarvis.knowledge.kb.stats(),
                "embeddings": NoEmbeddings().status(),
            },
            "tools": [t.spec() for t in jarvis.tools.all()],
        })

    @app.post("/api/core/restart")
    async def restart():
        jarvis.reload_model(load_config(override=True))
        model = await jarvis.refresh_model_status(force=True)
        jarvis.events.emit(EventType.JARVIS_READY, version=VERSION, model_available=model.available, restarted=True)
        return ok({"model": {"provider": model.provider, "name": model.name, "available": model.available, "error": model.error}})

    # ---------- conversa ----------
    @app.post("/api/chat")
    async def chat(body: ChatIn):
        reply = await jarvis.brain.handle(body.message, body.conversation_id, body.client)
        if reply.route == "error" and reply.error:
            status = 503 if reply.error["code"].startswith("MODEL_") else 400
            resp = fail(reply.error["code"], reply.text, status)
            resp.headers["X-Conversation-Id"] = str(reply.conversation_id)
            return resp
        return ok(reply.to_dict())

    @app.post("/api/chat/stream")
    async def chat_stream(body: ChatIn, request: Request):
        """Resposta em tempo real (Server-Sent Events): state · delta · sources · tool · step · confirm · done."""
        gen = jarvis.brain.handle_stream(body.message, body.conversation_id, body.client)

        async def events():
            try:
                async for ev in gen:
                    yield sse(ev)
                    if await request.is_disconnected():
                        break
            finally:
                await gen.aclose()     # cliente saiu → a geração é cancelada

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/chat/cancel")
    async def chat_cancel(body: CancelIn):
        return ok({"cancelled": jarvis.brain.cancel(body.conversation_id)})

    @app.get("/api/chat/history")
    async def history(conversation_id: int | None = None, limit: int = Query(50, ge=1, le=500)):
        conv = conversation_id or jarvis.conversations.latest()
        if not conv:
            return ok({"conversation_id": None, "messages": []})
        if not jarvis.conversations.exists(conv):
            raise ApiError("CONVERSATION_NOT_FOUND", "Conversa não encontrada.", 404)
        msgs = jarvis.conversations.history(conv, limit)
        rows = {r["id"]: r["sources"] for r in jarvis.db.all(
            "SELECT id, sources FROM messages WHERE conversation_id = ? AND sources IS NOT NULL", (conv,))}
        for m in msgs:
            m["sources"] = json.loads(rows[m["id"]]) if m["id"] in rows else []
        return ok({"conversation_id": conv, "messages": msgs})

    @app.post("/api/chat/new")
    async def new_conversation():
        return ok({"conversation_id": jarvis.conversations.create()})

    # ---------- memória ----------
    @app.get("/api/memory")
    async def memory_list(q: str | None = None, category: str | None = None, limit: int = Query(200, ge=1, le=1000)):
        if category and category not in CATEGORIES:
            raise ApiError("INVALID_CATEGORY", f"Categoria inválida. Use: {', '.join(CATEGORIES)}")
        items = jarvis.memory.search(q, limit=limit, category=category) if q else jarvis.memory.list(category, limit)
        return ok({"items": [m.to_dict() for m in items], "counts": jarvis.memory.counts(), "categories": list(CATEGORIES)})

    @app.post("/api/memory")
    async def memory_add(body: MemoryIn):
        if body.category not in CATEGORIES:
            raise ApiError("INVALID_CATEGORY", f"Categoria inválida. Use: {', '.join(CATEGORIES)}")
        mem = jarvis.memory.remember(body.content, body.category, body.key, source="interface")
        jarvis.events.emit(EventType.MEMORY_UPDATED, source="interface")
        return ok(mem.to_dict())

    @app.delete("/api/memory/{memory_id}")
    async def memory_delete(memory_id: int):
        if not jarvis.memory.forget(memory_id):
            raise ApiError("MEMORY_NOT_FOUND", "Memória não encontrada.", 404)
        jarvis.events.emit(EventType.MEMORY_UPDATED, source="interface")
        return ok({"deleted": memory_id})

    # ---------- projetos ----------
    @app.get("/api/projects")
    async def projects():
        return ok({"items": jarvis.projects.list_projects(), "current": jarvis.state.current_project})

    @app.get("/api/projects/{slug}")
    async def project(slug: str):
        p = jarvis.projects.get_project(slug)
        if not p:
            raise ApiError("PROJECT_NOT_FOUND", f"Projeto '{slug}' não encontrado.", 404)
        return ok(p)

    @app.patch("/api/projects/{slug}/milestones/{milestone_id}")
    async def milestone(slug: str, milestone_id: int, body: MilestoneIn):
        p = jarvis.projects.set_milestone(slug, milestone_id, body.status)
        jarvis.events.emit(EventType.PROJECT_UPDATED, project=slug)
        return ok(p)

    # ---------- dispositivos / visão / sistema ----------
    @app.get("/api/devices")
    async def devices():
        return ok({"items": jarvis.devices.list()})

    @app.get("/api/vision/status")
    async def vision_status():
        return ok(jarvis.vision.status())

    @app.post("/api/vision/start")
    async def vision_start():
        try:
            return ok(jarvis.vision.start())
        except CameraNotConnected as e:
            raise ApiError("CAMERA_NOT_CONNECTED", str(e), 409)

    @app.get("/api/system/status")
    async def system_status():
        snap = await asyncio.to_thread(jarvis.monitor.snapshot)
        m = jarvis.state.model
        connected = sum(1 for d in jarvis.devices.list() if d["status"] == "connected")
        modules = [
            {"name": "core.brain", "status": "ativo"},
            {"name": f"llm.{m.provider}", "status": "ativo" if m.available else "indisponível"},
            {"name": "memory.sqlite", "status": "ativo" if jarvis.db.ping() else "erro"},
            {"name": "tools", "status": f"{len(jarvis.tools.names())} ativas"},
            {"name": "knowledge.engine", "status": f"ativo · {jarvis.knowledge.kb.stats()['facts']} fatos"},
            {"name": "web.search", "status": "ativo" if jarvis.tools.get("web").configured else "ativo · só fontes sem chave"},
            {"name": "voice.tts", "status": f"ativo · {jarvis.voice.tts.status()['engine']}"},
            {"name": "voice.stt", "status": f"ativo · {jarvis.voice.stt.status()['engine']}"},
            {"name": "vision.cv", "status": "não conectado"},
            {"name": "devices.mesh", "status": f"{connected}/{len(jarvis.devices.list())} conectados"},
        ]
        return ok({**snap, "uptime_seconds": int(time.time() - jarvis.state.started_at), "modules": modules})

    # ---------- voz ----------
    @app.get("/api/voice/status")
    async def voice_status():
        return ok(jarvis.voice.status())

    @app.post("/api/voice/tts")
    async def voice_tts(body: TTSIn):
        try:
            audio = await jarvis.voice.tts.synthesize(body.text, body.rate, body.pitch)
        except TTSUnavailable as e:
            raise ApiError("TTS_UNAVAILABLE", str(e), 503)
        return Response(audio, media_type="audio/mpeg", headers={"X-TTS-Ms": str(round(getattr(jarvis.voice.tts, "last_ms", 0)))})

    @app.post("/api/voice/plan")
    async def voice_plan(body: TTSIn):
        return ok({"utterances": [u.to_dict() for u in prosody_plan(body.text, body.rate)]})

    @app.post("/api/voice/stt")
    async def voice_stt(request: Request):
        if jarvis.voice.stt.name != "whisper":
            raise ApiError("STT_BROWSER_MODE", "A transcrição está no modo navegador (STT_PROVIDER=browser).", 409)
        audio = await request.body()
        if not audio or len(audio) > 15_000_000:
            raise ApiError("INVALID_AUDIO", "Áudio vazio ou grande demais.")
        text = await asyncio.to_thread(jarvis.voice.stt.transcribe, audio)
        return ok({"text": text, "stt_ms": round(jarvis.voice.stt.last_ms)})

    @app.post("/api/voice/state")
    async def voice_state(body: VoiceStateIn):
        """A interface informa se está ouvindo/falando — o estado do JARVIS reflete isso."""
        if body.listening is not None:
            jarvis.voice.microphone.active = body.listening
        if body.speaking is not None:
            jarvis.voice.speaker.speaking = body.speaking
        if not jarvis.state.processing:
            phase = Phase.SPEAKING if jarvis.voice.speaker.speaking else Phase.LISTENING if jarvis.voice.microphone.active else Phase.IDLE
            jarvis.state.set_phase(phase, jarvis.events)
        return ok({"phase": jarvis.state.phase.value})

    # ---------- conhecimento ----------
    @app.get("/api/knowledge/status")
    async def knowledge_status():
        return ok(jarvis.knowledge.status())

    @app.get("/api/knowledge/search")
    async def knowledge_search(q: str = Query(min_length=2, max_length=300)):
        rep = await jarvis.knowledge.search(q)
        return ok({"query": q, "categories": rep.categories, "providers": rep.providers, "results": rep.sources(),
                   "errors": rep.errors, "conflicts": rep.conflicts, "cached": rep.cached, "elapsed_ms": rep.elapsed_ms})

    @app.get("/api/knowledge/entity/{slug}")
    async def knowledge_entity(slug: str):
        e = jarvis.knowledge.kb.entity(slug)
        if not e:
            raise ApiError("ENTITY_NOT_FOUND", f"Entidade '{slug}' não está na base.", 404)
        return ok(e)

    @app.get("/api/knowledge/ask")
    async def knowledge_ask(q: str = Query(min_length=2, max_length=500)):
        block, sources, slugs, universes = jarvis.knowledge.kb.context_for(q)
        return ok({"question": q, "entities": slugs, "universes": universes, "knowledge": block, "sources": sources})

    # ---------- observabilidade ----------
    @app.get("/api/metrics/recent")
    async def metrics_recent(limit: int = Query(30, ge=1, le=200)):
        return ok({"items": jarvis.metrics.recent(limit), "summary": jarvis.metrics.summary()})

    @app.post("/api/metrics/client")
    async def metrics_client(body: ClientMetricsIn):
        return ok({"updated": jarvis.metrics.client_report(body.conversation_id, body.stt_ms, body.tts_ms)})

    # ---------- eventos ----------
    @app.get("/api/events/recent")
    async def events_recent(limit: int = Query(50, ge=1, le=500)):
        return ok({"items": jarvis.events.recent(limit)})

    @app.get("/api/events/stream")
    async def events_stream(request: Request):
        queue = jarvis.events.open_queue()

        async def gen():
            try:
                yield "retry: 3000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                        yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                jarvis.events.close_queue(queue)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ---------- interface ----------
    @app.get("/api/{rest:path}")
    async def api_not_found(rest: str):
        raise ApiError("NOT_FOUND", f"Endpoint /api/{rest} não existe.", 404)

    app.mount("/", StaticFiles(directory=str(jarvis.config.interface_dir), html=True), name="interface")
    return app


if __name__ == "__main__":
    import sys

    from main import main
    sys.exit(main())
