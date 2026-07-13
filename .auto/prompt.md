# Autoresearch: Faster PR review without quality loss

## Objective
Reduce end-to-end wall-clock latency of a real `/pr-review` invocation while preserving the four independent review lenses, structured output quality, and strict relevance to the reviewed PR. Explore concurrency, scheduling, context partitioning, and orchestration reductions. Do not optimize by weakening models, thinking levels, tool access needed for validation, skipping candidate validation, reducing severity coverage, or special-casing the benchmark PR.

The representative workload reviews merged PR #1 (`fix: publish completed reviews after head changes`, 6 files, 505 changed lines) with the checkout's local extension and prompt. A prior production trace on a much larger 482 KB PR is also useful calibration: total active review 965,781 ms, batch 580,428 ms; individual passes were overview 60,724 ms, conventions 373,558 ms, correctness 580,422 ms, and security/performance 459,072 ms. Aggregate orchestration was 385,354 ms. Changes must generalize to both ordinary and large PRs.

## Metrics
- **Primary**: `review_wall_ms` (ms, lower is better) — direct wall time of a complete real-model review.
- **Secondary**: `quality_gate`, `relevance_rate`, `pass_success`, `finding_count`, `review_chars` — independent quality and scope monitors. `quality_gate` must remain 1, relevance must remain 1, and every required pass must succeed.

## How to Run
`./.auto/measure.sh` runs the ordinary PR #1 workload. `./.auto/measure-large.sh` runs the 482 KB NERVous-system PR #4 generalization workload (override with `LARGE_REVIEW_REPO`/`LARGE_REVIEW_PR`). Both are non-publishing, emit `METRIC name=value`, and record the active workload so `.auto/checks.sh` can run the complete tests and independently revalidate the captured review.

## Files in Scope
- `prompts/pr-review.md` — orchestrator scheduling, context assembly, relevance, validation, and output contract.
- `extensions/pr-review-subagent.ts` — bounded subagent scheduling, subprocess execution, pass context, and batch reporting.
- `lib/pr-review-policy.ts`, `lib/pr-review-thinking.ts`, `lib/pr-review-telemetry.ts` — only when needed for measured scheduling/runtime behavior.
- `tests/*.test.ts` — regression tests for any production change.
- `README.md` — user-facing documentation for retained behavior changes.
- `.auto/*` — benchmark/check harness and durable experiment notes; benchmark changes must improve signal, never make the workload easier.

## Off Limits
- Do not edit PR #1, its GitHub metadata, expected changed-file set, or model output.
- Do not publish reviews or GitHub comments.
- Do not reduce the required overview, conventions/maintainability, correctness, or security/performance coverage.
- Do not lower configured/default model quality or thinking level for benchmark gains.
- Do not remove repository-context tools from specialist passes where they are needed to substantiate findings.
- Do not weaken relevance checks, output validation, tests, or benchmark quality gates.
- Do not modify `.pi/`, user configuration, credentials, or global installed packages.

## Constraints
- Preserve all four review lenses and all severity levels (`nit` through `P0`).
- Every finding must remain caused by or provably relevant to the PR diff.
- Failed or incomplete passes must still be rerun or covered inline.
- The complete Bun test suite must pass after every retained result.
- Benchmark with `--no-comment`; never perform GitHub writes.
- Avoid benchmark-specific branches or hardcoded PR/file behavior.
- Favor architecture that also improves large and cross-file PRs; do not overfit to PR #1.

## What's Been Tried
- Baseline: four concurrent passes took 920,422 ms total; batch 500,104 ms with correctness at 500,102 ms, and all quality/relevance gates passed.
- **Kept:** split correctness into state/lifecycle and contracts/data specialists, and security/performance into separate specialists, running six complete-diff passes at `max_parallel: 6`; batch specialist and parent candidate-evidence reads. This first reduced total to 631,567 ms with baseline-level finding coverage.
- **Kept:** capture the exact complete diff once in a bounded mode-0600 `context_file`, load it inside the extension for every specialist, and keep it out of parent tool arguments/conversation. Specialists preserve full cross-file coverage while the parent independently reads candidate hunks.
- **Kept (ordinary PR):** rebalance state/lifecycle, API/data/error contracts, and resource ownership/cleanup across the existing specialists without dropping categories. Best total is 389,802 ms (-57.6% vs ordinary baseline), batch 207,382 ms, all six passes/relevance gates pass, and retained findings match baseline 8.
- **Current default:** use the validated balanced five-pass topology (four heavy P0-P2 lenses plus at most three overview P3/nits) to reduce token/model work. Preserve the six-pass all-severity topology behind `--full`; `--balanced` remains an explicit compatibility alias and `--major-only` removes minor discovery.
- **Kept (large PR generalization):** for 200–399 KB use two whole-file, changed-line-balanced shards; at 400 KB+ use three. Run every base lens over every shard, cap at 12, and dispatch heavy specialists before queued medium/light work while preserving result order. On the 513 KB PR, 18 passes completed in 833,828 ms (-26.2% vs large unsharded baseline), relevance stayed 1.0, and 29 findings exceeded baseline 25.
- Discarded seven/eight-pass expansion, compact specialist JSON, prompt shortening, shared-prefix prompt reordering, pre-attached diff excerpts, and narrower global heavy-role wording: each either regressed total latency, reduced finding yield, or both. Real-model repeats vary substantially with candidate yield, so require clear primary gains plus stable quality signals.
- Discarded one-wave initial/validation scheduling after a 840,440 ms sample. It reduced initial gathering from two turns to one and validation from five turns to two, but batch variance dominated; repeat later if useful.
- **2026-07-11 quality baseline:** ordinary PR #1 completed all six passes and structural/relevance gates in 689,257 ms with 4 findings. Finding count is recorded only as diagnostics—not a quality score or keep/discard criterion; compare coverage, relevance, successful passes, and substantive output instead.
- **Discarded:** four-shard/24-way saturation of the 513 KB workload. The batch took 575,799 ms and two heavy passes failed with `Model not found gpt-5.6-luna`, so the review was incomplete; do not infer a speed gain from this failed run. Restored the proven three-shard policy.
- **Kept (ordinary PR):** parent uses specialist locations/rationale as a navigational index, makes explicit confirm/reject/evidence-needed decisions, batches only source-grounded questions that remain unresolved, and never trusts a specialist conclusion automatically. Two fully gated runs took 624,122 ms and 553,408 ms with all six passes/relevance gates/checks passing. Parent post-batch work was 103,719 ms and 89,778 ms respectively, versus roughly 214s in the pre-change trace; source-validation remained two turns/seven calls. Finding counts (8 and 6) are diagnostics, not retention criteria.
- Current provider intermittently returns `Model not found gpt-5.6-luna` for individual child passes across both ordinary and large fan-outs. These incomplete reviews are invalid benchmark results; do not conflate this external reliability issue with review quality or scheduling performance. The MAGI-directed source-identical large confirmation also failed this way (one contracts shard after 401s), so it cannot resolve the ordinary-win/large-total-time uncertainty; do not run further large variants without a new phase-level hypothesis.
- **Kept (ordinary confirmation):** after stabilizing an unrelated lifecycle integration test so setup contention cannot preempt the descendant command, a fully gated review completed in 549,796 ms with an 85,235 ms parent phase. It preserved all six passes and relevance/structural gates; its 5 findings remain diagnostic only. A later no-change fully gated replicate took 821,944 ms while its parent phase remained 95,210 ms, confirming that specialist/model latency dominates end-to-end variance; do not claim a new total-speed effect from one sample.
- **Discarded:** queueing the ordinary context-only overview behind five initial specialists. It completed all six passes/gates in 610,139 ms with an 87,943 ms parent phase, but was not a clear improvement over retained six-slot evidence-index runs; the 9 findings are diagnostic only. Restored six-slot dispatch and reconfirmed 564,272 ms total / 91,000 ms parent phase with all gates passing. Across five fully gated ordinary samples, total-time median is 564,272 ms and the four instrumented parent phases have a 89,778 ms median; the pre-protocol trace was 689,257 ms / roughly 214s parent.
- Crashed child-resource isolation experiment: all six passes completed but batch was slower (529,546 ms) and the parent hit a 300-second WebSocket idle timeout during final synthesis. No evidence justified retaining it.
- Overview remains context-only when the complete diff can be supplied; all specialist passes retain configured tools and complete-diff cross-file visibility.
- Both ordinary and 482 KB production traces show correctness and aggregate orchestration dominate. Prefer narrower objective boundaries or structural output/synthesis improvements over file sharding that could hide cross-file defects.
