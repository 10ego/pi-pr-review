# Incremental re-review experiment v7

Status: **complete historical baseline; automatic defaulting rejected**.

> This experiment evaluated the v1.18.0 code-only topology: ancestor runs hunted only the new-commit delta and same-head runs dispatched no reviewers. It did not include participant replies, rejection rationales, or seeded defects missed by the prior review. The cumulative conversation-aware topology introduced afterward requires a new corpus revision and paired campaign before any defaulting decision.

This experiment validates the incremental re-review behavior released in `pi-pr-review@1.18.0` before plain `/pr-review N` is allowed to auto-detect prior state. Corpus v6 remains the accepted topology evidence; it cannot exercise prior-review discovery, status disclosure, delta comparison, or revalidation-only behavior.

## Decision under test

Compare an explicit fresh balanced review with an explicit incremental balanced review of the same current pull-request head. The experiment decides whether plain `/pr-review N` may auto-detect prior state by default while `--fresh` becomes the explicit full-review override. It does not authorize a topology change.

## Frozen design

- Package under test: `pi-pr-review@1.18.0` source identity, or a later candidate whose complete source fingerprint is recorded separately.
- Strategies: `fresh` and `incremental`.
- Review mode: `balanced` for both strategies.
- Repetitions: 2.
- Cases: 6 re-review fixtures per strategy and repetition (24 immutable rows).
- Order: deterministic planner order, interleaved by case and strategy, with the first strategy rotated across cases/repetitions.
- Runtime: one row per collector invocation; no reruns, substitutions, skips, or reordered rows.
- Configuration: one provider/model/thinking/tool/deadline/runtime/source/environment identity across every row.
- Publication: disabled; all GitHub reads are served by the local read-only shim.
- Evidence: one atomic result envelope per row with embedded hash-bound lane/session/process/audit/review artifacts.

## Required fixture cases

1. **Unchanged open blocker plus benign delta** — a prior P1 remains in unchanged code while the new commits are clean. Incremental output must disclose it as `still open` and carry it into Findings; fresh review must rediscover the actionable defect.
2. **Resolved blocker** — the delta fixes a prior P1 without introducing another defect. Incremental output must mark it `resolved` and must not publish it as a current finding.
3. **Obsolete prior plus new blocker** — the delta removes the code owning a prior P2 and introduces a new P1 elsewhere. Incremental output must mark the prior `obsolete` and report the new blocker.
4. **Same-head revalidation** — the prior head equals the current head and contains a still-open P2. Incremental review must dispatch zero lanes, disclose the prior as `still open`, carry it into Findings, and remain COMMENT-only under publication v1.
5. **No prior marker** — discovery returns `none`; incremental invocation must fail open to the ordinary full balanced review and retain fresh-review semantic recall.
6. **Diverged prior head** — the marker head is absent from current PR history; incremental invocation must fail open to the ordinary full balanced review and explain the divergence.

Every reviewer-visible title, body, diff, commit message, branch, and prior review must omit benchmark case IDs and expected-answer text.

## Corpus and plan contracts

Corpus schema v2 adds immutable re-review state to each case:

- full base-to-current diff and its SHA-256/byte count;
- prior base-to-prior diff and incremental prior-to-current diff where applicable;
- relationship (`incremental`, `same_head`, `none`, or `diverged`);
- marker-bearing prior review metadata and root inline findings where applicable;
- expected prior statuses (`resolved`, `still open`, or `obsolete`);
- existing seeded current-finding semantics and acceptable full-diff locations.

Plan schema v2 adds `strategy` (`fresh` or `incremental`) while retaining `mode: balanced`. Result rows bind the same strategy. Existing schema-v1 corpora, plans, bundles, and reports remain readable and byte-stable.

The collector must materialize a real base/prior/current Git history, serve reviews/comments/commits and compare endpoints from the read-only `gh` shim, and invoke exactly one of:

- fresh: `/pr-review 1 --no-comment --balanced --fresh` after that flag exists, or the equivalent explicit full command while benchmarking 1.18.0;
- incremental: `/pr-review 1 --no-comment --balanced --incremental`.

## Metrics

In addition to existing semantic recall, false-positive, lifecycle, fallback, and latency metrics, v7 reports per strategy:

- current actionable-finding recall;
- prior-status exact accuracy and omission count;
- still-open carry-forward recall;
- resolved/obsolete findings incorrectly republished as current;
- relationship-selection accuracy;
- dispatched lane count and lane-time sum;
- total wall and parent validation/synthesis latency;
- approval eligibility/event classification, including the known same-head COMMENT requirement.

## Predeclared decision rule

Default auto-detection is eligible only if all conditions hold in the complete two-repetition cohort:

1. Incremental P0/P1 and P2 current-finding recall are no lower than fresh.
2. Every expected prior status is disclosed exactly once; every still-open prior is carried into Findings, and no resolved/obsolete prior is republished as current.
3. `none` and `diverged` cases dispatch the complete balanced topology and have recall no lower than their fresh counterparts.
4. Same-head cases dispatch zero lanes, retain every still-open prior, and never become approval-eligible under publication v1.
5. Incremental cases read only the prior-to-current delta for fresh hunting while retaining all expected prior findings.
6. Across the incremental-relationship and same-head cases, incremental median total wall time and lane-time sum are both lower than fresh; no latency improvement may compensate for a semantic miss.
7. Incremental clean-control false-positive and duplicate rates are no higher than fresh.
8. Every planned row is present and passes artifact, session, model, strategy, topology, timing, relationship, and no-write validation.

Any semantic miss, status omission, incorrect narrowing on `none`/`diverged`, or evidence-integrity failure rejects automatic defaulting. Criteria will not be relaxed after outcomes. Publication-v2 approval eligibility and thread replies remain separate follow-ups even if this experiment passes.

## Execution phases

1. Implement and test schema-v2 corpus/plan/result compatibility and the prior-state GitHub shim.
2. Add the six pinned fixtures and deterministic perfect/failing bundle tests.
3. Generate the immutable 24-row plan and record all executable/source/configuration fingerprints.
4. Collect all rows with the acknowledged real-model collector.
5. Score, privacy-sanitize, independently review the evidence, and record the retain/reject decision.

## Results

The final campaign retained all 24 planned rows. Three fresh and three incremental rows failed operational evidence requirements. Across all rows, fresh/incremental P0/P1 recall was 66.67%/50%, P2 recall was 50%/100%, clean-control case false-positive rate was 50%/0%, and publication fallback was 25%/25%. Incremental relationship selection was 12/12, exact prior-status accuracy was 6/8, still-open semantic carry-forward was 4/4, no resolved/obsolete prior was republished, and neither same-head row was approval-eligible.

Seven case/repetition pairs completed operationally under both strategies. Both retained every represented seeded defect (2/2 P0/P1 and 1/1 P2). Incremental median lane time was 21.9% lower and aggregate lane time was 10.4% lower, but median total wall time was 12.8% slower. The valid same-head pair was 45.9% faster under incremental review; the four valid ancestor-incremental pairs were slower overall.

## Decision

**Reject automatic defaulting.** Conditions 1, 2, 6, and 8 failed: aggregate P0/P1 recall was lower after operational failures, one successful status paraphrased rather than naming the required prior title, incremental median wall time was not lower, and six rows failed operational evidence requirements. The results nevertheless validate useful opt-in behavior: exact relationship selection, complete still-open carry-forward, no resolved/obsolete republication, lower lane work, fewer clean-control findings, and a material same-head speedup.

Keep `--incremental` opt-in. Before another paired campaign, prioritize exact-title prompt enforcement, terminal-assistant/completed-review consistency, and parent revalidation latency. Immutable sanitized evidence and pilot provenance are under `tests/benchmarks/review-semantic/incremental-v7/`.
