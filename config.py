"""
Configuração central do JARVIS.

Lê variáveis do arquivo .env (nunca coloque chaves no código) e expõe um
objeto `Config` imutável. Também configura o sistema de logs.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field, replace
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
VERSION = "0.3.0"


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "sim", "on"}


def _path(value: str | None, default: str) -> Path:
    p = Path(value.strip()) if value and value.strip() else Path(default)
    return p if p.is_absolute() else (BASE_DIR / p)


def _float_or_none(value: str | None) -> float | None:
    try:
        return float(value) if value and value.strip() else None
    except ValueError:
        return None


@dataclass(frozen=True)
class Config:
    # Modelo de IA
    model_provider: str = "none"          # openai | groq | openrouter | lmstudio | ollama | anthropic | none
    model_name: str = ""
    api_key: str = field(default="", repr=False)
    model_base_url: str = ""              # vazio = padrão do provedor
    model_temperature: float | None = None
    model_timeout: float = 60.0
    max_tokens: int = 1024

    # Identidade
    user_name: str = "José Marcelo"
    language: str = "pt-BR"

    # Armazenamento
    database_path: Path = BASE_DIR / "database" / "memory.db"
    workspace_dir: Path = BASE_DIR / "workspace"
    log_path: Path = BASE_DIR / "logs" / "jarvis.log"
    interface_dir: Path = BASE_DIR / "interface"

    # Pesquisa (Wikipedia, GitHub e arXiv funcionam sem chave)
    tavily_api_key: str = field(default="", repr=False)
    brave_api_key: str = field(default="", repr=False)
    github_token: str = field(default="", repr=False)

    # Voz
    tts_provider: str = "edge"            # edge | browser
    tts_voice: str = "pt-BR-AntonioNeural"
    stt_provider: str = "browser"         # browser | whisper
    whisper_model: str = "small"

    # Permissões: o que fazer com ações de risco médio (abrir programas)
    permission_medium: str = "allow"      # allow | confirm  (risco alto SEMPRE pede confirmação)

    # Servidor
    host: str = "127.0.0.1"
    port: int = 8000
    debug: bool = False

    # Conversa
    history_limit: int = 12               # mensagens recentes enviadas ao modelo

    def with_overrides(self, **kwargs) -> "Config":
        return replace(self, **kwargs)


def load_config(env_file: str | os.PathLike | None = None, override: bool = False) -> Config:
    """Carrega o .env (se existir) e monta o Config. override=True relê o .env por cima do ambiente."""
    load_dotenv(env_file or BASE_DIR / ".env", override=override)
    e = os.environ.get
    return Config(
        model_provider=(e("MODEL_PROVIDER") or "none").strip().lower(),
        model_name=(e("MODEL_NAME") or "").strip(),
        api_key=(e("API_KEY") or "").strip(),
        model_base_url=(e("MODEL_BASE_URL") or "").strip(),
        model_temperature=_float_or_none(e("MODEL_TEMPERATURE")),
        model_timeout=float(e("MODEL_TIMEOUT") or 60),
        max_tokens=int(e("MAX_TOKENS") or 1024),
        user_name=(e("USER_NAME") or "José Marcelo").strip(),
        language=(e("LANGUAGE") or "pt-BR").strip(),
        database_path=_path(e("DATABASE_PATH"), "database/memory.db"),
        workspace_dir=_path(e("WORKSPACE_DIR"), "workspace"),
        log_path=_path(e("LOG_PATH"), "logs/jarvis.log"),
        tavily_api_key=(e("TAVILY_API_KEY") or "").strip(),
        brave_api_key=(e("BRAVE_API_KEY") or "").strip(),
        github_token=(e("GITHUB_TOKEN") or "").strip(),
        tts_provider=(e("TTS_PROVIDER") or "edge").strip().lower(),
        tts_voice=(e("TTS_VOICE") or "pt-BR-AntonioNeural").strip(),
        stt_provider=(e("STT_PROVIDER") or "browser").strip().lower(),
        whisper_model=(e("WHISPER_MODEL") or "small").strip(),
        permission_medium=(e("PERMISSION_MEDIUM") or "allow").strip().lower(),
        host=(e("HOST") or "127.0.0.1").strip(),
        port=int(e("PORT") or 8000),
        debug=_bool(e("DEBUG")),
        history_limit=int(e("HISTORY_LIMIT") or 12),
    )


def setup_logging(config: Config) -> None:
    """Logs no console e em logs/jarvis.log (rotativo, 1 MB x 5)."""
    config.log_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    root = logging.getLogger("jarvis")
    root.setLevel(logging.DEBUG if config.debug else logging.INFO)
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        fh = RotatingFileHandler(config.log_path, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
        fh.setFormatter(fmt)
        root.addHandler(fh)
        ch = logging.StreamHandler()
        ch.setFormatter(fmt)
        root.addHandler(ch)
