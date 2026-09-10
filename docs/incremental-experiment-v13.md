# Host-prepared cumulative re-review experiment v13

Status: **frozen; collection not started**.

- Runtime implementation: `6cf2354`
- Collector/scorer correction: `ea2cc27`
- Corpus: `pi-pr-review-semantic-v13`
- Corpus SHA-256: `25410357344f48dbfe92daef22a0420dc587ff742ca52468db1a129c17f39179`
- Plan ID: `fab1f7c87f2f32a1e28f6d2fc993f8acb30f4002dcb23d0d7e2638f94e9f7cc6`
- Plan SHA-256: `f5ff050c1aad9af887a8906df3d5a31526849fdf0d29988f49f50c8b27b3e725`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

V9-v12 are invalid and no prior row is reused. Execute every row once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

Gates are unchanged: exact relationships/statuses; complete still-open carry-forward at equal-or-higher severity; no claim-based suppression; all seeded old/new defects visible in operational incremental rows; paired P0/P1 and cross-file recall no lower than fresh; no worse clean controls, duplicates, or completion; every required lane complete; and incremental median latency at most 25% above fresh.

This campaign cannot authorize automatic selection because it does not cover selector mechanics or `--fresh`; automatic defaulting also requires no worse median latency.
