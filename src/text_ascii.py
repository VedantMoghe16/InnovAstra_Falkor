"""ASCII-only text for everything the UI displays.

Older artefacts (alert descriptions, case notes, SAR text) were generated with
typographic characters (Rs sign, arrows, dashes, section signs). `asciify` maps
them to plain ASCII; the backend applies it to every JSON response and SSE event.
"""
from __future__ import annotations

import re
import unicodedata

_MAP = {
    "─": "-", "━": "-", "═": "=", "│": "|", "┃": "|", "┌": "+", "┐": "+", "└": "+", "┘": "+", "├": "+", "┤": "+",
    "—": "-", "–": "-", "−": "-", "‑": "-", "→": "->", "←": "<-", "↑": "^", "↓": "v", "⇒": "=>", "↔": "<->",
    "·": "|", "•": "-", "…": "...", "≥": ">=", "≤": "<=", "≠": "!=", "×": "x", "≈": "~", "∝": "~", "±": "+/-",
    "§": "Sec. ", "¶": "para ", "°": " deg", "τ": "tau", "α": "alpha", "β": "beta", "λ": "lambda", "Δ": "delta",
    "σ": "sigma", "μ": "mu", "Σ": "sum", "∈": "in", "“": '"', "”": '"', "‘": "'", "’": "'",
    "✓": "OK", "✔": "OK", "✗": "x", "✘": "x", "▸": ">", "▾": "v", "▶": ">", "■": "#",
}
_RUPEE = re.compile("₹\\s?")
_NON_ASCII = re.compile(r"[^\x00-\x7f]")


def _one(c: str) -> str:
    if c in _MAP:
        return _MAP[c]
    base = unicodedata.normalize("NFKD", c).encode("ascii", "ignore").decode()
    return base  # accented letters keep their base letter; symbols/emoji drop


def asciify(text: str) -> str:
    if not text or text.isascii():
        return text
    return _NON_ASCII.sub(lambda m: _one(m.group(0)), _RUPEE.sub("Rs ", text))
