# Automatic fresh versus incremental selection v11

Status: **prospectively frozen; collection not yet started**.

V11 is the release-gate campaign for host-only parent GitHub API access and bounded cumulative prompt-policy retry at candidate `e05a79faaa75111bb005ec64633893677424fb5c`. It uses `openai-codex/gpt-5.6-sol` at medium effort. Its 36 rows must be collected exactly once in stored plan order, retaining failures without reruns, substitutions, skips, or rewriting.

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
