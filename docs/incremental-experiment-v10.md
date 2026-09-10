# Host-prepared cumulative re-review experiment v10

Status: **frozen; collection not started**.

## Purpose

Corrected immutable recollection after v9 was invalidated by its collector's host-finalization lifecycle check. No v9 row is reused or rerun under the v9 identity.

## Exact candidate and campaign

- Runtime implementation: `6cf2354` (later commits before freeze change only benchmark evidence/tooling/docs)
- Collector fix: `2adb06c`
- Corpus: `pi-pr-review-semantic-v10`
- Corpus SHA-256: `0cf8605d8a7be22738c7d40cad360657f12a752caff49d69c1e1ea923ef15223`
- Plan ID: `d0ab5a97c9b1be67e1cd177da7f10ebd9b79664e2f30a0539f3935da2ad08ee7`
- Plan SHA-256: `e43f897634b47bef5ef9e78a40d42d466711c62cdc115238d7b2551e0fd4ac67`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- Mode: balanced
- Strategies: fresh and explicit `--incremental`
- Repetitions: 2
- Cases: 6
- Rows: 24

## Protocol and gates

Execute every row once in stored order without reruns, skips, reordering, or substitutions. Retain every failure. The semantic, operational, duplicate, and latency gates are identical to v9:

1. 100% relationship and exact prior-status accuracy;
2. every still-open prior re-entered at equal-or-higher severity;
3. no false claim or malicious reply suppresses a real defect;
4. every seeded old-missed and new-delta defect visibly present in every operational incremental row;
5. adjudicated P0/P1 and cross-file recall no lower than paired fresh;
6. clean-control false positives, duplicate rate, and operational completion no worse than fresh;
7. every required lane complete;
8. median incremental latency no more than 25% above fresh.

Automatic selection remains disabled regardless of outcome because this campaign does not exercise selector mechanics or `--fresh`. Automatic defaulting additionally requires no worse median latency and a dedicated selector/fail-open corpus.
