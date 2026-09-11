# Cumulative incremental final campaign v16

Status: **frozen; collection not started**.

## Candidate

- bounded contract-partial retry: `a84bc46`
- secondary-attempt budget correction: `9979ba0`
- provider-failure isolation: `ce0260b`
- bounded ASCII candidate-label normalization: `a37765d`

V16 changes no review topology or selector behavior. It validates explicit `--incremental` after the final gap-output reliability correction.

## Immutable campaign

- Corpus: `pi-pr-review-semantic-v16`
- Corpus SHA-256: `9776ff0460d4bd61c517cf5eb378f39cbe7f391d56b3c13f4f6ff1367f6acaf7`
- Plan ID: `002c2728258db623c6c3f031976eca3247c5e3b140e1c7892e6640838f4157a7`
- Plan SHA-256: `12b6b98e9b4e2e37e38b40d2064a3e88bc62f640771ee1851f501eef2aca6ad5`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

Execute every row exactly once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

## Gates

1. Relationships and prior statuses are exact in every incremental row.
2. Every still-open prior finding is retained at equal-or-higher severity.
3. Every seeded defect is visibly present in every operational incremental row, with adjudicated recall and exact severity no worse than fresh.
4. Clean controls, duplication, operational completion, and fallback rate are no worse than fresh.
5. Every required incremental lane completes.
6. Complete-pair incremental median latency is no worse than fresh.
7. Any retry remains bounded, evidence-preserving, secondary-budgeted, and distinct from model fallback.

This campaign validates explicit `--incremental` only. Automatic selection and `--fresh` selector mechanics remain out of scope.
