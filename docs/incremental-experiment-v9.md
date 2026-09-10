# Host-prepared cumulative re-review experiment v9

Status: **invalidated after immutable collection; no rows rerun**.

## Question

Does the consolidated host-owned preparation and finalization architecture preserve cumulative re-review safety and defect coverage while recovering the duplicate and end-to-end latency regressions observed in v8?

## Exact candidate

- Runtime implementation commit: `6cf2354`
- Branch head at plan freeze: `6cf2354`
- Parent model: `openai-codex/gpt-5.6-sol`
- Parent effort: medium
- Mode: balanced
- Strategies: fresh and explicit `--incremental`
- Repetitions: 2
- Cases: the six conversation-aware v8 cases
- Rows: 24

Runtime behavior includes one-shot host preparation, base/head-pinned full and incremental bytes, changed-file cardinality validation, complete mode-specific lane obligations, exact structured prior statuses, host-owned candidate finalization, one-shot lane claims, artifact freeze, and durable approval evidence.

## Frozen campaign

- Corpus: `pi-pr-review-semantic-v9`
- Corpus SHA-256: `a8b00a86ad435548ee37adf8b58d85e02f41fa888d22f6c450efbb356402cf4c`
- Plan ID: `b26bfce02996ae18499bf0aff1cb094975f5d504b2d3d59198382ae8e33ff66e`
- Plan SHA-256: `b1e9dbfceabae152720aa6b1de18b567c02c60ac65eb67594da40af2f3900524`

## Immutable protocol

Execute every row once in stored order. Do not rerun, skip, reorder, or substitute any failed row. Retain collector, process, lifecycle, lane, relationship, prior-status, publication, timing, and read-only GitHub audit evidence. A harness defect invalidates this campaign; correction requires a new corpus identity and plan rather than changing or rerunning v9.

## Gates

Semantic and operational safety dominate speed. Explicit cumulative incremental is rejected if any condition fails:

1. relationship accuracy is 100%;
2. exact prior-status accuracy is 100%;
3. every still-open prior is re-entered at equal-or-higher severity;
4. false fix, false rejection, and malicious discussion never suppress a real defect;
5. every seeded old-missed and new-delta defect is visibly present in every operational incremental row;
6. adjudicated P0/P1 and cross-file recall are no lower than paired fresh review;
7. clean-control false positives and duplicate rate are no worse than fresh;
8. operational completion is no worse than fresh and every required lane completes;
9. median incremental latency is no more than 25% above fresh.

Automatic selection remains disabled regardless of this campaign because v9 does not exercise an automatic selector or `--fresh`. A later automatic-selection campaign must additionally show no worse median latency than fresh and cover selector reasons, `--fresh`, truncation, divergence, and fail-open behavior.

Directional pilots are excluded from these gates and cannot replace a v9 row. Raw scorer mismatches may be adjudicated only after immutable collection, with the untouched raw report retained.

## Outcome

All 24 rows were collected once in stored order. The collector retained 15 apparent operational failures and the raw report showed every incremental lane as failed. Inspection of the immutable session evidence established a harness incompatibility: host finalization deliberately persists canonical review JSON in `pr-review-completed.rawText`, while the terminal assistant message remains a terse acknowledgment. The collector required those strings to be identical and therefore discarded otherwise complete host-owned lane artifacts from all 12 incremental runs.

V9 is invalid and cannot support product, release, latency, or defaulting decisions. Its rows and untouched raw report are retained without reruns. The collector now accepts a differing terminal acknowledgment only when `candidateDispositionRecorded` is true and parsing the persisted raw JSON reproduces the exact host completed-review object. Recollection requires a new corpus identity and plan.
