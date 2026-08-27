# Semantic review benchmark

The seeded semantic benchmark measures whether review topology changes preserve defect recall instead of merely producing structurally valid output. It is development tooling and is not included in the npm package.

## Boundaries

- The checked-in planner and scorer make no model, Pi, GitHub, network, subprocess, or publication calls.
- Real-model collection is a separate, explicitly initiated activity. Every collection must suppress publication and retain its raw lane and canonical review artifacts.
- Corpus diffs contain no expected-finding IDs, rationales, or benchmark annotations. Do not add answer clues to reviewer-visible files, prompts, titles, or diffs.
- Results are immutable inputs. The scorer creates its report with exclusive-create semantics and rejects missing, duplicate, malformed, symlinked, path-escaping, or hash-mismatched evidence.
- Finding count is diagnostic. Recall, false positives, completeness, fallback, and latency are evaluated separately.

## Corpus

`tests/benchmarks/review-semantic/corpus-v1.json` pins every diff by SHA-256. Version 1 contains:

- compile/export contract failure;
- returned data-shape mismatch;
- cancellation/state race;
- event-listener ownership leak;
- tenant authorization regression;
- shell-command injection;
- quadratic reconciliation regression;
- cross-file cache/caller integration failure;
- non-finite boundary input;
- two clean controls.

Each expected finding has a stable ID, allowed severity set, one or more acceptable diff locations, semantic concept groups, applicable lenses, a blocking classification, and a cross-file flag. A finding matches only when its severity is allowed, its location overlaps an accepted range on the correct side, and its title/body contains at least one term from every concept group. Matching uses deterministic maximum bipartite matching so result order cannot change recall.

### Adding a case

1. Add a unified diff under `tests/benchmarks/review-semantic/diffs/`. Use ordinary filenames and code; never mention the benchmark ID or expected answer in the diff.
2. Add the case to `corpus-v1.json`, including the exact diff SHA-256 and changed-file list.
3. For every seeded defect, define a globally unique expected ID, severity policy, tight alternative locations, rationale, lenses, blocking flag, cross-file flag, and semantic concept groups.
4. Set `cleanControl: true` only when `expectedFindings` is empty.
5. Run `npm run test:tooling`. Corpus validation independently recomputes hashes and changed paths, requires clean controls and cross-file coverage, and requires at least one seeded finding for every default heavy lens.
6. Change `corpusId` for a semantically incompatible corpus revision. Existing plans, results, baselines, and reports remain bound to the prior corpus hash.

## Create a repeated comparison plan

```bash
npm run benchmark:review -- plan \
  --corpus tests/benchmarks/review-semantic/corpus-v1.json \
  --modes balanced,full \
  --repetitions 5 \
  --output /absolute/evidence/plan.json
```

The deterministic plan contains every `(mode, repetition, case)` tuple exactly once. `planId` binds the corpus hash, ordered modes, repetitions, and entries. Use the same plan for every comparison; do not drop slow or failed runs.

Supported modes are `balanced`, `full`, `major-only`, and `deep`.

## Result bundle contract

Place one JSON result per plan entry directly under `BUNDLE/runs/`. Store raw evidence elsewhere beneath `BUNDLE/` and reference it from the result. Each result is strictly schema-checked and must contain:

- exact plan entry, case, mode, and repetition identity;
- start timestamp and total wall time;
- parent validation and synthesis time;
- provider, model, thinking, tool policy, package version, pass IDs, shard count, and maximum parallelism;
- every lane's ID, lens, lifecycle (`complete`, `partial`, `timed_out`, or `failed`), elapsed time, provider, and model;
- publication artifact class (`canonical`, `degraded`, or `raw_body_only`) and fallback flag;
- normalized findings with title, body, severity, and optional diff location;
- exactly two immutable evidence references: `lane-artifacts` and `canonical-review`, each with a bundle-relative path, byte count, and SHA-256.

The collector must represent failed and timed-out lanes as results, not omit or rerun them. Keep all raw bundles for failed gates. Never place provider credentials, prompts containing secrets, repository secrets, or unrelated session data in a bundle.

## Score a complete bundle

```bash
npm run benchmark:review -- score \
  --corpus tests/benchmarks/review-semantic/corpus-v1.json \
  --plan /absolute/evidence/plan.json \
  --results /absolute/evidence/bundle \
  --output /absolute/evidence/report.json
```

Without `--gates`, the report status is `baseline_required`: metrics are valid but cannot accept a topology. The scorer reports overall and per-mode:

- P0/P1, P2, per-lens, and cross-file recall;
- clean-control case false-positive rate and unmatched finding count/rate;
- duplicate finding count/rate;
- complete, partial, timed-out, and failed lane rates;
- canonical/degraded publication fallback rate;
- p50/p95 wall time;
- p50 parent validation and synthesis time;
- per-run matched and missed stable finding IDs.

Percentiles use nearest rank over all planned runs. Failed and fallback runs stay in every denominator.

## Accept gates only after a baseline

Thresholds are not silently embedded in the scorer. After repeated baseline runs are reviewed and accepted, create a versioned gate JSON containing:

```json
{
  "schemaVersion": 1,
  "corpusId": "pi-pr-review-semantic-v1",
  "corpusSha256": "<exact corpus SHA-256>",
  "acceptedAtUtc": "<ISO timestamp>",
  "rationale": "<why these thresholds are justified by the baseline>",
  "thresholds": {
    "minimumP0P1Recall": 1,
    "minimumP2Recall": 0.8,
    "minimumCrossFileRecall": 1,
    "maximumCleanControlCaseFalsePositiveRate": 0.1,
    "maximumDuplicateRate": 0.1,
    "minimumLaneCompleteRate": 0.95,
    "maximumPublicationFallbackRate": 0.05
  }
}
```

Those numbers are examples, not accepted project policy. The baseline review must justify the actual values. Re-score with `--gates /path/to/accepted-gates.json`; a threshold failure exits nonzero.

For topology tuning, require no P0/P1 or cross-file recall loss relative to the accepted baseline, bound any P2 regression, reject material clean-control or duplicate increases, and evaluate p50/p95 across repeated runs. An apparent latency win caused by incomplete lanes, fallback publication, missing results, a weaker model/configuration, or reduced semantic recall is not an improvement.
