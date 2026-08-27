# Baseline v5 evidence

Immutable 48-run historical diagnostic evidence for `pi-pr-review-semantic-v5`. The cohort is invalid for gates/topology retention because `clean-batched-lookup` was not a valid clean control; use corpus v6 with fresh evidence.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `2b2c108048671e53747f592a60b1d8750cc43a024c47ca20e11ffe4c1b5aa164`, bound to scorer SHA-256 `b4959e506ff8feb5b27abe256ad8c10ef08a3ae5eb1f4885ec447b429c9c5421`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `35da4e41a2641367fb4d434c388b46407e091a9ab76c31b46bcf17cd3b4839d3`.

Both reports are historical diagnostics and deliberately have `gate.status = "baseline_required"`. No accepted gate may be derived from this cohort. The adjudicated report is authoritative only for historical recall/lifecycle/latency interpretation; its clean-control rates are invalid. The original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
