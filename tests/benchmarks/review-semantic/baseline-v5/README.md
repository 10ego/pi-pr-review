# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `d2671cb22c99f7238b8909553cc32166288996960196dbba940df87ffa656fe0`, bound to scorer SHA-256 `eda38c703b48357d8f8ebbaff895c602e5ea7ba5ec5f109e6f75480a5423484f`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `f62591225864e56462a816933aed1389fcd56393389ee9383cc7214eb84900de`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
