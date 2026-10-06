"""Smartphone (FASE 8). Plano: app/página no celular conectada por WebSocket ao backend."""
from devices import PendingDriver


class SmartphoneDriver(PendingDriver):
    planned_protocol = "WebSocket (Wi-Fi local)"
