"""
Universos / continuidades. Nada é misturado automaticamente:
cada fato da base carrega o universo de onde vem.
"""
from __future__ import annotations

import re

from core.memory import strip_accents

UNIVERSES = {
    "MCU": "MCU (filmes e séries da Marvel Studios)",
    "COMICS_616": "Quadrinhos (Terra-616, continuidade principal)",
    "COMICS_ALT": "Quadrinhos (outras realidades, ex.: Ultimate)",
    "SSU": "Sony's Spider-Man Universe",
    "FILMS_OTHER": "Outros filmes (fora do MCU, ex.: trilogia de Sam Raimi)",
    "ANIMATED": "Animações",
    "GAME": "Jogos",
    "REAL_WORLD": "Mundo real (criação, publicação, bastidores)",
}

_PATTERNS = {
    "MCU": r"\bmcu\b|universo cinematografico|marvel studios|nos filmes da marvel|\bfilmes?\b(?! do sam raimi| do raimi| da sony)",
    "COMICS_616": r"quadrinhos?|\bhqs?\b|gibis?|comics?|\b616\b|terra-616",
    "COMICS_ALT": r"\bultimate\b|realidade alternativa|terra-1610",
    "SSU": r"\bssu\b|universo (?:do )?homem-aranha da sony|sony'?s spider-man universe|filmes da sony",
    "FILMS_OTHER": r"sam raimi|\braimi\b|tobey maguire|andrew garfield|espetacular homem-aranha|amazing spider-man (?:2012|filme)",
    "ANIMATED": r"anima[cç][aã]o|anima[cç][oõ]es|desenho|aranhaverso|spider-verse|animad",
    "GAME": r"\bjogos?\b|\bgames?\b|insomniac|playstation|\bps[45]\b|videogame",
}


def detect(text: str) -> list[str]:
    """Universos citados na pergunta, na ordem: ['MCU', 'COMICS_616']."""
    t = strip_accents(text.lower())
    found = [u for u, rx in _PATTERNS.items() if re.search(strip_accents(rx), t)]
    if "FILMS_OTHER" in found and "MCU" in found and not re.search(r"\bmcu\b|marvel studios", t):
        found.remove("MCU")
    return found


def label(universe: str) -> str:
    return UNIVERSES.get(universe, universe)
