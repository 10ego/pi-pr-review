# Automatic fresh versus incremental selection v1

Status: **implementation complete; deterministic validation in progress; real-model campaign not frozen**.

## Product contract

Plain `/pr-review N` uses host-owned automatic selection. The host injects cumulative preparation before prompt expansion and review lanes cannot start until preparation settles:

- `same_head` or ancestor `incremental` selects cumulative review;
- `none`, `diverged`, or failed/unavailable preparation selects fresh review;
- `--fresh` skips preparation and forces fresh review;
- `--incremental` explicitly requests preparation with the same safe fallback;
- `--fresh` and `--incremental` are mutually exclusive.

The selected strategy and reason are persisted as bounded `pr-review-selection` telemetry. If a model terminates before automatic preparation, the host queues exactly one authenticated continuation. A second omission fails closed.

## Deterministic acceptance gates

1. Default invocations are transformed with the configured review mode and `--incremental` before prompt expansion.
2. Explicit `--fresh` never enables prior discovery or host continuation.
3. Explicit `--incremental` retains cumulative behavior.
4. Fresh batch and individual review lanes are rejected while automatic preparation is pending; legacy prior discovery cannot bypass atomic preparation.
5. Failed preparation atomically clears prepared bytes, expected lanes, prior findings, and candidate state before selecting fresh.
6. Missing preparation or an omitted selected fresh topology queues one continuation and cannot loop; queue failure, exhaustion, or deadline expiry clears authority before caching or publication.
7. Selection telemetry contains only generation, requested strategy, selected strategy, and bounded reason.
8. Existing publication, completion, privacy, and lifecycle suites remain green.

## Real-model campaign requirements

A release/defaulting campaign must cover at least:

- no prior marker;
- usable ancestor prior head;
- usable same head;
- diverged prior head;
- malformed or truncated prior state;
- preparation failure;
- explicit `--fresh` and explicit `--incremental` overrides.

Every row is retained once without reruns. Automatic selection must choose the expected strategy in every case, preserve V18's semantic and operational gates, add no duplicate publication, and have no worse median end-to-end latency than the corresponding explicit strategy after accounting for selection overhead.
