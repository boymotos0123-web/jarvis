"""
Dispositivos do JARVIS.

Cada dispositivo tem um driver em devices/<driver>.py. O `DeviceManager`
combina o cadastro (tabela `devices`) com o estado REAL informado pelo driver.
Um dispositivo só aparece como 'connected' se o driver confirmar.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod

log = logging.getLogger("jarvis.devices")


class DeviceDriver(ABC):
    """Contrato de todo driver de dispositivo."""
    integration = "real"        # real | future

    @abstractmethod
    def status(self) -> str:    # connected | not_connected
        ...

    def info(self) -> dict:
        return {}


class PendingDriver(DeviceDriver):
    """Driver de um dispositivo cuja integração ainda não existe."""
    integration = "future"
    planned_protocol = ""
    phase = "FASE 8"

    def status(self) -> str:
        return "not_connected"

    def info(self) -> dict:
        return {"note": f"Integração disponível futuramente ({self.phase})", "planned_protocol": self.planned_protocol}


class DeviceManager:
    def __init__(self, db, events=None):
        from devices.ar_glasses import ARGlassesDriver
        from devices.axiom_band import AxiomBandDriver
        from devices.smartphone import SmartphoneDriver
        from devices.workstation import WorkstationDriver

        self.db = db
        self.events = events
        self.drivers: dict[str, DeviceDriver] = {
            "workstation": WorkstationDriver(),
            "smartphone": SmartphoneDriver(),
            "axiom_band": AxiomBandDriver(),
            "ar_glasses": ARGlassesDriver(),
            "camera": CameraDriver(),
        }

    def list(self) -> list[dict]:
        out = []
        for row in self.db.all("SELECT * FROM devices WHERE enabled = 1 ORDER BY rowid"):
            driver = self.drivers.get(row["driver"])
            status = driver.status() if driver else "not_connected"
            out.append({
                "id": row["id"], "name": row["name"], "kind": row["kind"], "icon": row["icon"],
                "protocol": row["protocol"], "status": status,
                "integration": driver.integration if driver else "future",
                "info": driver.info() if driver else {"note": "driver não encontrado"},
            })
        return out

    def get(self, device_id: str) -> dict | None:
        return next((d for d in self.list() if d["id"] == device_id), None)


class CameraDriver(PendingDriver):
    planned_protocol = "USB / webcam (OpenCV)"
    phase = "FASE 6"
