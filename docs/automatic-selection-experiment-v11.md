# Automatic fresh versus incremental selection v11

Status: **complete; automatic defaulting rejected by one corresponding explicit failure**.

V11 was the release-gate campaign for host-only parent GitHub API access and bounded cumulative prompt-policy retry at candidate `e05a79faaa75111bb005ec64633893677424fb5c`. It uses `openai-codex/gpt-5.6-sol` at medium effort. Its 36 rows must be collected exactly once in stored plan order, retaining failures without reruns, substitutions, skips, or rewriting.

- corpus SHA-256: `2fbeee62bacd55e372511ffd43adcafce048783d8a1df7276d2cd65c289a665f`
- plan ID: `b030c8b1f4ebb858fa2e1c62ccb77bf5eb7538c62ed04d935fa597efd52b81e0`
- plan SHA-256: `159cad6a0f4f20690c7351eb40485c705f8449f5124b853bc44131faa31ee1db`
- modes: balanced
- strategies: fresh, incremental, automatic
- repetitions: 2

## Precommitted release gates

Automatic defaulting is authorized only if all of these gates pass:

- all 36 planned rows are retained exactly once and remain privacy-sanitizable;
- automatic selection and observed prior relationship are exact for all 12 automatic rows;
- automatic prior-finding statuses are exact for every applicable finding;
- automatic completion is 12/12 and every required automatic lane completes;
- every automatic row and corresponding explicit-strategy row is operational, yielding all 12 planned pairs;
- adjudicated defect presence and source-authored severity are no worse than the corresponding explicit strategy, with no clean-control false-positive regression;
- duplication, fallback use, and fallback publication are no worse than the corresponding explicit strategy;
- paired automatic-minus-corresponding-explicit median latency overhead is at most 15 seconds and at most 20% of corresponding-explicit p50;
- automatic p95 does not regress against corresponding explicit p95.

Selector latency uses within-pair deltas. Prompt-policy recovery may occur only once inside the original cumulative lane, only when the bounded fallback budget preserves useful runtime and teardown reserves, and must retain ordered attempt history. Any invalid GitHub audit, hard collector timeout, incomplete lane, missing pair, unsafe fallback, or rewritten row fails the campaign closed.

## Result

All 36 rows were collected once in order. Automatic selection was exact 12/12, automatic statuses were exact 8/8, automatic and incremental lanes completed 48/48, neither strategy used fallback, and adjudicated defect presence and exact severity were 8/8 for every strategy. Both V10 failure fixes held.

V11 still failed because corresponding explicit fresh no-prior row `976b306437c8e2d89961a518` completed all five child lanes but spent several minutes on unnecessary parent shell validation. Review authority cleared before host finalization, so the retained visible findings could not establish a valid host-completed lifecycle. Only 11/12 planned automatic pairs were operational.

The eleven operational pairs had a favorable −5.147-second (−5.0%) median delta. Automatic p95 was 155.228 seconds versus 153.779 seconds for corresponding explicit rows, a narrow regression that independently fails the precommitted p95 gate. Automatic defaulting remains unreleased; immutable sanitized evidence is retained under `tests/benchmarks/review-semantic/automatic-selector-v11/`.
