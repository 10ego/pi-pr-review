# Automatic fresh versus incremental selection v10

Status: **prospectively frozen; collection not yet started**.

V10 is the release-gate campaign for universal host-owned finalization at runtime fix `5443a06e3a28e2f7a35c989b5e59a3a85595a8586`, with immutable V9 evidence retained through candidate `8b8d32372644879652c0beee1e111d09c14e56b4`. It uses `openai-codex/gpt-5.6-sol` at medium effort. Its 36 rows must be collected exactly once in stored plan order, retaining failures without reruns, substitutions, skips, or rewriting.

- corpus SHA-256: `1b3e8e197339e6762235d2f56a285c32d663ed7501cf76f21459222585a5a8bf`
- plan ID: `7c1f3b8f665a11aaeba742413b3b5d692c124cdbe16ed51fea4c8974392fe41b`
- plan SHA-256: `dd9abaadbd2f71a45b879c93b3a5a18d03834cddecb4e8d4bc835c5da63a08ed`
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

Selector latency is measured from within-pair automatic-minus-corresponding-explicit deltas. A successful targeted replacement counts only when it canonically completes the original required lane, retains the failed attempt in ordered history, and the top-level Pi process exits normally. Any invalid GitHub audit, hard collector timeout, incomplete required lane, missing pair, unsafe publication fallback, or rewritten row fails the campaign closed.
