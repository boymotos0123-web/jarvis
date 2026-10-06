import pytest
from fastapi.testclient import TestClient

from server import create_app

H = {"X-JARVIS-Client": "test"}


@pytest.fixture
def client(jarvis):
    with TestClient(create_app(jarvis)) as c:
        yield c


def test_status_real(client):
    body = client.get("/api/status").json()
    assert body["success"] is True
    d = body["data"]
    assert d["online"] is True and d["model"]["available"] is True
    assert d["modules"]["vision"]["camera"] == "not_connected"
    assert d["modules"]["voice"]["capture"] == "navegador"          # microfone fica no navegador, não finge hardware
    assert d["modules"]["knowledge"]["entities"] > 20


def test_chat_fluxo_completo(client):
    r1 = client.post("/api/chat", json={"message": "Meu projeto atual é o JARVIS."}, headers=H).json()
    assert r1["success"] and r1["data"]["route"] == {"type": "tool", "tool": "memory"}
    conv = r1["data"]["conversation_id"]
    r2 = client.post("/api/chat", json={"message": "Qual é meu projeto atual?", "conversation_id": conv}, headers=H).json()
    assert r2["data"]["reply"] == "Seu projeto atual é o JARVIS."
    r3 = client.post("/api/chat", json={"message": "Quanto é 500 * 20?", "conversation_id": conv}, headers=H).json()
    assert r3["data"]["reply"].endswith("10.000")
    r4 = client.post("/api/chat", json={"message": "Olá JARVIS.", "conversation_id": conv}, headers=H).json()
    assert r4["data"]["route"]["type"] == "llm"
    hist = client.get(f"/api/chat/history?conversation_id={conv}").json()["data"]["messages"]
    assert len(hist) == 8


def test_chat_sem_cabecalho_e_recusado(client):
    r = client.post("/api/chat", json={"message": "oi"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"


def test_chat_validacao(client):
    r = client.post("/api/chat", json={"message": ""}, headers=H)
    assert r.status_code == 422 and r.json() == {"success": False, "error": {"code": "INVALID_REQUEST", "message": r.json()["error"]["message"]}}


def test_chat_modelo_indisponivel(client, jarvis):
    from tests.conftest import FakeLLM
    jarvis.brain.llm = FakeLLM(available=False)
    r = client.post("/api/chat", json={"message": "conte uma história"}, headers=H)
    assert r.status_code == 503 and r.json()["error"]["code"] == "MODEL_UNAVAILABLE"


def test_memoria_crud(client):
    r = client.post("/api/memory", json={"content": "Gosto de café.", "category": "preferencias"}, headers=H).json()
    mid = r["data"]["id"]
    lst = client.get("/api/memory").json()["data"]
    assert lst["counts"]["preferencias"] == 1
    assert client.get("/api/memory?q=café").json()["data"]["items"][0]["id"] == mid
    assert client.delete(f"/api/memory/{mid}", headers=H).json()["success"]
    assert client.delete(f"/api/memory/{mid}", headers=H).json()["error"]["code"] == "MEMORY_NOT_FOUND"
    bad = client.post("/api/memory", json={"content": "x", "category": "inventada"}, headers=H)
    assert bad.json()["error"]["code"] == "INVALID_CATEGORY"


def test_projetos(client):
    items = client.get("/api/projects").json()["data"]["items"]
    assert [p["name"] for p in items] == ["JARVIS"]
    p = client.get("/api/projects/jarvis").json()["data"]
    assert p["milestones"][0]["title"] == "Interface HUD v0.1"
    mid = p["milestones"][5]["id"]
    upd = client.patch(f"/api/projects/jarvis/milestones/{mid}", json={"status": "done"}, headers=H).json()["data"]
    assert upd["progress"] > p["progress"]
    assert client.get("/api/projects/axiom-sight").json()["error"]["code"] == "PROJECT_NOT_FOUND"


def test_devices_vision_system(client):
    devs = client.get("/api/devices").json()["data"]["items"]
    assert sum(d["status"] == "connected" for d in devs) == 1
    assert client.get("/api/vision/status").json()["data"]["signal"] == "SINAL ÓPTICO AUSENTE"
    v = client.post("/api/vision/start", headers=H)
    assert v.status_code == 409 and v.json()["error"]["code"] == "CAMERA_NOT_CONNECTED"
    s = client.get("/api/system/status").json()["data"]
    assert 0 <= s["cpu_percent"] <= 100 and s["modules"][0]["name"] == "core.brain"


def test_endpoint_inexistente(client):
    r = client.get("/api/nada")
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"


def test_interface_servida(client):
    r = client.get("/")
    assert r.status_code == 200 and "JARVIS" in r.text


def test_eventos_recentes(client):
    client.post("/api/chat", json={"message": "2+2"}, headers=H)
    types = [e["type"] for e in client.get("/api/events/recent").json()["data"]["items"]]
    assert "TOOL_STARTED" in types and "AI_RESPONSE" in types
