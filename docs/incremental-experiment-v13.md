# Host-prepared cumulative re-review experiment v13

Status: **complete; automatic selection rejected**.

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

## Result

All 24 rows completed collection in stored order with zero collector failures and no reruns. The scorer reports `baseline_required` because no accepted baseline gate file was supplied; the predeclared paired gates were evaluated directly:

- relationship accuracy: 12/12;
- exact prior statuses: 12/12;
- still-open carry-forward: 4/6 (fail);
- fresh vs incremental P0/P1 recall: 62.5% vs 62.5%;
- fresh vs incremental P2 recall: 100% vs 50% (fail);
- fresh vs incremental cross-file recall: 50% vs 100%;
- fresh vs incremental duplicate rate: 13.0% vs 10.5%;
- fresh vs incremental operational completion: 12/12 vs 5/12 (fail);
- required-lane completion: 100% vs 80.6% (fail);
- complete-pair median latency: 96.6s fresh vs 100.0s incremental, +3.6% (within the experiment's +25% ceiling but worse than the separate automatic-defaulting requirement).

The consolidated cumulative path therefore remains explicit `--incremental`; plain `/pr-review N` remains fresh. Automatic selection is rejected. The principal blocker is model compliance with required cumulative lane invocation/finalization, followed by incomplete still-open carry-forward and lower P2 recall.
