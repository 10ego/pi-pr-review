# Automatic fresh versus incremental selection v8

Status: **complete; automatic defaulting rejected by operational failures**.

V8 is the first campaign under the prospectively fixed bounded automatic-latency policy: median paired overhead must be at most 15 seconds and at most 20% of corresponding-explicit p50, automatic p95 must not regress, and every planned pair must be operational. All selector, prior-state, quality, duplication, fallback, privacy, and evidence gates remain unchanged.

- candidate: `316ef1fcd4b9c966e4ead893d123b472a2774ee8`
- lifecycle fix: `c650531ee0a33eaf863afc350078b66ccc5f66d0`
- latency policy: `0876f69`
- corpus SHA-256: `7055ba33a7698c859c9b72c1158b02e02ad7f2dfe68cf2afb021a6b8a2e7def4`
- plan ID: `4d57d4a74ffe000953db2ea7a8210569f133b6f11c1bd2920ba51ff9ea079dbb`
- plan SHA-256: `22280b5f5a78da5b3a72033691ee014c07ba601204d50b8ec8659f8190384883`
- model: `openai-codex/gpt-5.6-sol`, medium effort

## Results

- 36/36 rows retained exactly once in stored order, without reruns, skips, or substitutions;
- automatic selection events and relationships: 12/12 exact;
- automatic prior statuses: 8/8;
- adjudicated defect presence and exact severity: 8/8 for every strategy;
- incremental completion: 12/12 runs and 48/48 lanes;
- automatic completion: 11/12 runs and 46/48 lanes, fallback 1/12;
- corresponding explicit completion: 11/12 runs;
- complete automatic pairs: 10/12;
- latency over only those ten operational pairs: −19.130s median delta, −21.6%, with automatic p95 156.7s versus 184.8s corresponding explicit;
- bounded latency policy: failed closed because two planned pairs were incomplete.

One automatic same-head row exited zero with a complete visible review, but the collector rejected it because the retained GitHub audit contained an unauthorized unhosted `gh api` read. Its two required lanes therefore remain failed and the row remains fallback evidence.

One explicit fresh no-prior row exercised the new recovery path: the primary correctness lane timed out, the single targeted heavy replacement completed and the terminal output visibly retained both expected findings, but Pi did not terminate. The collector killed and retained the row at its 1,230-second hard timeout, so all five normalized lanes remain failed. This demonstrates that the reserved recovery window allowed replacement work, but it does not satisfy end-to-end operational completion.

Six raw matcher misses were separately adjudicated as visibly equivalent findings, including the two failed-row outputs. `adjudication.json` records those decisions without modifying the immutable rows or raw report.

Automatic defaulting remains unreleased. The favorable latency among complete pairs cannot override missing automatic/corresponding runs, incomplete required lanes, or fallback evidence. V8 is retained unchanged and no row may be rerun.
