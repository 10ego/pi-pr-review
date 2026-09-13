# Automatic fresh versus incremental selection v1

Status: **complete; automatic defaulting rejected**.

- candidate: `38a2f0281581d166b2c72993d55716cc3bfc6bc7`
- corpus: `tests/benchmarks/review-semantic/corpus-selector-v1.json`
- corpus SHA-256: `0de16c887ec9705c8a03e7229372805e1f88efda8a6827d924881a10b4346868`
- plan ID: `3bee0fccb2dc4a12b375e0500c7fa94b5e1c2a6ce4a7b7460560488d9c3e5325`
- plan SHA-256: `5a6fe4869564157e43e74e852714e8bdfe0c775662fb1988933b08fd3904aeac`
- model: `openai-codex/gpt-5.6-sol`, medium effort
- 36 rows: fresh, explicit incremental, and automatic; two repetitions; fixed stored order; no reruns

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
4. Fresh batch and individual review lanes are rejected while automatic preparation is pending; after a fresh selection, individual lanes remain unavailable until the fixed batch registers the complete mode topology. Legacy prior discovery cannot bypass atomic preparation.
5. Failed preparation atomically clears prepared bytes, expected lanes, prior findings, and candidate state before selecting fresh.
6. Missing preparation or an omitted selected fresh topology queues one continuation and cannot loop; queue failure, exhaustion, or deadline expiry clears authority before caching or publication.
7. Selection telemetry contains only generation, requested strategy, selected strategy, and bounded reason.
8. Existing publication, completion, privacy, and lifecycle suites remain green.

## Real-model campaign requirements

The immutable real-model campaign covers:

- no prior marker;
- usable ancestor prior head;
- usable same head;
- diverged prior head;
- explicit `--fresh`, explicit `--incremental`, and plain automatic invocation.

Malformed/truncated prior state, preparation failure, cleanup failure, concurrent preparation, missing preparation, missing fresh topology, deadline expiry, queue failure, and continuation exhaustion are deterministic host-lifecycle gates rather than stochastic model rows.

Every row was retained once without reruns. Automatic selection had to choose the expected strategy in every case, preserve V18's semantic and operational gates, add no duplicate publication, and have no worse median end-to-end latency than the corresponding explicit strategy after accounting for selection overhead.

## Results

- 36/36 rows retained with process exit 0 and no reruns;
- automatic selection telemetry: 12/12 exact requested, selected, and reason values;
- automatic relationships: 12/12 exact;
- automatic prior statuses: 8/8 exact;
- automatic still-open carry-forward: 4/4;
- automatic raw recall: P0/P1 66.7%, P2 100%, cross-file 50%;
- automatic operational completion: 11/12;
- automatic required-lane completion: 47/48 (97.9%);
- automatic publication fallback: 1/12 (8.3%);
- automatic median latency: 82.7s, versus 78.0s explicit fresh and 86.5s explicit incremental.

The retained automatic no-prior repetition 1 row had a structurally partial `correctness-contracts` lane. The retained explicit-incremental no-prior repetition 2 row independently had a structurally partial `security-performance` lane. Neither was rerun. Exact strategy choice therefore passed, but the absolute all-required-lanes-complete and operational-completion gates failed. Automatic defaulting remains unreleased.

## Directional pilot

A disposable six-case automatic-only pilot completed 6/6 operational runs and 24/24 required lanes with exact relationship and selected-strategy telemetry, exact prior statuses/carry-forward, 100% raw seeded-defect recall, zero fallback, and 65.0s median latency. This pilot was directional only and did not override the failed immutable campaign.
