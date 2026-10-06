import pytest

from tools import ToolError
from tools.calculator import CalculatorTool, evaluate, format_number, to_expression
from tools.files import FilesTool


@pytest.mark.parametrize("expr,expected", [
    ("500 * 20", 10000), ("2^10", 1024), ("10% de 300", 30), ("2,5 x 4", 10), ("sqrt(81)", 9), ("(1+2)*3", 9),
    ("5 vezes 3", 15),
])
def test_calculadora(expr, expected):
    assert evaluate(to_expression(expr)) == pytest.approx(expected)


@pytest.mark.parametrize("evil", ["__import__('os').system('dir')", "open('x')", "().__class__", "2**999999", "a+1", "lambda: 1"])
def test_calculadora_recusa_codigo(evil):
    with pytest.raises(ToolError):
        evaluate(evil)


def test_divisao_por_zero():
    with pytest.raises(ToolError) as e:
        evaluate("1/0")
    assert e.value.code == "DIVISION_BY_ZERO"


def test_formato_brasileiro():
    assert format_number(10000) == "10.000"
    assert format_number(2.5) == "2,5"
    assert format_number(1234567.891) == "1.234.567,891"


def test_resultado_calculadora():
    r = CalculatorTool().execute("500 * 20")
    assert r.ok and r.message == "500 × 20 = 10.000"


def test_files_bloqueia_fuga_da_pasta(tmp_path):
    tool = FilesTool(tmp_path / "ws")
    with pytest.raises(ToolError) as e:
        tool.execute("read", path="../../segredo.txt")
    assert e.value.code == "PATH_NOT_ALLOWED"


def test_files_ler_listar_buscar(tmp_path):
    tool = FilesTool(tmp_path / "ws")
    (tmp_path / "ws" / "projeto.txt").write_text("JARVIS fase 1\nmemória ok", encoding="utf-8")
    assert "projeto.txt" in tool.execute("list").message
    r = tool.execute("read", path="projeto.txt")
    assert r.ok and "JARVIS fase 1" in r.data["content"] and r.summarize
    assert tool.execute("search", query="memória").data["hits"][0]["line"] == 2
    assert tool.execute("read", path="nao_existe.txt").error_code == "FILE_NOT_FOUND"


def test_web_sem_resultados_nao_inventa(jarvis, offline_search):
    import asyncio
    r = asyncio.run(jarvis.tools.arun("web", {"query": "assunto inexistente xyz"}))
    assert not r.ok and r.error_code == "NO_RESULTS"


def test_projetos_somente_jarvis(jarvis):
    items = jarvis.projects.list_projects()
    assert [p["slug"] for p in items] == ["jarvis"]
    assert items[0]["subtitle"] == "JARVIS CORE" and items[0]["status"] == "Em desenvolvimento"


def test_projetos_aceitam_novos_dinamicamente(jarvis):
    jarvis.db.execute("INSERT INTO projects (slug, code, name, status) VALUES ('teste','PRJ-002','Teste','Pesquisa')")
    assert len(jarvis.projects.list_projects()) == 2


def test_system_status_e_app_fora_da_lista(jarvis):
    r = jarvis.tools.run("system", {"action": "status"})
    assert r.ok and "CPU" in r.message
    bad = jarvis.tools.run("system", {"action": "open_app", "app": "format c:"})
    assert not bad.ok and bad.error_code == "INVALID_ARGS"


def test_dispositivos_nao_fingem_conexao(jarvis):
    items = {d["id"]: d for d in jarvis.devices.list()}
    assert items["workstation"]["status"] == "connected"
    for dev in ("smartphone", "axiom_band", "ar_glasses", "camera_main"):
        assert items[dev]["status"] == "not_connected" and items[dev]["integration"] == "future"


def test_registry_ferramenta_inexistente(jarvis):
    assert jarvis.tools.run("nao_existe", {}).error_code == "TOOL_NOT_FOUND"
