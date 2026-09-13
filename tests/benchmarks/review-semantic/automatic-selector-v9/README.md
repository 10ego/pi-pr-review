# Automatic selector v9 evidence

Status: **complete; automatic defaulting rejected by one publication fallback**.

- candidate: `0f79c91668f83fffcee7b952ea8027f8d8c6e2b3`
- frozen-plan commit: `3468cca`
- corpus SHA-256: `667fa2976bfb730a279ddb4afb79615b23751cd6a8ac8089ecca2eb27e38d0d6`
- plan ID: `10dcf90559089863aa809e30c40d4b000c9dff8375f897d07d759b03fa88f13c`
- plan SHA-256: `32b7095a346acd0e0176017b3aa5b0ce539e3575f941929554ac7eec3bf28bd8`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order through the detached sequential collector, without reruns, skips, substitutions, or rewriting. All collector invocations exited normally, all 156 required lanes completed, automatic relationships were exact 12/12, and automatic prior statuses were exact 8/8. Adjudicated defect presence and exact severity were 8/8 for every strategy.

Automatic operational completion was 11/12. Row `126425b909e5457a0e56e278` (automatic, diverged, repetition 2) completed all five lanes with a valid GitHub audit, but the fresh path could not record host candidate finalization. Its terminal legacy scalar fields therefore failed the unchanged Markdown safety gate and produced `raw_body_only`. Automatic fallback was 1/12 versus 0/12 for both explicit strategies, so the campaign failed closed.

Across the 11 operational automatic pairs, the median automatic-minus-corresponding-explicit delta was -4.751 seconds (-6.8%). Automatic p95 was 220.947 seconds versus 345.066 seconds for corresponding explicit runs. These favorable latency results cannot override the absolute completion and fallback failure. Automatic defaulting remains unreleased.
