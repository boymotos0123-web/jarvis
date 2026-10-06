"""
Sistema do computador: telemetria real (psutil) e abertura AUTORIZADA de programas.

Só abre programas da lista ALLOWED_APPS. Não existe "executar comando
qualquer": o modelo não consegue rodar nada fora dessa lista.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import threading
import time

import psutil

from core.memory import strip_accents
from core.permissions import Risk
from devices.workstation import battery_info, gpu_info
from tools import Tool, ToolError, ToolResult

IS_WINDOWS = platform.system() == "Windows"

# nome falado → (rótulo, comandos candidatos)
ALLOWED_APPS: dict[str, tuple[str, list[str]]] = {
    "vs code": ("VS Code", ["code"]), "vscode": ("VS Code", ["code"]), "visual studio code": ("VS Code", ["code"]),
    "bloco de notas": ("Bloco de Notas", ["notepad"] if IS_WINDOWS else ["gedit", "kate", "mousepad"]),
    "notepad": ("Bloco de Notas", ["notepad"] if IS_WINDOWS else ["gedit"]),
    "calculadora": ("Calculadora", ["calc"] if IS_WINDOWS else ["gnome-calculator", "kcalc"]),
    "explorador de arquivos": ("Explorador de Arquivos", ["explorer"] if IS_WINDOWS else ["nautilus", "dolphin", "thunar"]),
    "explorer": ("Explorador de Arquivos", ["explorer"] if IS_WINDOWS else ["nautilus"]),
    "terminal": ("Terminal", ["wt", "cmd"] if IS_WINDOWS else ["gnome-terminal", "konsole", "xterm"]),
}

_OPEN = re.compile(r"^(?:jarvis[,\s]+)?(?:abr[ae]|abrir|inici[ae]r?|execut[ae]r?|rode|rodar|ligue)\s+(?:o\s+|a\s+)?(.+?)[.!]*$")
_STATUS = re.compile(r"(?:status|uso|consumo|desempenho)\s+(?:do|da|de)?\s*(?:sistema|cpu|processador|mem[oó]ria|ram|computador|pc|gpu|placa de v[ií]deo)"
                     r"|como\s+(?:est[aá]|t[aá])\s+(?:o\s+)?(?:meu\s+)?(?:pc|computador|sistema)|n[ií]vel\s+da\s+bateria", re.I)


class SystemMonitor:
    """Lê CPU, RAM, disco, rede (taxa por segundo), bateria e GPU."""

    def __init__(self):
        self._lock = threading.Lock()
        self._last_net = psutil.net_io_counters()
        self._last_t = time.time()
        self._proc = psutil.Process(os.getpid())
        psutil.cpu_percent(interval=None)
        self._proc.cpu_percent(interval=None)

    def snapshot(self) -> dict:
        with self._lock:
            now, net = time.time(), psutil.net_io_counters()
            dt = max(now - self._last_t, 1e-3)
            down = (net.bytes_recv - self._last_net.bytes_recv) / dt
            up = (net.bytes_sent - self._last_net.bytes_sent) / dt
            self._last_net, self._last_t = net, now
        vm = psutil.virtual_memory()
        disk_root = os.environ.get("SystemDrive", "C:") + "\\" if IS_WINDOWS else "/"
        try:
            disk = psutil.disk_usage(disk_root).percent
        except OSError:
            disk = None
        return {
            "cpu_percent": psutil.cpu_percent(interval=None),
            "cpu_count": psutil.cpu_count(),
            "ram_percent": vm.percent,
            "ram_used_gb": round(vm.used / 1024 ** 3, 1),
            "ram_total_gb": round(vm.total / 1024 ** 3, 1),
            "disk_percent": disk,
            "net_down_mbps": round(down * 8 / 1_000_000, 2),
            "net_up_mbps": round(up * 8 / 1_000_000, 2),
            "battery": battery_info(),
            "gpu": gpu_info(),
            "jarvis_process": {
                "cpu_percent": self._proc.cpu_percent(interval=None),
                "ram_mb": round(self._proc.memory_info().rss / 1024 ** 2, 1),
                "threads": self._proc.num_threads(),
            },
            "os": f"{platform.system()} {platform.release()}",
            "boot_time": psutil.boot_time(),
        }


class SystemTool(Tool):
    name = "system"
    description = "Mostra o uso de CPU/RAM/disco/bateria/GPU e abre programas autorizados (VS Code, Bloco de Notas, Calculadora...)."
    parameters = {
        "action": {"type": "string", "required": True, "enum": ["status", "open_app"]},
        "app": {"type": "string", "description": "nome do programa (open_app)", "enum": sorted(ALLOWED_APPS)},
    }
    priority = 70

    def __init__(self, monitor: SystemMonitor):
        self.monitor = monitor

    @staticmethod
    def _app_key(name: str) -> str | None:
        n = strip_accents(name.lower()).strip(" .!?")
        n = re.sub(r"^(o|a|meu|minha)\s+", "", n)
        return n if n in ALLOWED_APPS else None

    def match(self, text: str) -> dict | None:
        if _STATUS.search(text):
            return {"action": "status"}
        m = _OPEN.match(strip_accents(text.lower()).strip())
        if m and (key := self._app_key(m.group(1))):
            return {"action": "open_app", "app": key}
        return None

    def risk_for(self, args: dict) -> Risk:
        return Risk.MEDIUM if args.get("action") == "open_app" else Risk.LOW

    def describe(self, args: dict) -> str:
        if args.get("action") == "open_app":
            label = ALLOWED_APPS.get(args.get("app", ""), (args.get("app"),))[0]
            return f"abrir o programa {label} no seu computador"
        return super().describe(args)

    def execute(self, action: str, app: str = "") -> ToolResult:
        if action == "status":
            s = self.monitor.snapshot()
            parts = [f"CPU {s['cpu_percent']:.0f}%", f"RAM {s['ram_percent']:.0f}% ({s['ram_used_gb']} de {s['ram_total_gb']} GB)"]
            if s["disk_percent"] is not None:
                parts.append(f"disco {s['disk_percent']:.0f}%")
            if s["battery"]:
                parts.append(f"bateria {s['battery']['percent']}%{' (carregando)' if s['battery']['plugged'] else ''}")
            parts.append(f"GPU {s['gpu']['name']} {s['gpu']['percent']:.0f}%" if s["gpu"] else "GPU: sem leitura (só NVIDIA por enquanto)")
            return ToolResult(True, "Sistema agora: " + ", ".join(parts) + ".", {"system": s})

        if action == "open_app":
            key = self._app_key(app)
            if not key:
                raise ToolError("APP_NOT_ALLOWED", f"“{app}” não está na lista de programas autorizados.")
            label, candidates = ALLOWED_APPS[key]
            exe = next((shutil.which(c) for c in candidates if shutil.which(c)), None)
            if not exe:
                return ToolResult.fail("APP_NOT_FOUND", f"Não encontrei o {label} instalado neste computador.")
            if IS_WINDOWS:
                os.startfile(exe)  # type: ignore[attr-defined]  # trata .exe e .cmd sem usar shell
            else:
                subprocess.Popen([exe], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            return ToolResult(True, f"Abrindo o {label}.", {"app": label, "path": exe})

        raise ToolError("INVALID_ARGS", f"Ação desconhecida: {action}")
