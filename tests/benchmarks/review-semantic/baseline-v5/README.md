# Baseline v5 evidence

Immutable 48-run historical diagnostic evidence for `pi-pr-review-semantic-v5`. The cohort is invalid for gates/topology retention because `clean-batched-lookup` was not a valid clean control; use corpus v6 with fresh evidence.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `134b1133b9acd053b39e71a72535ab35abd604682f243b109b07315eec8fe1ae`, bound to scorer SHA-256 `64eaaafdecc05f42480bdd82251b6119f4c798d180904220b8c98ecc9ec714f4`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `c86028982d8c37b6ee5b449e8f1830fd39e3b1efabe8adf26b3de6a13b402cfc`.

Both reports are historical diagnostics and deliberately have `gate.status = "baseline_required"`. No accepted gate may be derived from this cohort. The adjudicated report is authoritative only for historical recall/lifecycle/latency interpretation; its clean-control rates are invalid. The original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
