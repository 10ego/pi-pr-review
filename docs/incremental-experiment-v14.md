# Cumulative re-review reliability experiment v14

Status: **complete; automatic selection rejected**.

## Candidate

- Base consolidated runtime: `6cf2354`
- Gap-dispatch recovery: `942d6d5`
- Automatic still-open carry-forward: `eb4e97f`
- Safe same-head anchor preservation: `686ec76`
- Independent same-head resource pass: `aad3010`
- Carry-forward scorer correction: `f80c460`

## Immutable campaign

- Corpus: `pi-pr-review-semantic-v14`
- Corpus SHA-256: `d55c079409b285f5e6a0efa2015bf92f065295889a78cc78ae9235c27f44d1f4`
- Plan ID: `0850f69c3cecc8400559a11f5b3f5b24ec77fa1a9af1ce27383ad36c5122a4ba`
- Plan SHA-256: `e52dd71f83a86b31a086649cdce7ac233604c298a3c576ff253c59ff8ae959a1`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

The only semantic-corpus change from v13 is that `malicious.listener` permits P1 as a match for its P2 target. This records conservative escalation as found-but-overclassified instead of missed; target severity remains P2, so exact-severity accuracy still penalizes escalation.

## Protocol and gates

Execute every row once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

1. 100% relationship and exact prior-status accuracy.
2. Every still-open prior finding re-enters at equal-or-higher severity.
3. No false claim or malicious reply suppresses a real defect.
4. Every seeded old-missed and new-delta defect is visible in every operational incremental row.
5. Paired P0/P1, P2, and cross-file recall are no lower than fresh.
6. Exact-severity accuracy, clean controls, duplicate rate, and operational completion are no worse than fresh.
7. Every required lane completes.
8. Median incremental latency is no more than 25% above fresh.

This campaign still cannot authorize automatic selection because it does not exercise selector mechanics or explicit `--fresh`; automatic defaulting additionally requires no worse median latency.

## Result

All 24 rows completed collection in stored order with zero collector failures and no reruns. The scorer reports `baseline_required` because no accepted baseline file was supplied. Raw and adjudicated results show:

- relationship and exact prior-status accuracy: 12/12;
- still-open carry-forward: 6/6;
- adjudicated seeded-defect presence: 12/12 fresh and 12/12 incremental;
- adjudicated exact-severity rate: 75.0% fresh and 83.3% incremental;
- duplicate rate: 27.3% fresh and 10.5% incremental;
- operational completion: 10/12 for both strategies;
- required-lane completion: 96.7% fresh and 95.0% incremental;
- publication fallback: 16.7% for both strategies;
- complete-pair median latency: 80.6s fresh and 69.8s incremental, ratio 0.866.

Five raw semantic misses were adjudicated as visibly present without changing the raw report: two token-log wording mismatches, two redirect findings present at P2 against a P1 target, and one exact canonical tenant finding whose automatic ancestor carry-forward intentionally used a repo-wide anchor. See `adjudication.json`.

Automatic selection remains rejected because two incremental gap lanes were structurally partial, leaving incremental required-lane completion below fresh and violating the absolute all-lanes-complete gate. The explicit `--incremental` path remains available and is materially improved over v13.
