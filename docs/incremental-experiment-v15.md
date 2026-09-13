# Cumulative gap-reliability experiment v15

Status: **complete; automatic selection rejected**.

## Candidate

- V14 candidate and evidence: `9468ba0`
- Bounded contract-partial retry: `a84bc46`
- Secondary-attempt budget correction: `9979ba0`
- Provider-failure isolation: `ce0260b`

The retry is available only to host-fixed cumulative gap lanes. It runs at most once after a clean process returns structurally partial output, uses fallback-attempt budget/deadline limits, never consumes the slot after timeout/provider failure, preserves all retained attempt evidence, and does not report same-model retries as model fallback.

## Immutable campaign

- Corpus: `pi-pr-review-semantic-v15`
- Corpus SHA-256: `f67ba075183a2a9f8636a288b5ed1bb2f4ed29faeabc3d7a90906f0a215393e7`
- Plan ID: `e1a1227b525f538273a6433b7d855330032ba6bed7fc8f78f560d4a078ae0cff`
- Plan SHA-256: `8333533d43b952db0be9f1975337f1b43b5012842846724612fabd2a5cabc607`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

Execute every row once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

## Gates

1. 100% relationship and exact prior-status accuracy.
2. Every still-open prior finding re-enters at equal-or-higher severity.
3. Every seeded defect is visibly present in every operational incremental row; paired adjudicated P0/P1, P2, and cross-file recall are no lower than fresh.
4. Exact-severity accuracy, clean controls, duplicate rate, operational completion, and publication fallback are no worse than fresh.
5. Every required incremental lane completes.
6. Complete-pair incremental median latency is no more than 25% above fresh.
7. Any contract retry is exactly one clean-partial retry, remains within secondary-attempt budgets, and does not erase retained evidence or masquerade as fallback.

## Results

All 24 rows completed once in stored order with zero collector failures or reruns.

- exact relationships/statuses: 12/12;
- still-open carry-forward: 6/6;
- adjudicated seeded-defect presence: 12/12 fresh and 12/12 incremental;
- exact severity: 75.0% fresh and 83.3% incremental;
- operational completion: 10/12 fresh and 11/12 incremental;
- required-lane completion: 96.7% fresh and 97.5% incremental;
- publication fallback rate: 16.7% fresh and 8.3% incremental;
- duplicate rate: 34.1% fresh and 11.1% incremental;
- complete-pair median latency: 60.1s fresh and 116.8s incremental (1.943 ratio).

Two incremental gap lanes exercised the bounded retry. One completed after `partial -> complete`; the other remained `partial -> partial`. Both retained attempt evidence and correctly reported no model fallback. The successful retry's first process ran for roughly 506 seconds before returning partial output, producing a severe latency outlier despite the secondary attempt cap.

Automatic selection remains rejected. V15 misses the absolute all-required-lanes-complete gate and the no-worse-median-latency gate; selector mechanics and explicit `--fresh` also remain unimplemented and unbenchmarked. Raw scoring remains unchanged, with equivalent visible findings documented separately in `adjudication.json`.
