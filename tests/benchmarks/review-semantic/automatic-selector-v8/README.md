# Automatic selector v8 evidence

Status: **complete; automatic defaulting rejected by operational failures**.

- candidate: `316ef1fcd4b9c966e4ead893d123b472a2774ee8`
- lifecycle fix: `c650531ee0a33eaf863afc350078b66ccc5f66d0`
- corpus SHA-256: `7055ba33a7698c859c9b72c1158b02e02ad7f2dfe68cf2afb021a6b8a2e7def4`
- plan ID: `4d57d4a74ffe000953db2ea7a8210569f133b6f11c1bd2920ba51ff9ea079dbb`
- plan SHA-256: `22280b5f5a78da5b3a72033691ee014c07ba601204d50b8ec8659f8190384883`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order through the detached sequential collector, without reruns, skips, or substitutions. Automatic selection events and relationships were exact 12/12; automatic statuses were 8/8. Adjudicated defect presence and exact severity were 8/8 for every strategy.

Automatic operational completion was 11/12, with 46/48 required automatic lanes complete and fallback 1/12. One automatic same-head row exited successfully but failed closed after an unauthorized unhosted `gh api` read made its audit invalid. One explicit fresh no-prior row timed out a primary correctness lane, successfully ran the single targeted heavy replacement, emitted the expected findings, and then failed to terminate; the collector retained it at the 1,230-second hard timeout. That row left 11/12 corresponding explicit runs operational.

The ten operational automatic pairs had a -19.130-second median paired delta, a -21.6% ratio, and lower automatic p95, but the bounded latency policy correctly failed because all 12 planned pairs were not complete. Automatic defaulting remains unreleased.
