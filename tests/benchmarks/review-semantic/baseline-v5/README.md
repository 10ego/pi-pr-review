# Baseline v5 evidence

Immutable 48-run diagnostic baseline for `pi-pr-review-semantic-v5`.

- `plan.json`: exact balanced/full two-repetition plan.
- `bundle/effective-review-config.json`: sanitized effective configuration.
- `bundle/runs/`: one normalized result per plan entry.
- `bundle/artifacts/`: retained session/lane/process/audit and review envelopes.
- `report.json`: original strict scorer output; SHA-256 `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a`, retained but superseded for interpretation.
- `summary.json`: original report identity and per-mode summary.
- `report-adjudicated.json`: corrected scorer output over the same immutable evidence; SHA-256 `f955ce2726a22bdff1979010cc9ef80c21bca44afad2760143343c4c05695423`, bound to scorer SHA-256 `68b5d846fbb343e6a724037f2053e5dd9ef6275b73c261c8db6df326a480a5b9`.
- `summary-adjudicated.json`: corrected report identity and per-mode summary; SHA-256 `7e6589e0d010f892f0c4357383ace85a5aea39e66841c91cde6fd55db3eef4e6`.

Both reports are diagnostic and deliberately have `gate.status = "baseline_required"`. No accepted gate was derived from this weak two-repetition baseline. The adjudicated report is authoritative for interpretation; the original demonstrates the preserved correction chain. See `docs/semantic-benchmark-baseline-v5.md`.
