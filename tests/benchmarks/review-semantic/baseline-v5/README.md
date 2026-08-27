# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `e87fe78888a8a5f9e574505a475d73fa26f3d7bf2b5ed8c669a685644ef6d05a`, bound to scorer SHA-256 `29996aa62bc3bb4c03e82d8c56a20fe898ab90563feb5b50757002c4766e61ca`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `4320208d0c6f521cc882adb76f5895f7a025b2d0f7cb22eff0d5dc0225d4426f`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
