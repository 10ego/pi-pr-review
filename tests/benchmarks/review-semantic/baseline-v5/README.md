# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `b734e6f179c2939e10e56ff9eca983119ce2cf4be5669e3e5ab79475e3af6d92`, bound to scorer SHA-256 `d68a65b6592e37798c1cf0090a0e7d1e9a306510fde4fdf574277bde544746ac`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `06cf4b866a9016bc86c9489e629b32d563aab940e843c4159d0018ccc3f91ce3`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
