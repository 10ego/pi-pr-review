# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `677098d00acbd60c6f47fc52b557752dd44903e2651121d8777c186ab93f51a7`, bound to scorer SHA-256 `63fb870ad1e29ca1343841259ea426c7421032032973b88f83b1c0df00406f43`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `3b11f6a01ffde16bb6253eaaf6135d049053cc7e8fc24edcd3dd4b8567607dcd`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
