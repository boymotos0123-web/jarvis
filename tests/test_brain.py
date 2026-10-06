"""Primeiro marco funcional: os 4 testes do ciclo completo + regras do cérebro."""
from tests.conftest import FakeLLM


def test_1_ola_jarvis_responde_pelo_modelo(ask, fake_llm):
    r = ask("Olá JARVIS.")
    assert r.route == "llm"
    assert "JARVIS" in r.text
    system = fake_llm.calls[-1][0]
    assert system.role == "system" and "Você é JARVIS" in system.content
    assert fake_llm.calls[-1][-1].content == "Olá JARVIS."


def test_2_salva_projeto_atual_na_memoria(ask, jarvis):
    r = ask("Meu projeto atual é o JARVIS.")
    assert r.route == "tool" and r.tool == "memory"
    mem = jarvis.memory.recall("projeto atual")
    assert mem is not None and "JARVIS" in mem.content
    assert mem.category == "projetos"


def test_3_consulta_projeto_atual(ask):
    ask("Meu projeto atual é o JARVIS.")
    r = ask("Qual é meu projeto atual?")
    assert r.tool == "memory"
    assert r.text == "Seu projeto atual é o JARVIS."


def test_4_calculadora(ask, fake_llm):
    r = ask("Quanto é 500 * 20?")
    assert r.tool == "calculator"
    assert r.text.endswith("= 10.000")
    assert fake_llm.calls == []          # nem precisou do modelo


def test_memoria_entra_no_contexto_do_modelo(ask, fake_llm):
    ask("Meu projeto atual é o JARVIS.")
    ask("Continue aquele projeto.")
    system = fake_llm.calls[-1][0].content
    assert "Meu projeto atual é o JARVIS." in system
    assert "Projeto atual: JARVIS" in system


def test_modelo_pede_ferramenta_e_recebe_resultado(jarvis, ask):
    jarvis.brain.llm = FakeLLM([
        'TOOL_CALL {"tool": "calculator", "args": {"expression": "12*12"}}',
        lambda msgs: "Deu " + ("144" if "144" in msgs[-1].content else "?"),
    ])
    r = ask("me ajuda com uma conta de cabeça: doze vezes doze dá quanto, aproximadamente")
    assert r.text == "Deu 144"
    assert r.tool == "calculator"


def test_criar_arquivo_novo_e_automatico(jarvis, ask):
    """Fase 3: criar conteúdo no workspace é baixo risco → executa sem perguntar."""
    jarvis.brain.llm = FakeLLM(['TOOL_CALL {"tool": "files", "args": {"action": "write", "path": "nota.txt", "content": "oi"}}', "Criei a nota."])
    r = ask("crie uma nota para mim")
    assert r.route == "tool" and r.tool == "files"
    assert (jarvis.config.workspace_dir / "nota.txt").read_text(encoding="utf-8") == "oi"


def test_sobrescrever_arquivo_exige_confirmacao(jarvis, ask):
    (jarvis.config.workspace_dir / "nota.txt").write_text("original", encoding="utf-8")
    jarvis.brain.llm = FakeLLM(['TOOL_CALL {"tool": "files", "args": {"action": "write", "path": "nota.txt", "content": "novo"}}'])
    r = ask("troque o conteúdo da nota")
    assert r.route == "confirm" and r.pending["tool"] == "files" and r.pending["risk"] == "high"
    assert (jarvis.config.workspace_dir / "nota.txt").read_text(encoding="utf-8") == "original"
    r2 = ask("sim")
    assert r2.tool == "files" and "salvo" in r2.text
    assert (jarvis.config.workspace_dir / "nota.txt").read_text(encoding="utf-8") == "novo"


def test_confirmacao_negada_nao_executa(jarvis, ask):
    (jarvis.config.workspace_dir / "x.txt").write_text("manter", encoding="utf-8")
    jarvis.brain.llm = FakeLLM(['TOOL_CALL {"tool": "files", "args": {"action": "write", "path": "x.txt", "content": "z"}}'])
    ask("reescreva o arquivo x")
    r = ask("não")
    assert r.route == "cancelled"
    assert (jarvis.config.workspace_dir / "x.txt").read_text(encoding="utf-8") == "manter"


def test_sem_modelo_retorna_erro_claro(jarvis, ask):
    jarvis.brain.llm = FakeLLM(available=False)
    r = ask("Me conte uma piada")
    assert r.route == "error" and r.error["code"] == "MODEL_UNAVAILABLE"
    # ferramentas continuam funcionando sem o modelo
    assert ask("quanto é 2+2").text.endswith("= 4")


def test_historico_e_salvo(ask, jarvis):
    r = ask("Quanto é 3*3?")
    hist = jarvis.conversations.history(r.conversation_id)
    assert [h["role"] for h in hist] == ["user", "assistant"]
    assert hist[1]["route"] == "tool:calculator"
