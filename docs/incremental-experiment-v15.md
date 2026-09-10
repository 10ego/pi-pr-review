# Cumulative gap-reliability experiment v15

Status: **frozen; collection not started**.

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

This campaign cannot enable automatic selection because selector mechanics and explicit `--fresh` are not exercised; automatic defaulting also requires no worse median latency.
