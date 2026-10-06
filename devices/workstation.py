"""
Workstation = o computador onde o backend do JARVIS está rodando.
É o único dispositivo REAL nesta fase: os dados vêm do próprio sistema (psutil).
"""
from __future__ import annotations

import platform
import shutil
import socket
import subprocess

import psutil

from devices import DeviceDriver


def gpu_info() -> dict | None:
    """GPU NVIDIA via nvidia-smi, se existir. Outras GPUs: disponível futuramente."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        ).stdout.strip().splitlines()
        if not out:
            return None
        name, util, used, total, temp = [x.strip() for x in out[0].split(",")]
        return {"name": name, "percent": float(util), "memory_used_mb": float(used), "memory_total_mb": float(total), "temp_c": float(temp)}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def battery_info() -> dict | None:
    try:
        b = psutil.sensors_battery()
    except (AttributeError, NotImplementedError):
        return None
    if b is None:
        return None
    return {"percent": round(b.percent), "plugged": bool(b.power_plugged)}


class WorkstationDriver(DeviceDriver):
    integration = "real"

    def status(self) -> str:
        return "connected"   # se este código roda, a workstation está ativa

    def info(self) -> dict:
        return {
            "hostname": socket.gethostname(),
            "os": f"{platform.system()} {platform.release()}",
            "cpu_percent": psutil.cpu_percent(interval=None),
            "ram_percent": psutil.virtual_memory().percent,
            "battery": battery_info(),
        }
