# Incremental v15 evidence

Immutable paired campaign for bounded cumulative-gap contract retry.

- candidate: `ce0260b`
- corpus SHA-256: `f67ba075183a2a9f8636a288b5ed1bb2f4ed29faeabc3d7a90906f0a215393e7`
- plan ID: `e1a1227b525f538273a6433b7d855330032ba6bed7fc8f78f560d4a078ae0cff`
- plan SHA-256: `8333533d43b952db0be9f1975337f1b43b5012842846724612fabd2a5cabc607`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 24 rows completed once in stored order with zero collector failures or reruns. Incremental improved operational completion, fallback rate, duplication, and exact severity, while preserving exact statuses and carry-forward. Automatic selection remains rejected because one retried gap lane stayed partial and complete-pair median latency was 1.943x fresh. The untouched raw report is accompanied by transparent visible-defect adjudication. See `docs/incremental-experiment-v15.md`.
