"""
O diálogo da especificação da fase 3, de ponta a ponta (sem internet):

  JARVIS, quem é Tony Stark? → Qual é a relação dele com o Homem-Aranha? →
  Qual armadura apareceu primeiro no MCU? → Qual é a diferença entre MCU e quadrinhos? →
  Pesquise as informações mais recentes. → Continue. → Isso foi criado por quem? → Pare.
"""
from tests.conftest import install_offline

SITE = {"title": "Homem de Ferro: nova armadura anunciada", "url": "https://www.marvel.com/articles/iron-man-armor",
        "snippet": "A Marvel anunciou novidades sobre as armaduras."}
FAN = {"title": "Armor list", "url": "https://marvel.fandom.com/wiki/Iron_Man_Armor", "snippet": "lista de fãs"}


def _prompt(fake_llm) -> str:
    return "\n".join(m.content for m in fake_llm.calls[-1])


def test_dialogo_completo(jarvis, ask, fake_llm):
    install_offline(jarvis, general_available=True,
                    data={"GENERAL_WEB": {"armaduras": [FAN, SITE]}, "MARVEL_OFFICIAL": {"armaduras": [SITE]}})

    r = ask("JARVIS, quem é Tony Stark?")
    assert (r.route, r.tool) == ("tool", "knowledge")
    assert r.data["entities"][0] == "tony-stark" and r.sources
    assert all(s["tier_label"] == "Base de conhecimento local" for s in r.sources)
    assert jarvis.conversation.state(r.conversation_id).topic == "Tony Stark"

    r = ask("Qual é a relação dele com o Homem-Aranha?")
    assert r.tool == "knowledge" and r.data["entities"][:2] == ["tony-stark", "spider-man"]
    p = _prompt(fake_llm)
    assert "[Relações do grafo]" in p and "Peter Parker" in p          # caminho do grafo: Tony → Peter

    r = ask("Qual armadura apareceu primeiro no MCU?")
    assert r.tool == "knowledge" and r.data["universes"] == ["MCU"]
    p = _prompt(fake_llm)
    assert "Mark I" in p
    assert "[Quadrinhos (Terra-616" not in p                          # pediu MCU → não mistura quadrinhos

    r = ask("Qual é a diferença entre MCU e quadrinhos?")
    assert r.tool == "knowledge"                                       # usa o assunto da conversa (armaduras)
    p = _prompt(fake_llm)
    assert "[MCU (filmes" in p and "[Quadrinhos (Terra-616" in p       # os dois universos, separados
    assert "NÃO misture universos" in p

    r = ask("Pesquise as informações mais recentes.")
    assert r.tool == "web"
    assert jarvis.knowledge.providers["GENERAL_WEB"].queries[-1].endswith("sobre Armaduras do Homem de Ferro")
    assert r.sources[0]["domain"] == "marvel.com" and r.sources[0]["tier"] == 1   # oficial antes do fandom
    assert any("comunitária" in " ".join(s["notes"]) for s in r.sources if "fandom" in s["domain"])

    r = ask("Continue.")
    assert r.route == "llm" and "Continue a sua resposta anterior" in _prompt(fake_llm)

    r = ask("Isso foi criado por quem?")
    assert r.tool == "knowledge" and "iron-man-armor" in r.data["entities"]
    assert "Tony Stark criou" in _prompt(fake_llm) or "foi criado por" in _prompt(fake_llm)

    r = ask("Pare.")
    assert (r.route, r.text) == ("command", "Ok, parei.")


def test_dialogo_sem_modelo_responde_pela_base_sem_inventar(jarvis, ask, fake_llm):
    fake_llm.available = False
    jarvis.state.model.available = False
    r = ask("JARVIS, quem é Tony Stark?")
    assert r.route == "tool" and "separado por universo" in r.text and "[MCU" in r.text
    r = ask("Qual armadura apareceu primeiro no MCU?")
    assert "Mark I" in r.text and "Quadrinhos (Terra-616" not in r.text
    r = ask("Pesquise as informações mais recentes.")
    assert not r.sources and "configure TAVILY_API_KEY ou BRAVE_API_KEY" in r.text   # não finge que pesquisou


def test_informacao_atual_sem_chave_e_honesta(ask, fake_llm):
    ask("Quais são as notícias de hoje sobre a Marvel?")
    assert "NÃO está configurada" in _prompt(fake_llm)
