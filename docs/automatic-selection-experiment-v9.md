# Automatic fresh versus incremental selection v9

Status: **prospectively frozen; collection not yet complete**.

V9 is the release-gate campaign for the canonical recovery and termination fixes at candidate `0f79c91668f83fffcee7b952ea8027f8d8c6e2b3`. It uses `openai-codex/gpt-5.6-sol` at medium effort. Its 36 rows must be collected exactly once in stored plan order, retaining failures without reruns, substitutions, skips, or rewriting.

- corpus SHA-256: `667fa2976bfb730a279ddb4afb79615b23751cd6a8ac8089ecca2eb27e38d0d6`
- plan ID: `10dcf90559089863aa809e30c40d4b000c9dff8375f897d07d759b03fa88f13c`
- plan SHA-256: `32b7095a346acd0e0176017b3aa5b0ce539e3575f941929554ac7eec3bf28bd8`
- modes: balanced
- strategies: fresh, incremental, automatic
- repetitions: 2

## Precommitted release gates

Automatic defaulting is authorized only if all of these gates pass:

- all 36 planned rows are retained exactly once and remain privacy-sanitizable;
- automatic selection and observed prior relationship are exact for all 12 automatic rows;
- automatic prior-finding statuses are exact for every applicable finding;
- automatic completion is 12/12 and every required automatic lane completes;
- every automatic row and its corresponding explicit-strategy row are operational, yielding all 12 planned pairs;
- adjudicated defect presence and source-authored severity are no worse than the corresponding explicit strategy, with no clean-control false-positive regression;
- duplication, fallback use, and fallback publication are no worse than the corresponding explicit strategy;
- paired automatic-minus-corresponding-explicit median latency overhead is at most 15 seconds and at most 20% of corresponding-explicit p50;
- automatic p95 does not regress against corresponding explicit p95.

A successful targeted replacement counts only when it canonically completes the original required lane, retains the failed attempt in ordered history, and the top-level Pi process exits normally. Any invalid GitHub audit, hard collector timeout, incomplete required lane, missing pair, or rewritten row fails the campaign closed.
