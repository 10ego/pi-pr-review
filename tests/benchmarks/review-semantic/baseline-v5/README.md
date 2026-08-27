# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `a8d9611626d77e40221c0dbfa9ea4bf7906a872c92e539d190f966394c5aaa1f`, bound to scorer SHA-256 `31abbc0f9ffba3f1955a10f1bee57abcb7941060b638a869b755128f2d3f14a1`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `f0af6d25af778b92a8b9cb76409d4fe133adcd805cf78916d28dacf8bdd37442`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
