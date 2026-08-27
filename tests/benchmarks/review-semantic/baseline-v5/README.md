# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`.
- `summary.json`: report identity and per-mode summary.

The report is diagnostic and deliberately has `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. See `docs/semantic-benchmark-baseline-v5.md`.
