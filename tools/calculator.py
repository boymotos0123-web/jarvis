"""
Calculadora segura.

Avalia expressões com a árvore sintática do Python (ast) aceitando SOMENTE
números, operadores aritméticos e funções matemáticas de uma lista fechada.
Nada de eval(): não há como executar código por aqui.
"""
from __future__ import annotations

import ast
import math
import operator
import re

from core.memory import strip_accents
from tools import Tool, ToolError, ToolResult

_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {"sqrt": math.sqrt, "raiz": math.sqrt, "abs": abs, "round": round, "sin": math.sin, "cos": math.cos,
          "tan": math.tan, "log": math.log10, "ln": math.log, "exp": math.exp, "floor": math.floor, "ceil": math.ceil}
_CONSTS = {"pi": math.pi, "e": math.e}
_MAX_POW = 10_000
_MAX_LEN = 200

_TRIGGER = re.compile(r"^(?:jarvis[,\s]+)?(?:quanto\s+(?:e|da|eh|fica|vale)|calcul[ae]r?|resolv[ae]r?|conta:?)\s+(.+?)\s*\??$")
_PURE = re.compile(r"^[\d\s.,+\-*/()^%x×÷]+$")
_WORDS = [(r"\bvezes\b", "*"), (r"\bmultiplicado por\b", "*"), (r"\bdividido por\b", "/"), (r"\bmais\b", "+"),
          (r"\bmenos\b", "-"), (r"\belevado a\b", "**"), (r"\bao quadrado\b", "**2"), (r"\bao cubo\b", "**3"),
          (r"\braiz quadrada de\s+([\d.]+)", r"sqrt(\1)")]


def to_expression(text: str) -> str:
    t = strip_accents(text.lower()).strip(" ?=")
    t = re.sub(r"(\d+(?:[.,]\d+)?)\s*%\s*de\s*(\d+(?:[.,]\d+)?)", r"(\1/100*\2)", t)  # 10% de 500
    for pat, rep in _WORDS:
        t = re.sub(pat, rep, t)
    t = t.replace("×", "*").replace("÷", "/").replace("^", "**")
    t = re.sub(r"(?<=\d)\s*x\s*(?=\d)", "*", t)
    t = re.sub(r"(\d),(\d)", r"\1.\2", t)          # vírgula decimal (pt-BR)
    return t.strip()


def evaluate(expression: str) -> float | int:
    if len(expression) > _MAX_LEN:
        raise ToolError("EXPRESSION_TOO_LONG", "Expressão longa demais.")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise ToolError("INVALID_EXPRESSION", "Não entendi essa expressão matemática.")

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > _MAX_POW:
                raise ToolError("EXPRESSION_TOO_LARGE", "Expoente grande demais.")
            return _BIN[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
            return _UNARY[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS and not node.keywords:
            return _FUNCS[node.func.id](*[ev(a) for a in node.args])
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ToolError("INVALID_EXPRESSION", "A expressão contém algo que não é matemática.")

    try:
        return ev(tree)
    except ZeroDivisionError:
        raise ToolError("DIVISION_BY_ZERO", "Divisão por zero não tem resultado.")
    except (OverflowError, ValueError) as e:
        raise ToolError("MATH_ERROR", f"Erro matemático: {e}")


def format_number(value: float | int) -> str:
    """Formato brasileiro: 10000 -> 10.000 ; 2.5 -> 2,5"""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        value = int(value)
    if isinstance(value, int):
        return f"{value:,}".replace(",", ".")
    text = f"{value:,.6f}".rstrip("0").rstrip(".")
    return text.replace(",", "§").replace(".", ",").replace("§", ".")


class CalculatorTool(Tool):
    name = "calculator"
    description = "Calcula expressões matemáticas com segurança (ex.: 500*20, 10% de 300, sqrt(2))."
    parameters = {"expression": {"type": "string", "required": True, "description": "expressão matemática"}}
    priority = 10

    def match(self, text: str) -> dict | None:
        t = strip_accents(text.lower()).strip()
        m = _TRIGGER.match(t)
        if m and re.search(r"\d", m.group(1)):
            return {"expression": m.group(1)}
        if _PURE.match(t) and re.search(r"\d\s*[+\-*/^x×÷%]\s*\d", t):
            return {"expression": t}
        return None

    def execute(self, expression: str) -> ToolResult:
        expr = to_expression(expression)
        value = evaluate(expr)
        pretty = expr.replace("**", "^").replace("*", " × ").replace("/", " ÷ ")
        pretty = re.sub(r"\s+", " ", pretty).strip()
        result = format_number(value)
        return ToolResult(True, f"{pretty} = {result}", {"expression": expr, "result": value, "formatted": result})
