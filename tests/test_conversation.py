"""Conversation Engine: comandos, referências, assunto e continuidade."""
import pytest

from core.conversation import Command, ConversationEngine, extract_options, extract_topic


@pytest.mark.parametrize("text,cmd", [
    ("Pare.", Command.STOP), ("JARVIS, para!", Command.STOP), ("espera", Command.STOP),
    ("cancela", Command.CANCEL), ("Esquece.", Command.CANCEL), ("deixa pra lá", Command.CANCEL),
    ("Continue.", Command.CONTINUE), ("pode continuar", Command.CONTINUE),
    ("volta", Command.BACK), ("volta pro assunto anterior", Command.BACK),
    ("repete", Command.REPEAT), ("o que você disse?", Command.REPEAT),
    ("me explica melhor", Command.EXPLAIN_MORE), ("como assim?", Command.EXPLAIN_MORE),
    ("fala de outro jeito", Command.REPHRASE), ("mais simples", Command.REPHRASE),
    ("resume isso", Command.SUMMARIZE),
])
def test_comandos_de_conversa(text, cmd):
    assert ConversationEngine.classify_command(text) == cmd


@pytest.mark.parametrize("text", ["para que serve o reator arc?", "pare de usar gírias nas respostas",
                                  "continue pesquisando sobre o Mark III", "esquece a reunião de amanhã e anota outra"])
def test_frases_normais_nao_viram_comando(text):
    assert ConversationEngine.classify_command(text) == Command.NONE


def test_referencia_vira_pergunta_independente(jarvis):
    eng, conv = jarvis.conversation, jarvis.conversations.create()
    eng.record(conv, "quem é Tony Stark?", "…", "tool", "knowledge", topic="Tony Stark")
    a = eng.analyze(conv, "Qual é a relação dele com o Homem-Aranha?")
    assert a.is_followup and a.references[0] == "dele"
    assert a.standalone == "Qual é a relação de Tony Stark com o Homem-Aranha?"
    assert "Tony Stark" in a.note
    b = eng.analyze(conv, "Isso foi criado por quem?")
    assert b.standalone == "Tony Stark foi criado por quem?"


def test_pesquisa_vaga_recebe_o_assunto(jarvis):
    eng, conv = jarvis.conversation, jarvis.conversations.create()
    q, changed = eng.contextualize_query(conv, "as informações mais recentes")
    assert not changed                                   # sem assunto, não inventa um
    eng.record(conv, "fale do Mark III", "…", "tool", topic="Mark III")
    q, changed = eng.contextualize_query(conv, "as informações mais recentes")
    assert changed and q == "as informações mais recentes sobre Mark III"
    q, changed = eng.contextualize_query(conv, "preço da RTX 5090")
    assert not changed and q == "preço da RTX 5090"      # pergunta específica fica como está


def test_assunto_pilha_e_voltar(jarvis):
    eng, conv = jarvis.conversation, jarvis.conversations.create()
    eng.record(conv, "x", "a", "tool", topic="Tony Stark")
    eng.record(conv, "y", "b", "tool", topic="Peter Parker")
    assert eng.state(conv).topic == "Peter Parker"
    a = eng.analyze(conv, "volta")
    assert a.command == Command.BACK and "Tony Stark" in a.note
    eng.record(conv, "volta", "c", "llm", analysis=a)
    assert eng.state(conv).topic == "Tony Stark"


def test_assunto_sobrevive_a_reinicio(jarvis):
    conv = jarvis.conversations.create()
    jarvis.conversation.record(conv, "x", "a", "tool", topic="Reator Arc")
    novo = ConversationEngine(jarvis.db)                 # outra instância = JARVIS reiniciado
    assert novo.state(conv).topic == "Reator Arc"


def test_a_outra_opcao(jarvis):
    eng, conv = jarvis.conversation, jarvis.conversations.create()
    eng.record(conv, "opções de placa?", "Tenho duas:\n1. Raspberry Pi 5\n2. Orange Pi 5", "llm", topic="placas")
    a = eng.analyze(conv, "e a outra opção?")
    assert "Raspberry Pi 5" in a.note and "Orange Pi 5" in a.note


def test_extract_topic_e_opcoes():
    assert extract_topic("JARVIS, pesquise a evolução das armaduras do Tony Stark") == "a evolução das armaduras do Tony Stark"
    assert extract_topic("isso") is None
    assert extract_options("- Opção rápida\n- Opção barata") == ["Opção rápida", "Opção barata"]


def test_comandos_no_cerebro(ask, fake_llm):
    ask("Meu nome é José.")
    assert ask("Pare.").text == "Ok, parei."
    assert ask("cancela").text == "Cancelado."
    r = ask("repete")
    assert r.route == "command" and r.text == "Cancelado."
    ask("Continue.")
    sent = fake_llm.calls[-1][0].content
    assert "Continue a sua resposta anterior" in sent


def test_historico_nao_envia_respostas_canceladas(jarvis, ask, fake_llm):
    r = ask("oi")
    jarvis.conversations.add(r.conversation_id, "assistant", "resposta cortada", route="cancelled")
    ask("tudo bem?")
    contents = [m.content for m in fake_llm.calls[-1]]
    assert "resposta cortada" not in " ".join(contents)
