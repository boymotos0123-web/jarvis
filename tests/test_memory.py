from core.memory import ConversationStore, MemoryStore, normalize_key
from database import Database


def make(tmp_path):
    db = Database(tmp_path / "m.db")
    db.migrate()
    return MemoryStore(db), ConversationStore(db)


def test_normalize_key():
    assert normalize_key("Meu Projeto Atual") == "projeto atual"
    assert normalize_key("a cidade onde moro?") == "cidade onde moro"


def test_remember_upsert_por_chave(tmp_path):
    mem, _ = make(tmp_path)
    a = mem.remember("Meu projeto atual é o JARVIS.", "projetos", "projeto atual")
    b = mem.remember("Meu projeto atual é o Dum-E.", "projetos", "projeto atual")
    assert a.id == b.id and "Dum-E" in mem.recall("projeto atual").content
    assert len(mem.list()) == 1


def test_recall_parcial_e_busca(tmp_path):
    mem, _ = make(tmp_path)
    mem.remember("Eu moro em Ivinhema, MS.", "pessoal", "cidade onde mora")
    mem.remember("Eu gosto de café forte.", "preferencias")
    assert mem.recall("cidade").content.startswith("Eu moro")
    assert [m.content for m in mem.search("onde fica Ivinhema")] == ["Eu moro em Ivinhema, MS."]
    assert mem.counts()["preferencias"] == 1


def test_categoria_invalida(tmp_path):
    mem, _ = make(tmp_path)
    try:
        mem.remember("x", "inventada")
        assert False
    except ValueError:
        pass


def test_forget(tmp_path):
    mem, _ = make(tmp_path)
    m = mem.remember("nota", "sistema")
    assert mem.forget(m.id) and mem.get(m.id) is None


def test_conversas(tmp_path):
    _, conv = make(tmp_path)
    c = conv.create()
    conv.add(c, "user", "oi")
    conv.add(c, "assistant", "olá", "llm")
    assert conv.latest() == c
    assert [m["content"] for m in conv.history(c)] == ["oi", "olá"]


def test_migrations_idempotentes(tmp_path):
    db = Database(tmp_path / "x.db")
    assert db.migrate() == ["001_initial.sql", "002_phase3.sql"]
    assert db.migrate() == []
