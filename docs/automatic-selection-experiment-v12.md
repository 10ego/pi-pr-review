# Automatic fresh versus incremental selection v12

Status: **prospectively frozen; collection not yet started**.

V12 is the release-gate campaign for post-deadline artifact retention at candidate `5ea22b4521e90a927b9e4ba27255e6a38d40744a`. It also retains V11's host-only parent GitHub API access and bounded cumulative prompt-policy retry hardening. It uses `openai-codex/gpt-5.6-sol` at medium effort. Its 36 rows must be collected exactly once in stored plan order, retaining failures without reruns, substitutions, skips, or rewriting.

- corpus SHA-256: `b58dd8a9ff439466694d5dfa6be0beed14b1bc350bd8d2db00fa85c72b02bd38`
- plan ID: `154b1d4f72734d60d11cf6b6023104e54e27a03fa9ddfb1990dfa319aefd3db3`
- plan SHA-256: `13d9144e5b4581f7ac3fecda1756ba681e01b136cb6a092831a0c2bf0f756271`
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

Selector latency uses within-pair deltas. Prompt-policy recovery may occur only once inside the original cumulative lane, only when the bounded fallback budget preserves useful runtime and teardown reserves, and must retain ordered attempt history. After any host deadline, later tools must be blocked without clearing retained invocation artifacts so deterministic host completion remains possible. Any invalid GitHub audit, hard collector timeout, incomplete lane, missing pair, unsafe fallback, or rewritten row fails the campaign closed.
