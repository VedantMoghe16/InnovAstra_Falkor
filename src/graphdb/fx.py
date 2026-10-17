"""Fixed reference FX table for USD-equivalent amounts.

The IBM AML benchmark mixes 15 currencies (USD, EUR, CNY, RUB, INR, ...).
Amounts are only comparable - and only summable - after conversion. These are
APPROXIMATE September-2022 reference rates (the dataset's period), fixed on
purpose so results are reproducible; they are not live market rates. Every
TXN keeps its native `amount` + `currency`; `amount_usd` is derived.
"""
from __future__ import annotations

FX_LABEL = "USD-equivalent at fixed approx. Sep-2022 reference rates (not live)"

# USD per one unit of currency
FX_USD = {
    "USD": 1.0, "EUR": 1.00, "GBP": 1.14, "CHF": 1.03, "CAD": 0.75, "AUD": 0.67,
    "JPY": 0.0070, "CNY": 0.142, "INR": 0.0123, "ILS": 0.29, "RUB": 0.0165,
    "MXN": 0.050, "SAR": 0.266, "BRL": 0.19, "BTC": 19500.0,
}


def to_usd(amount: float, currency: str) -> float:
    return float(amount or 0.0) * FX_USD.get(str(currency or "USD").upper(), 1.0)
