# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `e2e47e80d893b979f61d789b5cf7810245735a951a9715b1d5719dc75633b37f`, bound to scorer SHA-256 `8b7f29a7a1d7d54f01c1152caad42cc525226e2e2be5e961ea2d790bd4429a63`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `f76b0ee84f5fc10a884bead00f573209facd3ca8e50f63a8e77d63e0684d7806`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
