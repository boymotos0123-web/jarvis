"""
Prosódia — como cada frase deve SOAR.

Divide o texto em frases (para começar a falar antes da resposta inteira
chegar) e escolhe um estilo por frase:

  pergunta   → entonação subindo          aviso  → mais lento e mais grave
  erro       → calmo e objetivo           entusiasmo → um pouco mais rápido e agudo
  casual     → natural

O mesmo algoritmo existe em JavaScript na interface (voz do navegador).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

STYLES = {
    #            rate  pitch(Hz) pausa depois(ms)
    "casual":   (4,    0,        250),
    "question": (2,    6,        350),
    "warning":  (-8,   -4,       400),
    "error":    (-5,   -2,       350),
    "excited":  (8,    5,        250),
    "list":     (0,    0,        300),
}

_WARNING = re.compile(r"\b(aten[cç][aã]o|cuidado|aviso|importante|risco|perigo|n[aã]o recomendo|irrevers[ií]vel)\b", re.I)
_ERROR = re.compile(r"\b(erro|falhou|falha|n[aã]o consegui|indispon[ií]vel|n[aã]o est[aá] (?:conectad|configurad))", re.I)
_EXCITED = re.compile(r"(!|\b(excelente|perfeito|incr[ií]vel|[oó]timo|consegui|pronto|funcionou)\b)", re.I)


@dataclass
class Utterance:
    text: str
    style: str
    rate: int        # % relativo
    pitch: int       # Hz relativo
    pause_ms: int

    def to_dict(self) -> dict:
        return dict(self.__dict__)


def split_sentences(text: str) -> list[str]:
    """Quebra em frases faláveis; tira marcações que não devem ser lidas ([1], **, URLs)."""
    t = re.sub(r"\[\d+(?:,\s*\d+)*\]", "", text)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[*#_`]+", "", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\s+([.,;:!?])", r"\1", t)
    parts = re.split(r"(?<=[.!?…])\s+|\n+", t)
    out = []
    for p in parts:
        p = p.strip(" -•\t")
        if len(p) > 220:                       # frase longa demais: quebra em vírgulas
            chunks = re.split(r"(?<=[,;:])\s+", p)
            buf = ""
            for c in chunks:
                if len(buf) + len(c) > 160 and buf:
                    out.append(buf.strip())
                    buf = ""
                buf += c + " "
            if buf.strip():
                out.append(buf.strip())
        elif p:
            out.append(p)
    return out


def classify(sentence: str) -> str:
    s = sentence.strip()
    if _ERROR.search(s):
        return "error"
    if _WARNING.search(s):
        return "warning"
    if s.endswith("?"):
        return "question"
    if re.match(r"^(?:\d+[.)]\s|(?:primeiro|segundo|terceiro)\b)", s, re.I):
        return "list"
    if _EXCITED.search(s):
        return "excited"
    return "casual"


def plan(text: str, base_rate: int = 0) -> list[Utterance]:
    out = []
    for s in split_sentences(text):
        style = classify(s)
        rate, pitch, pause = STYLES[style]
        out.append(Utterance(s, style, rate + base_rate, pitch, pause))
    return out
