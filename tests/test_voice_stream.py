"""Voz (prosódia, TTS), streaming (SSE + cancelamento), orquestração em etapas e métricas."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from core.planner import is_multistep, make_plan
from core.state import Phase
from models import llm as L
from models.text_to_speech import NoTextToSpeech, TTSUnavailable
from server import create_app
from voice.prosody import classify, plan, split_sentences
from tests.conftest import FakeLLM

H = {"X-JARVIS-Client": "test"}


@pytest.fixture
def client(jarvis):
    with TestClient(create_app(jarvis)) as c:
        yield c


def parse_sse(text: str) -> list[dict]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "data" in lines:
            out.append({"event": lines.get("event"), **json.loads(lines["data"])})
    return out


# ---------------------------------------------------------------- prosódia
def test_frases_e_limpeza_para_fala():
    s = split_sentences("**Pronto!** Veja em https://x.com [1]. Quer que eu continue?")
    assert s == ["Pronto!", "Veja em.", "Quer que eu continue?"]


@pytest.mark.parametrize("sentence,style", [
    ("Quer que eu continue?", "question"), ("Atenção: isso é irreversível.", "warning"),
    ("Não consegui acessar o modelo.", "error"), ("Pronto, funcionou!", "excited"),
    ("1. Primeiro passo.", "list"), ("O reator fica no peito.", "casual"),
])
def test_estilo_por_frase(sentence, style):
    assert classify(sentence) == style


def test_plano_de_fala_tem_pausas_e_entonacao():
    u = plan("Encontrei duas fontes. Quer que eu leia?", base_rate=0)
    assert [x.style for x in u] == ["casual", "question"]
    assert u[1].pitch > u[0].pitch and all(x.pause_ms > 0 for x in u)


def test_tts_indisponivel_e_honesto(client, jarvis):
    jarvis.voice.tts = NoTextToSpeech()
    with pytest.raises(TTSUnavailable):
        asyncio.run(jarvis.voice.tts.synthesize("oi"))
    r = client.post("/api/voice/tts", json={"text": "oi"}, headers=H)
    assert r.status_code == 503 and r.json()["error"]["code"] == "TTS_UNAVAILABLE"


def test_tts_endpoint_devolve_audio(client, jarvis):
    class FakeTTS:
        last_ms = 12.0

        async def synthesize(self, text, rate=0, pitch=0):
            return b"ID3fake-mp3"
    jarvis.voice.tts = FakeTTS()
    r = client.post("/api/voice/tts", json={"text": "Olá, José."}, headers=H)
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3fake-mp3"
    assert r.headers["x-tts-ms"] == "12"


def test_voz_status_e_estado(client, jarvis):
    st = client.get("/api/voice/status").json()["data"]
    assert st["capture"] == "navegador"                       # não finge microfone no servidor
    client.post("/api/voice/state", json={"listening": True}, headers=H)
    assert jarvis.state.phase == Phase.LISTENING
    assert client.post("/api/voice/stt", content=b"x", headers=H).status_code == 409   # modo navegador


# ---------------------------------------------------------------- streaming
class ChunkLLM(FakeLLM):
    def __init__(self, chunks, delay=0.0):
        super().__init__()
        self.chunks, self.delay = chunks, delay

    async def stream(self, messages):
        self.calls.append(list(messages))
        for c in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield c


def test_stream_sse_entrega_estados_deltas_e_done(client, jarvis):
    jarvis.brain.llm = ChunkLLM(["Olá, ", "José. ", "Tudo pronto."])
    r = client.post("/api/chat/stream", json={"message": "oi"}, headers=H)
    assert r.headers["content-type"].startswith("text/event-stream")
    evs = parse_sse(r.text)
    kinds = [e["event"] for e in evs]
    assert kinds[:2] == ["start", "state"] and kinds[-1] == "done"
    assert evs[0]["conversation_id"] == evs[-1]["conversation_id"]
    assert "".join(e["text"] for e in evs if e["event"] == "delta") == "Olá, José. Tudo pronto."
    phases = [e["phase"] for e in evs if e["event"] == "state"]
    assert "THINKING" in phases and phases[-1] == "IDLE"
    done = evs[-1]
    assert done["reply"] == "Olá, José. Tudo pronto." and done["metrics"]["llm_first_ms"] is not None
    assert "_reply" not in done


def test_stream_esconde_tool_call_e_mostra_fontes(client, jarvis):
    jarvis.brain.llm = ChunkLLM(["TOOL_CALL ", '{"tool": "calculator", "args": {"expression": "2+2"}}'])
    r = client.post("/api/chat/stream", json={"message": "faz uma conta pra mim"}, headers=H)
    evs = parse_sse(r.text)
    assert not any("TOOL_CALL" in e.get("text", "") for e in evs if e["event"] == "delta")
    assert any(e["event"] == "tool" and e["tool"] == "calculator" for e in evs)

    r = client.post("/api/chat/stream", json={"message": "quem é Tony Stark?"}, headers=H)
    evs = parse_sse(r.text)
    src = next(e for e in evs if e["event"] == "sources")
    assert src["items"] and "SEARCHING" not in [e.get("phase") for e in evs]   # base local não é "pesquisa"


def test_web_mostra_fase_searching(client, offline_search):
    evs = parse_sse(client.post("/api/chat/stream", json={"message": "pesquise sobre reator arc"}, headers=H).text)
    assert "SEARCHING" in [e.get("phase") for e in evs]


def test_cancelar_geracao_guarda_parcial(jarvis):
    jarvis.brain.llm = ChunkLLM(["Primeira parte. ", "segunda ", "terceira ", "quarta."], delay=0.05)

    async def run():
        got, conv = [], None
        async for ev in jarvis.brain.handle_stream("conte uma história"):
            conv = conv or ev.get("conversation_id")
            if ev["event"] == "delta":
                got.append(ev["text"])
                if len(got) == 1:
                    break                                   # cliente saiu (barge-in / botão parar)
        return got
    got = asyncio.run(run())
    assert got == ["Primeira parte. "]
    last = jarvis.conversations.history(jarvis.conversations.latest(), 5)[-1]
    assert last["route"] == "cancelled" and last["content"] == "Primeira parte."


def test_cancel_endpoint(client):
    assert client.post("/api/chat/cancel", json={"conversation_id": 999}, headers=H).json()["data"] == {"cancelled": False}


# ---------------------------------------------------------------- LLM streaming (protocolos)
def test_stream_openai_compativel(monkeypatch):
    body = 'data: {"choices":[{"delta":{"content":"Olá"}}]}\n\ndata: {"choices":[{"delta":{"content":", José"}}]}\n\ndata: [DONE]\n\n'
    real = httpx.AsyncClient
    monkeypatch.setattr(L.httpx, "AsyncClient", lambda **kw: real(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, text=body)), **{k: v for k, v in kw.items() if k != "transport"}))
    p = L.OpenAICompatibleProvider(model="m", base_url="http://x/v1", api_key="k", provider="openai")

    async def run():
        return [c async for c in p.stream([L.Message("user", "oi")])]
    assert asyncio.run(run()) == ["Olá", ", José"]


# ---------------------------------------------------------------- orquestração
def test_detecta_tarefa_de_varias_etapas():
    assert is_multistep("Pesquise placas de vídeo, compare os preços e me recomende a melhor")
    assert not is_multistep("pesquise placas de vídeo")


def test_plano_so_usa_ferramentas_permitidas():
    llm = FakeLLM(['[{"tool":"calculator","args":{"expression":"1+1"},"goal":"somar"},{"tool":"rm_rf","args":{}},'
                   '{"tool":"memory","args":{"action":"list"},"goal":"ver"}]'])
    steps = asyncio.run(make_plan(llm, "x", "catálogo", {"calculator", "memory"}))
    assert [s.tool for s in steps] == ["calculator", "memory"]
    assert asyncio.run(make_plan(FakeLLM(["não sei"]), "x", "", {"calculator"})) == []


def test_tarefa_em_etapas_executa_e_sintetiza(ask, fake_llm):
    fake_llm.replies = ['[{"tool":"calculator","args":{"expression":"500*20"},"goal":"calcular o total"},'
                        '{"tool":"knowledge","args":{"question":"quem criou o reator arc?"},"goal":"consultar a base"}]',
                        "Total 10.000 e o reator foi criado por Tony Stark."]
    r = ask("Calcule 500 vezes 20 e depois pesquise quem criou o reator arc")
    assert r.route == "plan" and r.tools_used == ["calculator", "knowledge"]
    final = fake_llm.calls[-1][-1].content
    assert "ETAPA 1" in final and "ETAPA 2" in final and "Não invente" in final


def test_etapa_de_risco_pausa_o_plano(ask, fake_llm, jarvis):
    (jarvis.config.workspace_dir / "notas.txt").write_text("importante", encoding="utf-8")
    fake_llm.replies = ['[{"tool":"calculator","args":{"expression":"2+2"},"goal":"somar"},'
                        '{"tool":"files","args":{"action":"write","path":"notas.txt","content":"novo"},"goal":"salvar"}]']
    r = ask("Calcule 2+2 e depois salve o resultado em notas.txt")
    assert r.route == "confirm" and "etapa 2" in r.text.lower()
    assert (jarvis.config.workspace_dir / "notas.txt").read_text(encoding="utf-8") == "importante"


# ---------------------------------------------------------------- métricas
def test_metricas_registradas(client, jarvis):
    client.post("/api/chat", json={"message": "quanto é 2+2?"}, headers=H)
    client.post("/api/metrics/client", json={"stt_ms": 300, "tts_ms": 150}, headers=H)
    data = client.get("/api/metrics/recent").json()["data"]
    assert data["items"] and data["items"][0]["total_ms"] is not None and "summary" in data
