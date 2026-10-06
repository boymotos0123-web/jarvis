"""Axiom Band (FASE 8). Pulseira própria; plano: ESP32 com Bluetooth Low Energy."""
from devices import PendingDriver


class AxiomBandDriver(PendingDriver):
    planned_protocol = "Bluetooth Low Energy (BLE)"
