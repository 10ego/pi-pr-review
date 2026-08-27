# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `17e55d71d636f9408496941b754170f221015b28a7dedd985976fde4a111e75b`, bound to scorer SHA-256 `9e92284c49cbed9ac48e06273e9db6db8b3574ef4a8437145e47e26d3fde89eb`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `04b783260192fb98e81b9debe8ce55c9c48df0b6f96048cf2f470bda7eb84735`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
