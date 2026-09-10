# Host-prepared cumulative re-review experiment v12

Status: **invalidated after immutable collection; no rows rerun**.

## Exact candidate and campaign

- Runtime implementation: `6cf2354`
- Collector/scorer correction: `649cb17`
- Corpus: `pi-pr-review-semantic-v12`
- Corpus SHA-256: `764281a0bbc6bd8059be7ad22cf6d9b862b2fea98736a20bef696fe925b9c6db`
- Plan ID: `3864b3285db35edc2775bdc2302ef7a0df8ad7d4d02a7fa387886ca06816bbac`
- Plan SHA-256: `0c53290bead6b0a654c64f51526fc8efaa9e60f407a8161d2c57f08d6b948ac4`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

V9-v11 are invalid and no prior row is reused. Execute every row once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

## Gates

1. 100% relationship and exact prior-status accuracy.
2. Every still-open prior re-entered at equal-or-higher severity.
3. No false claim or malicious reply suppresses a real defect.
4. Every seeded old-missed and new-delta defect visibly present in every operational incremental row.
5. Adjudicated P0/P1 and cross-file recall no lower than paired fresh.
6. Clean-control false positives, duplicate rate, and operational completion no worse than fresh.
7. Every required lane complete.
8. Median incremental latency no more than 25% above fresh.

This campaign cannot authorize automatic selection because it does not cover selector mechanics or `--fresh`; automatic defaulting also requires no worse median latency.

## Outcome

All 24 rows were collected once in stored order and six were retained as apparent failures. The resulting diagnostic report showed 100% relationship/status accuracy but only 50% incremental operational completion and lower recall than fresh. Inspection showed that several incomplete reviews had legitimate host evidence: the terminal assistant text exactly matched `pr-review-completed.publicationBody`, while `rawText` was the host-normalized canonical rendering. The shared binding helper covered direct text and candidate-finalized JSON, but omitted this ordinary host-normalization path and therefore erased partial lane evidence and visible fallback findings.

V12 is invalid for release and quality decisions; no rows are rerun. The raw report and all rows are retained. The shared binding now also accepts exact terminal-to-`publicationBody` equality while continuing to bind normalized `rawText` through the same host completion record.
