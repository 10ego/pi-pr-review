# Host-prepared cumulative re-review experiment v11

Status: **frozen; collection not started**.

## Purpose

Immutable recollection after v9 and v10 were invalidated by collector-only handling of host-finalized JSON. No prior row is reused.

## Exact candidate and campaign

- Runtime implementation: `6cf2354`
- Collector correction: `9c15bfb`
- Corpus: `pi-pr-review-semantic-v11`
- Corpus SHA-256: `a423e215a0680d3f12f84fdc1de367fabe9b1a7a7416af79bad409e69d6e7466`
- Plan ID: `5fcb293a25fb0a7b9f3339791c7b3f800b4dbce1b1d58299b412b2c4a9b159c6`
- Plan SHA-256: `b3c54aa295bb27b2bf9ebc9459543f0926a16f2f2a189506fb6409b6cdc27e50`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- Mode: balanced
- Strategies: fresh and explicit `--incremental`
- Repetitions: 2
- Cases: 6
- Rows: 24

## Protocol and gates

Execute every row once in stored order without reruns, skips, reordering, or substitutions. Retain every failure. Gates remain identical to v9 and v10:

1. 100% relationship and exact prior-status accuracy;
2. every still-open prior re-entered at equal-or-higher severity;
3. no false claim or malicious reply suppresses a real defect;
4. every seeded old-missed and new-delta defect visibly present in every operational incremental row;
5. adjudicated P0/P1 and cross-file recall no lower than paired fresh;
6. clean-control false positives, duplicate rate, and operational completion no worse than fresh;
7. every required lane complete;
8. median incremental latency no more than 25% above fresh.

This campaign cannot authorize automatic selection because it does not cover selector mechanics or `--fresh`; automatic defaulting also requires no worse median latency.
