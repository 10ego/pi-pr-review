# Baseline v5 evidence

Immutable 48-run historical diagnostic evidence for `pi-pr-review-semantic-v5`. The cohort is invalid for gates/topology retention because `clean-batched-lookup` was not a valid clean control; use corpus v6 with fresh evidence.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `66b0e04cbe01f3c2d72f672730ab372ce9550be833d31e0da61337170cb01b86`, bound to scorer SHA-256 `9f5a833a40155c4d450b8da7a582619ed2fc6ab101ca215e4c889c751c54404d`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `5d0a7078f59fbedf0ef23c0854abd17894cc7fd702769b5ff1b4483838a41318`.

Both reports are historical diagnostics and deliberately have `gate.status = "baseline_required"`. No accepted gate may be derived from this cohort. The adjudicated report is authoritative only for historical recall/lifecycle/latency interpretation; its clean-control rates are invalid. The original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
