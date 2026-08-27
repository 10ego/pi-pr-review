# Baseline v5 evidence

Immutable 48-run historical diagnostic evidence for `pi-pr-review-semantic-v5`. The cohort is invalid for gates/topology retention because `clean-batched-lookup` was not a valid clean control; use corpus v6 with fresh evidence.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `5acb830b5ba8036249cf5299aa2a7956005b0aa1f1b1acc694e567d3b92d1cb6`, bound to scorer SHA-256 `0e594bc1e43061738b747df82070c1df2548ed01e3237294c31509f35ff4d57d`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `3939b679b6f65296edfbdd2e1807fbf624811dd7efcf67371c3575a9ec3e0938`.

Both reports are historical diagnostics and deliberately have `gate.status = "baseline_required"`. No accepted gate may be derived from this cohort. The adjudicated report is authoritative only for historical recall/lifecycle/latency interpretation; its clean-control rates are invalid. The original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
