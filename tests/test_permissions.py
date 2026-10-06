from core.permissions import Decision, PermissionManager, Risk


def test_politica_padrao():
    pm = PermissionManager()
    assert pm.decide("calculator", Risk.LOW) == Decision.ALLOW
    assert pm.decide("files", Risk.MEDIUM) == Decision.CONFIRM
    assert pm.decide("system", Risk.HIGH) == Decision.CONFIRM


def test_risco_medio_configuravel_e_alto_sempre_confirma():
    pm = PermissionManager(medium="allow")
    assert pm.decide("system", Risk.MEDIUM) == Decision.ALLOW
    assert pm.decide("files", Risk.HIGH) == Decision.CONFIRM


def test_ferramenta_bloqueada():
    assert PermissionManager(blocked_tools={"system"}).decide("system", Risk.LOW) == Decision.DENY


def test_fluxo_de_confirmacao():
    pm = PermissionManager()
    pm.request(1, "files", {"action": "write"}, Risk.MEDIUM, "criar arquivo")
    assert pm.resolve(2, "sim") == ("none", None)        # outra conversa não confirma
    verdict, action = pm.resolve(1, "Sim, pode.")
    assert verdict == "yes" and action.tool == "files"
    assert pm.pending(1) is None                          # só vale uma vez


def test_mudar_de_assunto_descarta_pendencia():
    pm = PermissionManager()
    pm.request(1, "files", {}, Risk.MEDIUM, "x")
    assert pm.resolve(1, "quanto é 2+2?")[0] == "none"
    assert pm.pending(1) is None


def test_pendencia_expira():
    pm = PermissionManager()
    a = pm.request(1, "files", {}, Risk.MEDIUM, "x")
    a.created_at -= PermissionManager.TTL_SECONDS + 1
    assert pm.pending(1) is None
