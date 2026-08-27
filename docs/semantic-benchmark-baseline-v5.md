# Semantic benchmark baseline v5

Status: **historical diagnostic evidence; corpus invalid for gates or topology retention**.

This report is the first complete real-model balanced/full comparison over the versioned semantic corpus. Independent review later established that `clean-batched-lookup` was not clean: the patch removed the empty-input no-query behavior. The raw evidence remains immutable historical context, but v5 clean-control rates are invalid and no v5 report may authorize a topology change or baseline gate.

## Identity

- Corpus: `pi-pr-review-semantic-v5`
- Corpus SHA-256: `f696b34699eba9a2e2e67b07754b426ab1c2b34c4d382ac6f580ecc1b6e0c81b`
- Plan ID: `4bf04da24af027fd03275dcc8cd53e664d543db63f7f59e7c6715bb7c6042813`
- Plan file SHA-256: `f3b790f463c467c92c834fccc8d28f03313c71cd5bd1832f2519b4e11682c51c`
- Original report SHA-256: `eaf9a55d7b3831060cc5b7a8c80f619988261f4c7c8a87fe8b6b5ce366fab80a` (retained, superseded for interpretation)
- Adjudicated report SHA-256: `384b6b04d9d99e6c1c4bb6653c07df73cfc6e5a1a996e62ff47e49009a707ec5`
- Scorer SHA-256: `d21abe17f4dc09d3a7ff62f11ef5ec58765140916ed75654955433b7d47c6708`
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
| Duplicate finding rate | 0% | 0% |
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

The recall, lifecycle, fallback, and latency observations remain useful historical diagnostics. Clean-control finding rates do not: repeated reviews correctly identified the newly introduced empty-input database call, which the v5 labels incorrectly counted as a false positive. Because clean-control validity is part of the benchmark contract, this invalidates the whole v5 cohort for gate derivation rather than merely adjusting one metric after outcomes.

`report.json` and `report-adjudicated.json` therefore remain `baseline_required`, and there is no accepted-gates file. Corpus v6 replaces only that defective clean-control diff by preserving the empty-input fast path. All topology retention and fresh baseline work must use v6 and fresh evidence; v5 metrics cannot serve as relative no-regression thresholds.
