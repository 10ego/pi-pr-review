# Baseline v5 evidence

Immutable 48-run historical diagnostic evidence for `pi-pr-review-semantic-v5`. The cohort is invalid for gates/topology retention because `clean-batched-lookup` was not a valid clean control; use corpus v6 with fresh evidence.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `29110ec8505db163b380077c9ed55a0b865584b945807a1937b62ed4a313d5cb`, bound to scorer SHA-256 `721ec9eb8cca6f3c389c8a3e44892b0a32b74fcb9fd76c4e5aa1627607632c66`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `73dba94ea1c8d3f7ff20b1232879f1aa3a5000751954fadb166d3d8d68f4d51d`.

Both reports are historical diagnostics and deliberately have `gate.status = "baseline_required"`. No accepted gate may be derived from this cohort. The adjudicated report is authoritative only for historical recall/lifecycle/latency interpretation; its clean-control rates are invalid. The original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
