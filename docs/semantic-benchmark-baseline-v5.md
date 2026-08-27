# Semantic benchmark baseline v5

Status: **diagnostic baseline accepted as evidence; retention gate not accepted**.

This report is the first complete real-model balanced/full comparison over the versioned semantic corpus. It is intentionally not an approval of the current quality level and does not authorize a topology change by itself.

## Identity

- Corpus: `pi-pr-review-semantic-v5`
- Corpus SHA-256: `f696b34699eba9a2e2e67b07754b426ab1c2b34c4d382ac6f580ecc1b6e0c81b`
- Plan ID: `4bf04da24af027fd03275dcc8cd53e664d543db63f7f59e7c6715bb7c6042813`
- Plan file SHA-256: `f3b790f463c467c92c834fccc8d28f03313c71cd5bd1832f2519b4e11682c51c`
- Original report SHA-256: `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a` (retained, superseded for interpretation)
- Adjudicated report SHA-256: `f955ce2726a22bdff1979010cc9ef80c21bca44afad2760143343c4c05695423`
- Scorer SHA-256: `68b5d846fbb343e6a724037f2053e5dd9ef6275b73c261c8db6df326a480a5b9`
- Configuration fingerprint: `2154a4bd206dd5e7079dbd7b895601350936bbf6c5085ac57230d3705d8d1155`
- Environment fingerprint: `b57c0360881010588090448615679d9a4b8b0cca362ad431274982fda6083d9d`
- Runs: 48/48 exact plan entries, two repetitions of 12 cases in balanced and full modes
- Parent: `zai/glm-5.3`, thinking `high`
- Lane tiers: configured `openai-codex/gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`
- Package behavior: `pi-pr-review` 1.15.8

The complete immutable evidence is under `tests/benchmarks/review-semantic/baseline-v5/`: plan, effective config, 48 normalized runs, retained session/lane/process/GitHub-audit envelopes, canonical/degraded review envelopes, report, and summary. No provider or GitHub credential appears in the retained bundle.

## Results

| Metric | Balanced | Full |
|---|---:|---:|
| Runs | 24 | 24 |
| P0/P1 recall | 92.86% (13/14) | 92.86% (13/14) |
| P2 recall | 83.33% (5/6) | 100% (6/6) |
| Cross-file recall | 83.33% (5/6) | 83.33% (5/6) |
| Correctness-lifecycle recall | 100% | 100% |
| Contracts/integration recall | 90% | 90% |
| Security recall | 100% | 100% |
| Performance/resource recall | 75% | 100% |
| Clean controls with findings | 50% | 100% |
| Exact-severity rate | 66.67% | 63.16% |
| Duplicate finding rate | 0% | 1.69% |
| Complete lane rate | 74.62% | 87.82% |
| Publication fallback rate | 37.5% | 62.5% |
| Visible findings recovered from fallback Markdown | 6 | 1 |
| p50 wall time | 221.97 s | 303.68 s |
| p95 wall time | 1229.99 s | 697.09 s |
| Wall-time std. deviation | 284.56 s | 151.38 s |
| Parent validation/synthesis p50 | 176.58 s | 239.01 s |

Overall seeded recall was 92.86% for P0/P1, 91.67% for P2, and 83.33% for cross-file findings. Unmatched findings on seeded-defect cases are retained as diagnostics rather than mislabeled as false positives, because several are genuine secondary defects exposed by the intentionally small fixture repositories.

The original derived report remains immutable evidence, but its interpretation is superseded. The adjudicated scorer now (1) counts strictly parsed, visible fallback findings while keeping fallback publication explicit, (2) accepts an adjacent replacement anchor on the opposite diff side, and (3) uses bounded corpus assertion alternatives when most required concept groups match. These corrections were applied to the original 48 run/artifact/session envelopes without provider reruns or evidence mutation.

## Interpretation

The corrected baseline shows equal balanced/full critical, cross-file, contract, security, and correctness recall. Full improves P2 and performance/resource recall, but costs roughly 82 seconds at p50, emits findings on every clean control, and has a much higher publication-fallback rate. Balanced is faster and less noisy but has lower lane completion and one additional P2 miss. Neither mode is healthy enough to define a permissive acceptance gate:

- only two repetitions were collected, which is weak for latency-tail policy;
- full mode emitted findings on every clean-control run, making its observed clean-control ceiling (`1.0`) non-protective;
- both modes had substantial partial/failed lane and fallback rates;
- exact severity was only 63–67%, with under- and overclassification both observed.

Therefore `report.json` correctly remains `baseline_required`; there is no checked-in `accepted-gates` file. This prevents a future experiment from claiming success merely by satisfying weak observed ceilings.

## Provisional no-regression targets for topology experiments

Until a stronger repeated baseline establishes accepted gates, #60 experiments must at minimum:

1. preserve or improve each mode's P0/P1, P2, cross-file, and per-lens recall shown above;
2. reduce, not preserve, full-mode clean-control findings and publication fallback;
3. not reduce exact-severity or lane-complete rates;
4. not increase duplicate rate;
5. improve p50 without worsening p95 or standard deviation;
6. retain every failed/timed-out row in comparisons;
7. use the same corpus, environment fingerprint, provider/model identities, and immutable evidence contract.

A candidate that cannot satisfy these relative targets is rejected even though no absolute gate has been accepted yet.
