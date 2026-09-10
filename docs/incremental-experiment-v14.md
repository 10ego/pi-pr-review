# Cumulative re-review reliability experiment v14

Status: **frozen; collection not started**.

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
