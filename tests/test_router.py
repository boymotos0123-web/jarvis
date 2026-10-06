import pytest

from core.router import Router


@pytest.fixture
def router(jarvis):
    return Router(jarvis.tools)


@pytest.mark.parametrize("text,tool", [
    ("Quanto é 500 * 20?", "calculator"),
    ("calcule 10% de 300", "calculator"),
    ("2+2", "calculator"),
    ("Meu projeto atual é o JARVIS.", "memory"),
    ("Qual é meu projeto atual?", "memory"),
    ("Lembre que eu acordo às 6h", "memory"),
    ("O que você sabe sobre mim?", "memory"),
    ("Leia meu arquivo projeto.txt", "files"),
    ("liste meus arquivos", "files"),
    ("Pesquise novidades sobre realidade aumentada", "web"),
    ("Abra o VS Code", "system"),
    ("como está o meu pc?", "system"),
    ("abra o site github.com", "browser"),
    ("quais são meus projetos", "projects"),
    ("quais dispositivos estão conectados?", "devices"),
    ("a câmera está ligada?", "camera"),
])
def test_rotas_para_ferramentas(router, text, tool):
    route = router.route(text)
    assert route.kind == "tool" and route.tool == tool, route


@pytest.mark.parametrize("text", ["Olá JARVIS.", "Me explique o que é um transistor", "Continue aquele projeto.", "abra o photoshop"])
def test_rotas_para_o_modelo(router, text):
    assert router.route(text).kind == "llm"


def test_parse_tool_request():
    assert Router.parse_tool_request('TOOL_CALL {"tool": "calculator", "args": {"expression": "1+1"}}') == ("calculator", {"expression": "1+1"})
    assert Router.parse_tool_request('ok TOOL_CALL {"tool":"web","args":{"query":"x"}} fim') == ("web", {"query": "x"})
    assert Router.parse_tool_request("resposta normal") is None
    assert Router.parse_tool_request("TOOL_CALL {quebrado") is None
