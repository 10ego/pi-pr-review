# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `fc07f6ee10bc64ae3310503de05d5c6798f70d5df40245702da548f705095970`, bound to scorer SHA-256 `3187bfc29c43bcc507ffa387509e408c98ed211f3c2fa7ed20f38ae81db1fdbe`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `8f2bc7c5c6c388e891bc91625b33642df1e543d3ba909600b208f2bb6ef39682`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
