# Semantic review benchmark

The seeded semantic benchmark measures whether review topology changes preserve defect recall instead of merely producing structurally valid output. It is development tooling and is not included in the npm package.

## Boundaries

- The checked-in planner and scorer make no model, Pi, GitHub, network, subprocess, or publication calls.
- The separate collector runs only with the explicit `--acknowledge-real-model-run` flag. Real collection currently requires macOS `sandbox-exec`: Pi and every reviewer descendant inherit a profile that denies the user's HOME and keychain service, while an isolated HOME contains only the effective benchmark review config and the minimum configured provider credentials. GitHub/token/SSH environment variables are removed, absolute system `gh` is unauthenticated, a strict read-only `gh` shim is first on `PATH`, every unknown or write-shaped shim command is rejected, and the prompt always invokes `/pr-review ... --no-comment`. Provider network calls remain available. The configured model process can access the isolated provider credentials needed to run reviews; use dedicated provider credentials for hostile-model testing. Provider networking remains enabled, so the sandbox does not claim to prevent anonymous outbound requests to public GitHub endpoints; it prevents authenticated publication by withholding user GitHub, Git, keychain, and SSH credentials and rejects every write-shaped shim command.
- Every collection retains normalized and raw lane evidence plus the canonical/degraded review envelope.
- Corpus diffs contain no expected-finding IDs, rationales, or benchmark annotations. Do not add answer clues to reviewer-visible files, prompts, titles, or diffs.
- Results are immutable inputs. The scorer creates its report with exclusive-create semantics and rejects missing, duplicate, malformed, symlinked, path-escaping, or hash-mismatched evidence.
- Finding count is diagnostic. Recall, false positives, completeness, fallback, and latency are evaluated separately.

## Corpus

`tests/benchmarks/review-semantic/corpus-v5.json` pins every diff by SHA-256. Version 5 contains:

- compile/export contract failure;
- returned data-shape mismatch;
- cancellation/state race;
- event-listener ownership leak;
- tenant authorization regression;
- shell-command injection;
- quadratic reconciliation regression;
- cross-file cache/caller integration failure;
- a 200–400 KB two-file registry/caller contract failure that deterministically exercises two-shard balanced and full topology;
- non-finite boundary input;
- two clean controls.

Each expected finding has a stable ID, explicit target severity, allowed observed severity set, one or more acceptable diff locations, semantic concept groups, assertion-pattern examples for audit/review, applicable lenses, a blocking classification derived from the target severity, and a cross-file flag. Recall denominators use `targetSeverity`; reordering allowed severities cannot move an opportunity between P0/P1 and P2. A finding matches only when its severity is allowed, its location falls on the accepted changed line or one adjacent context line on the correct side, and its title/body contains at least one term from every concept group. Matching never requires one exact wording template. Explicit non-findings such as “safe,” “not an issue,” or “no finding exists,” plus case-specific contradiction patterns, are rejected before matching. Matching uses deterministic maximum bipartite matching so result order cannot change recall.

### Adding a case

1. Add a unified diff under `tests/benchmarks/review-semantic/diffs/`. Use ordinary filenames and code; never mention the benchmark ID or expected answer in the diff.
2. Add the case to `corpus-v5.json`, including the exact diff SHA-256 and changed-file list.
3. For every seeded defect, define a globally unique expected ID, target and allowed severity policy, tight alternative locations, rationale, lenses, blocking flag, cross-file flag, semantic concept groups, and relationship-bearing assertion patterns. Test both valid alternative wording and an explicit negated/non-finding phrasing.
4. Set `cleanControl: true` only when `expectedFindings` is empty.
5. Run `npm run test:tooling`. Corpus validation independently recomputes hashes and changed paths, requires clean controls and cross-file coverage, and requires at least one seeded finding for every default heavy lens.
6. Change `corpusId` for a semantically incompatible corpus revision. Existing plans, results, baselines, and reports remain bound to the prior corpus hash.

## Create a repeated comparison plan

```bash
npm run benchmark:review -- plan \
  --corpus tests/benchmarks/review-semantic/corpus-v5.json \
  --modes balanced,full \
  --repetitions 5 \
  --output /absolute/evidence/plan.json
```

The deterministic plan contains every `(mode, repetition, case)` tuple exactly once. It interleaves modes per case and rotates the first mode across cases/repetitions so a provider time window is not confounded with one whole mode. `planId` binds the corpus hash, ordered modes, repetitions, and entries. Use the same plan for every comparison; do not reorder, drop, substitute, or rerun slow or failed entries.

Supported modes are `balanced`, `full`, `major-only`, and `deep`.

## Collect one real-model entry

The collector intentionally accepts exactly one plan entry per invocation. It requires the next uncollected entry in plan order, creates results and evidence exclusively, and refuses reruns. This makes provider failures and timeouts durable observations rather than opportunities for cherry-picking.

```bash
npm run benchmark:review:collect -- \
  --corpus tests/benchmarks/review-semantic/corpus-v5.json \
  --plan /absolute/evidence/plan.json \
  --bundle /absolute/evidence/bundle \
  --entry <next-plan-entry-id> \
  --pi "$(command -v pi)" \
  --expected-pi-sha256 "$(shasum -a 256 "$(realpath "$(command -v pi)")" | awk '{print $1}')" \
  --node "$(command -v node)" \
  --expected-node-sha256 "$(shasum -a 256 "$(realpath "$(command -v node)")" | awk '{print $1}')" \
  --expected-collector-runtime-sha256 "$(shasum -a 256 "$(realpath "$(command -v bun)")" | awk '{print $1}')" \
  --model <provider/parent-model> \
  --thinking <level> \
  --acknowledge-real-model-run
```

The collector verifies the exact Pi launcher hash/version, pins the explicitly supplied Node executable hash/version, pins the Bun executable/version running both the collector and shim, hashes the installed Pi package's complete `dist/` tree plus package manifest, then loads a read-only snapshot of this checkout's extension and prompt explicitly with normal extension/skill/context discovery disabled. It records the Pi hash/version, a full extension/lib/prompt source-tree hash, prompt hash, collector hash, and effective review-config hash. Reviewer tiers, fallbacks, thinking, tool policies, tools, and deadlines come from the user's `pr-review.json`; posting, extraction, stale approval, and verification are force-disabled in the isolated effective copy. The bundle records the observed provider/model for every retained lane. The scorer rejects comparisons if any pinned executable/source/config identity changes or if a shared lane ID changes observed provider/model between runs.

The local `gh` shim serves generic PR metadata, the pinned corpus diff, and the temporary fixture head. Reviewer-visible PR metadata never contains case IDs or expected-answer text. The collector materializes a real Git base/head repository from the diff so configured read-only repository tools can inspect the changed files. It verifies every observed `gh` command was an allowed read before committing the result.

The collector independently caps Pi at the effective review `totalMs` plus a 30-second coordinator allowance. It launches a detached process group, sends group TERM at the cap, sends KILL after five seconds, bounds captured stdout/stderr to 5 MiB each, and commits the timeout as a failed row even if descendants retain pipes.

Once Pi launch is attempted, a Pi/provider failure, collector hard timeout, invalid session lifecycle, rejected GitHub command, or missing audit still produces and exclusively commits a result: required lanes without retained evidence are `failed` with null timing/model identity, publication is `raw_body_only`, and process/session/audit evidence stays in the lane envelope. The command exits nonzero after retaining that result. Do not delete it or rerun the entry.

## Result bundle contract

Place one JSON result per plan entry directly under `BUNDLE/runs/`. Store raw evidence elsewhere beneath `BUNDLE/` and reference it from the result. Each result is strictly schema-checked and must contain:

- exact plan entry, case, mode, and repetition identity;
- start timestamp and total wall time;
- observable combined parent validation/synthesis time (the host's aggregate orchestration interval outside review and verification tools);
- provider, model, thinking, tool policy, package version, Pi launcher/version and complete runtime-tree hash, Node version/hash, collector/shim Bun version/hash, effective review-config hash, source-tree/prompt/collector hashes, pass IDs, shard count, and maximum parallelism;
- every required lane's ID, lens, lifecycle (`complete`, `partial`, `timed_out`, or `failed`), elapsed time, provider, and model;
- the exact ordinary-diff topology for the selected mode (balanced/major-only five lanes, full six lanes, or deep one lane);
- publication artifact class (`canonical`, `degraded`, or `raw_body_only`) and fallback flag;
- normalized findings with title, body, severity, and optional diff location;
- exactly two distinct immutable JSON evidence references: `lane-artifacts` and `canonical-review`, each with a bundle-relative path, byte count, and SHA-256. The lane envelope repeats the exact normalized lane array, requires raw evidence for every non-failed normalized lane, and embeds the exact base64 session bytes whose hash/size/record count are independently recomputed. The scorer reparses those retained records and requires exactly one matching completed-review record and terminal telemetry record, exact raw lane/telemetry/Markdown binding, coherent canonical/degraded/raw classification, and findings equal to the collector's host-parser-resolved review (plus any persisted inline review object). It also recomputes every normalized lane lifecycle, timing, and observed model from retained raw lane artifacts, checks each observed lane model against the effective tier/fallback configuration, and binds the parent provider/model/thinking to retained session change records. It also retains process output/outcome, telemetry, and the GitHub audit. The canonical envelope repeats the exact publication classification and findings plus nonempty Markdown containing every normalized finding title. The scorer compares those envelopes to the structured run, so sparse or unrelated hash-valid files cannot impersonate evidence.

The collector must represent failed and timed-out lanes as results, not omit or rerun them. The scorer derives the expected mode-specific lane set from each pinned diff's byte size and changed-file count (including expanded shard IDs) and computes completeness over that set; omitted lanes are invalid rather than disappearing from the denominator. All runs must share the same orchestrator provider/model/thinking/tool/version and pinned runtime/source/configuration identity (the sanitized effective config is retained once at the bundle root), and every shared lane ID must retain one provider/model identity across modes. Keep all raw bundles for failed gates. Never place provider credentials, prompts containing secrets, repository secrets, or unrelated session data in a bundle.

## Score a complete bundle

```bash
npm run benchmark:review -- score \
  --corpus tests/benchmarks/review-semantic/corpus-v5.json \
  --plan /absolute/evidence/plan.json \
  --results /absolute/evidence/bundle \
  --output /absolute/evidence/report.json
```

Without `--gates`, the report status is `baseline_required`: metrics are valid but cannot accept a topology. The report emits both a full configuration fingerprint (including extension/prompt source) and a stable environment fingerprint (models, thinking, tool policy, Pi/Node/Bun, effective config, and collector). Gates bind the environment fingerprint so reviewed topology source changes remain comparable rather than impossible. The scorer reports overall and per-mode:

- P0/P1, P2, per-lens, and cross-file recall;
- clean-control case false-positive rate and finding count/rate; unmatched findings on seeded-defect cases are reported separately rather than mislabeled as false positives;
- duplicate finding count/rate;
- exact-severity rate plus underclassified/overclassified matched finding counts (recall denominators continue to use target severity);
- complete, partial, timed-out, and failed lane rates;
- canonical/degraded publication fallback rate;
- p50/p95, mean, population standard deviation, minimum, and maximum wall time;
- p50 combined parent validation/synthesis time;
- per-run matched and missed stable finding IDs.

Percentiles use nearest rank over all planned runs. Failed and fallback runs stay in every denominator.

## Accept gates only after a baseline

Thresholds are not silently embedded in the scorer. After repeated baseline runs are reviewed and accepted, create a versioned gate JSON containing:

```json
{
  "schemaVersion": 1,
  "corpusId": "pi-pr-review-semantic-v5",
  "corpusSha256": "<exact corpus SHA-256>",
  "acceptedAtUtc": "<ISO timestamp>",
  "rationale": "<why these thresholds are justified by the baseline>",
  "baseline": {
    "reportSha256": "<accepted report SHA-256>",
    "planId": "<exact repeated comparison plan ID>",
    "environmentFingerprint": "<accepted environment fingerprint>"
  },
  "thresholds": {
    "modes": {
      "balanced": {
        "minimumP0P1Recall": 1,
        "minimumP2Recall": 0.8,
        "minimumCrossFileRecall": 1,
        "minimumPerLensRecall": {
          "correctness": 0.8,
          "correctness-contracts": 0.8,
          "security-performance": 0.8,
          "performance-resources": 0.8
        },
        "minimumExactSeverityRate": 0.8,
        "maximumCleanControlCaseFalsePositiveRate": 0.1,
        "maximumDuplicateRate": 0.1,
        "minimumLaneCompleteRate": 0.95,
        "maximumPublicationFallbackRate": 0.05,
        "maximumP50LatencyMs": 300000,
        "maximumP95LatencyMs": 600000
      },
      "full": {
        "minimumP0P1Recall": 1,
        "minimumP2Recall": 0.8,
        "minimumCrossFileRecall": 1,
        "minimumPerLensRecall": {
          "correctness": 0.8,
          "correctness-contracts": 0.8,
          "security-performance": 0.8,
          "performance-resources": 0.8
        },
        "minimumExactSeverityRate": 0.8,
        "maximumCleanControlCaseFalsePositiveRate": 0.1,
        "maximumDuplicateRate": 0.1,
        "minimumLaneCompleteRate": 0.95,
        "maximumPublicationFallbackRate": 0.05,
        "maximumP50LatencyMs": 300000,
        "maximumP95LatencyMs": 600000
      }
    }
  }
}
```

Those numbers are examples, not accepted project policy. The baseline review must justify the actual values. A gate file is accepted only when it binds the current plan and environment fingerprint, and it must define an exact threshold object for every planned mode. Each mode is evaluated independently; strong full-mode output cannot hide a balanced-mode regression in pooled metrics. Re-score with both `--gates /path/to/accepted-gates.json` and `--baseline-report /path/to/accepted-baseline-report.json`; the scorer recomputes and verifies the report SHA-256 plus corpus/plan/environment/result-count bindings before reading thresholds. A threshold failure exits nonzero.

For topology tuning, derive each per-mode threshold from the bound accepted baseline, require no P0/P1 or cross-file recall loss, bound any P2 regression, reject material clean-control or duplicate increases, and evaluate p50/p95 and variance across repeated runs. An apparent latency win caused by incomplete lanes, fallback publication, missing results, a weaker model/configuration, or reduced semantic recall is not an improvement.
