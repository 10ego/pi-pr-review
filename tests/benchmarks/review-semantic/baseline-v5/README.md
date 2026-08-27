# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `bb7410bc55f68f18962a76fbc80ece94952550da04d251303bafbbb26e9b0103`, bound to scorer SHA-256 `bdf5f25c4a9455c72329639c9267b3532def745c6aebc2411a60feefef9b799c`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `7f3252f8928c242befa0b8d3c17971cf8bbc4e9d68fa5ba32c6cc15dec7db907`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
