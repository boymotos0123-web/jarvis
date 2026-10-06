"""
Leitura de páginas: baixa o HTML e extrai o texto principal (sem dependências extras).
Limites: só http/https, até 1,5 MB, texto final cortado em ~5.000 caracteres.
"""
from __future__ import annotations

import html
import re

import httpx

from knowledge.providers import UA

MAX_BYTES = 1_500_000
MAX_CHARS = 5000


def extract_text(raw_html: str) -> str:
    t = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header|form|aside)[^>]*>.*?</\1>", " ", raw_html)
    m = re.search(r"(?is)<(article|main)[^>]*>(.*?)</\1>", t)
    if m and len(m.group(2)) > 500:
        t = m.group(2)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</h[1-6]>|</li>", "\n", t)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    lines = [ln.strip() for ln in t.split("\n")]
    text = "\n".join(ln for ln in lines if len(ln) > 40)   # descarta menus e rodapés curtos
    if not text:                                           # página curta: fica com o que houver
        text = "\n".join(ln for ln in lines if ln)
    return text[:MAX_CHARS]


async def read_page(url: str, timeout: float = 10.0) -> str:
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("só leio endereços http/https")
    async with httpx.AsyncClient(timeout=timeout, headers=UA, follow_redirects=True) as c:
        async with c.stream("GET", url) as r:
            if r.status_code >= 400:
                raise ValueError(f"a página respondeu {r.status_code}")
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                raise ValueError("não é uma página de texto")
            chunks, size = [], 0
            async for chunk in r.aiter_bytes():
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_BYTES:
                    break
    raw = b"".join(chunks).decode(r.encoding or "utf-8", errors="replace")
    return extract_text(raw) if "html" in ctype else raw[:MAX_CHARS]
