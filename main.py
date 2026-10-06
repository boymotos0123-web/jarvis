"""
Ponto de entrada do JARVIS.

    python main.py          → inicia o servidor e abre a interface no navegador
    python main.py --cli    → conversa com o JARVIS direto no terminal (sem interface)
    python main.py --check  → verifica configuração, banco e modelo, e sai

`build_jarvis()` monta todas as peças (é a única função que conhece todas).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass

from config import VERSION, Config, load_config, setup_logging
from core.brain import Brain
from core.context import ContextBuilder
from core.conversation import ConversationEngine
from core.events import EventBus, EventType
from core.memory import ConversationStore, MemoryStore
from core.metrics import MetricsRecorder
from core.permissions import PermissionManager
from core.personality import Personality
from core.router import Router
from core.state import JarvisState, ModelStatus, Phase
from database import Database
from devices import DeviceManager
from knowledge import KnowledgeEngine
from knowledge.research import DeepResearch
from models.llm import HealthCache, LLMProvider, create_provider
from tools import ToolRegistry
from tools.browser import BrowserTool
from tools.calculator import CalculatorTool
from tools.camera import CameraTool
from tools.devices import DevicesTool
from tools.files import FilesTool
from tools.knowledge_tool import KnowledgeTool
from tools.memory_tool import MemoryTool
from tools.projects import ProjectsTool
from tools.research import ResearchTool
from tools.system import SystemMonitor, SystemTool
from tools.web import WebTool
from vision import VisionService
from voice import VoiceService

log = logging.getLogger("jarvis")


@dataclass
class Jarvis:
    """Container com todos os componentes já ligados entre si."""
    config: Config
    db: Database
    events: EventBus
    state: JarvisState
    memory: MemoryStore
    conversations: ConversationStore
    tools: ToolRegistry
    projects: ProjectsTool
    permissions: PermissionManager
    devices: DeviceManager
    vision: VisionService
    voice: VoiceService
    monitor: SystemMonitor
    llm: LLMProvider
    llm_health: HealthCache
    brain: Brain
    knowledge: KnowledgeEngine
    conversation: ConversationEngine
    metrics: MetricsRecorder

    async def refresh_model_status(self, force: bool = False) -> ModelStatus:
        ok, err = await self.llm_health.get(force=force)
        prev = self.state.model.available
        self.state.update(model=ModelStatus(self.llm.provider, self.llm.model, ok, err, self.llm_health._at))
        if ok != prev:
            self.events.emit(EventType.MODEL_STATUS, available=ok, provider=self.llm.provider, error=err)
        return self.state.model

    def reload_model(self, config: Config | None = None) -> None:
        """Recarrega o provedor de IA (ex.: depois de editar o .env)."""
        if config:
            self.config = config
        self.llm = create_provider(self.config)
        self.llm_health = HealthCache(self.llm)
        self.brain.llm = self.llm


def build_jarvis(config: Config | None = None, llm: LLMProvider | None = None) -> Jarvis:
    config = config or load_config()
    db = Database(config.database_path)
    db.migrate()
    events = EventBus(db)
    state = JarvisState()
    memory = MemoryStore(db)
    conversations = ConversationStore(db)
    monitor = SystemMonitor()
    vision = VisionService()
    voice = VoiceService(stt_provider=config.stt_provider, tts_provider=config.tts_provider,
                         tts_voice=config.tts_voice, whisper_model=config.whisper_model)
    devices = DeviceManager(db, events)
    projects = ProjectsTool(db)
    knowledge = KnowledgeEngine(db, config.tavily_api_key, config.brave_api_key, config.github_token)
    holder: dict = {}   # referência ao Jarvis para funções que precisam do estado atual
    research = DeepResearch(knowledge, lambda: holder["j"].llm,
                            on_phase=lambda p, **info: state.set_phase(Phase(p), events, **info))

    tools = ToolRegistry()
    for tool in (CalculatorTool(), MemoryTool(memory), FilesTool(config.workspace_dir), KnowledgeTool(knowledge),
                 ResearchTool(research, lambda: state.model.available), WebTool(knowledge), projects,
                 BrowserTool(), SystemTool(monitor), DevicesTool(devices), CameraTool(vision)):
        tools.register(tool)

    state.update(current_project=projects.current_slug(), microphone=voice.microphone.status(),
                 speaker=voice.speaker.status(), camera=vision.status()["camera"],
                 vision_model="not_configured")
    llm = llm or create_provider(config)
    permissions = PermissionManager(medium=config.permission_medium)
    context = ContextBuilder(Personality(user_name=config.user_name, language=config.language),
                            memory, conversations, state, tools, projects, config.history_limit)
    conversation = ConversationEngine(db)
    metrics = MetricsRecorder(db)
    brain = Brain(llm, Router(tools), context, tools, permissions, conversations, events, state,
                  conversation=conversation, knowledge=knowledge, metrics=metrics)
    j = Jarvis(config, db, events, state, memory, conversations, tools, projects, permissions,
               devices, vision, voice, monitor, llm, HealthCache(llm), brain, knowledge, conversation, metrics)
    holder["j"] = j
    return j


async def startup(jarvis: Jarvis) -> None:
    await jarvis.refresh_model_status(force=True)
    jarvis.state.update(online=True)
    for d in jarvis.devices.list():
        if d["status"] == "connected":
            jarvis.events.emit(EventType.DEVICE_CONNECTED, device=d["id"])
    m = jarvis.state.model
    log.info("JARVIS %s online · modelo: %s/%s (%s)", VERSION, m.provider, m.name or "-",
             "disponível" if m.available else f"indisponível: {m.error}")
    jarvis.events.emit(EventType.JARVIS_READY, version=VERSION, model_available=m.available)


# ----------------------------------------------------------------------------
async def cli(jarvis: Jarvis) -> None:
    await startup(jarvis)
    print(f"\nJARVIS {VERSION} — modo terminal. Digite 'sair' para encerrar.\n")
    conv = None
    while True:
        try:
            text = await asyncio.to_thread(input, "você › ")
        except (EOFError, KeyboardInterrupt):
            break
        if text.strip().lower() in {"sair", "exit", "quit"}:
            break
        if not text.strip():
            continue
        reply = await jarvis.brain.handle(text, conv)
        conv = reply.conversation_id
        tag = f" [{reply.tool}]" if reply.tool else ""
        print(f"jarvis{tag} › {reply.text}\n")


async def check(jarvis: Jarvis) -> int:
    m = await jarvis.refresh_model_status(force=True)
    print(f"JARVIS {VERSION}")
    print(f"  banco de dados : {'ok' if jarvis.db.ping() else 'FALHOU'} ({jarvis.config.database_path})")
    print(f"  pasta de trabalho: {jarvis.config.workspace_dir}")
    print(f"  modelo         : {m.provider}/{m.name or '-'} → {'DISPONÍVEL' if m.available else 'INDISPONÍVEL: ' + str(m.error)}")
    ks = jarvis.knowledge.status()
    print(f"  pesquisa       : Wikipedia/GitHub/arXiv sem chave · web geral e notícias: {'configurada' if ks['general_web'] else 'NÃO configurada (Tavily ou Brave)'}")
    print(f"  conhecimento   : {ks['knowledge_base']['entities']} entidades, {ks['knowledge_base']['facts']} fatos, {ks['knowledge_base']['relations']} relações")
    print(f"  voz            : fala→texto={jarvis.voice.stt.status()['engine']} · texto→fala={jarvis.voice.tts.status()['engine']}")
    print(f"  ferramentas    : {', '.join(jarvis.tools.names())}")
    return 0 if m.available else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="JARVIS — inteligência pessoal")
    parser.add_argument("--cli", action="store_true", help="conversar pelo terminal")
    parser.add_argument("--check", action="store_true", help="verificar configuração e sair")
    parser.add_argument("--no-browser", action="store_true", help="não abrir o navegador automaticamente")
    args = parser.parse_args(argv)

    config = load_config()
    setup_logging(config)
    jarvis = build_jarvis(config)

    if args.check:
        return asyncio.run(check(jarvis))
    if args.cli:
        asyncio.run(cli(jarvis))
        return 0

    import threading
    import webbrowser

    import uvicorn

    from server import create_app

    url = f"http://{config.host}:{config.port}"
    import os
    if os.environ.get("CODESPACES") == "true":   # no Codespaces não há navegador aqui: o endereço é o da porta encaminhada
        url = f"https://{os.environ.get('CODESPACE_NAME')}-{config.port}.{os.environ.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'app.github.dev')}"
        args.no_browser = True
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\nJARVIS {VERSION} → {url}  (Ctrl+C para parar)\n")
    uvicorn.run(create_app(jarvis), host=config.host, port=config.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
