# Automatic fresh versus incremental selection v2

Status: **frozen; collection not started**.

V2 repeats the exact v1 relationships, cases, strategies, repetitions, order policy, model, and gates after one bounded parser correction: an exact single-backtick code span around a recognizable candidate `location` value is unwrapped before the existing strict path/range validator runs. V1's two partial lanes both become complete under this rule; malformed, unmatched, multiple, traversal, absolute, and backtick-bearing paths remain rejected.

- candidate: `44cb10dee0877e53cfb87473100f466418075d04`
- corpus SHA-256: `98f111ce42ecc6892701514ad43f3046915dc0c1b775ae9b928447f136927df0`
- plan ID: `f44d43f732243a60adc21c02af33350e51b5cdca2fc5390757a51e318bd18dd2`
- plan SHA-256: `72917802ebe2d4ca482a44c96f0812431a0daf0ba5c46157045f1e1770b0f53a`
- 36 rows: fresh, explicit incremental, and automatic; two repetitions; no reruns

Automatic defaulting requires 12/12 exact automatic selection events and relationships, exact prior status/carry-forward, 100% operational and required-lane completion, no worse semantic recall/severity/duplication than the corresponding explicit path, no publication duplication, and automatic median latency no worse than the corresponding explicit strategy.
