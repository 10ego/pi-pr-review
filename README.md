# pi-pr-review

Parallel, model-agnostic AI code review for GitHub pull requests in the [Pi coding agent](https://pi.dev).

Give it a PR number and it will:

- fetch the PR metadata and diff with `gh`;
- run focused review passes in parallel using models you choose;
- validate candidate findings before reporting them;
- render a structured review with severity, location, confidence, and verdict;
- optionally publish one safe GitHub review with inline comments (fully parsed, complete Markdown and strict host-bound JSON share the same gated `APPROVE` path; degraded reviews remain `COMMENT`).

The default review prioritizes P0–P2 defects and allows up to three minor findings. Use `--full` for exhaustive convention, maintainability, and minor coverage.

## Requirements

- Pi `0.80.5` or newer (the first release with the terminal `agent_settled` lifecycle event).
- [`gh`](https://cli.github.com/) installed and authenticated with `gh auth login`.
- Pi running inside the repository that owns the PR.

## Install

```bash
# User scope
pi install npm:pi-pr-review

# Project scope
pi install -l npm:pi-pr-review
```

For local development, replace the package name with a checkout path such as `./pi-pr-review`.

## Quick start

Configure the reviewer models:

```text
/pr-review-config light=<fast-model> medium=<balanced-model> heavy=<strong-model>
/pr-review-config light_thinking=low medium_thinking=medium heavy_thinking=high
```

Then review a PR in the current repository:

```text
/pr-review 123
```

The semantic result is predictable human-readable Markdown in every mode. GitHub request JSON is generated only by host code and is never a model output contract.

## Review modes

| Command | Behavior |
|---|---|
| `/pr-review 123` | Balanced default: all validated P0–P2 findings plus up to three direct-diff P3/nits. |
| `/pr-review 123 --major-only` | P0–P2 only. |
| `/pr-review 123 --full` | Adds convention/maintainability review and reports all qualifying severities. |
| `/pr-review 123 --balanced` | Explicit alias for the default mode. |
| `/pr-review 123 --deep` | One integrated heavy reviewer for the whole PR instead of five parallel lenses. |
| `/pr-review 123 --include-closed` | Reviews a closed or merged PR without asking first. |

`--full`, `--major-only`, `--balanced`, and `--deep` are mutually exclusive.

`--deep` trades parallel lens coverage for holistic judgment: a single heavy-tier pass receives the complete diff plus the repository tools and reviews the change as one story — intent, approach, cross-file behavior, and test fit — reporting nit-through-P0 findings with source-grounded validation. The orchestrator still synthesizes the terminal Markdown and owns verification handling. It runs under the same per-attempt heavy deadline as any heavy lane, plus the same lane-artifact, degradation, extraction, and publication machinery, so a deep review that degrades publishes with the same honest coverage disclosure. Note the budget trade: one pass doing the combined work has the same attempt window each concurrent lens had, so on large diffs raise `attemptMs.heavy` if deep runs time out. For ordinary diffs this is usually the higher-quality path; the default five-lane fan-out remains better for very large or sharded diffs where bounded parallel context beats a single long pass. Without `--include-closed` or `--review-closed`, Pi asks before reviewing a non-open PR.

A review uses five focused passes by default:

1. overview and minor hygiene (`light`);
2. state, lifecycle, and concurrency correctness (`heavy`);
3. contracts, data, and integration correctness (`heavy`);
4. security (`heavy`);
5. performance and resource ownership (`heavy`).

`--full` adds a convention and maintainability pass (`medium`). Large multi-file diffs are split by whole-file boundaries and reviewed in parallel. If the extension is unavailable, the prompt falls back to the current Pi session model.

## Focus running reviewers

While a review is running in the interactive TUI, open the live read-only subagent view with:

```text
/pr-review-focus
```

`Ctrl+Alt+R` opens the same view without entering a command. The viewer keeps the parent review running and does not switch Pi sessions or attach an interactive terminal to a child process.

Viewer controls:

| Key | Action |
|---|---|
| `Tab` / `Right` | Focus the next pass. |
| `Shift+Tab` / `Left` | Focus the previous pass. |
| `Up` / `Down` | Scroll one line. |
| `PageUp` / `PageDown` | Scroll one page. |
| `Home` / `End` | Jump to the start or resume following live output. |
| `Esc` | Return to the main thread without cancelling the review. |

The view shows pass status, attempt/model, tool names and completion state, and bounded assistant output. It never stores the pass objective, input context, captured diff, raw child events, tool arguments, tool results, or stderr. Assistant text is sanitized and capped at 48 KiB per pass and 256 KiB across the active review; older text is evicted with an on-screen marker.

The bounded viewer is a projection, not the authoritative lane result. Separately, the host retains an invocation-scoped artifact for each lane with its exact final assistant text, lifecycle (`complete`, `partial`, `timed_out`, or `failed`), requested/observed model, process outcome, attempt/fallback history, scheduling offsets, timing, and tool-use counts. Both stores exist only in memory for the active session/cwd-bound `/pr-review` generation and are synchronously purged on completion, cancellation, replacement, or session/tree lifecycle changes.

The viewer intentionally cannot send prompts, steering, or follow-ups to reviewers. It is unavailable in print, JSON, and RPC modes and outside an active user-initiated `/pr-review` loop.

## Configure models

`/pr-review-config` opens an interactive settings menu in the TUI. Use `/pr-review-config show` for a text summary or `key=value` arguments for direct changes.

| Tier | Purpose |
|---|---|
| `light` | Fast overview and risk scan. |
| `medium` | Convention and maintainability review in `--full` mode. |
| `heavy` | Correctness, security, and performance review. |

Common settings:

```text
/pr-review-config light=provider/model heavy=provider/model:high
/pr-review-config heavy_fallbacks=provider/backup:high,provider/backup2
/pr-review-config light_thinking=low medium_thinking=medium heavy_thinking=high
/pr-review-config heavy_tool_policy=configured
/pr-review-config tools=read,bash,grep,find,ls
/pr-review-config auto_post_reviews=true
/pr-review-config allow_stale_publish=false
/pr-review-config allow_stale_approvals=true
/pr-review-config approve_max_priority_level=P2
/pr-review-config medium=unset
```

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A thinking suffix in a model spec, such as `provider/model:xhigh`, takes precedence over the tier's thinking setting. `unset` restores inherited behavior.

Tool policy can be `none` or `configured`. `configured` uses the `tools` allowlist; because an allowlist containing `bash` is not technically read-only, remove it if you need stricter reviewer isolation. Reviewer subprocesses disable extension discovery, strip the package's review-tool names from this allowlist, and use `--no-tools` when no allowed tools remain.

Configuration is stored in:

- user scope: `~/.pi/agent/pr-review.json`;
- project scope: `<repo>/.pi/pr-review.json`, applied only when the project is trusted.

A trusted project can override model, tool, and publication settings. Verification profiles are always user-only.

Example:

```json
{
  "tiers": {
    "light": "provider/fast-model",
    "medium": "provider/balanced-model",
    "heavy": "provider/strong-model:high"
  },
  "fallbacks": {
    "heavy": ["provider/backup-model:high"]
  },
  "thinkingLevels": {
    "light": "low",
    "medium": "medium",
    "heavy": "high"
  },
  "toolPolicies": {
    "light": "none",
    "medium": "configured",
    "heavy": "configured"
  },
  "tools": ["read", "bash", "grep", "find", "ls"],
  "deadlines": {
    "attemptMs": { "light": 180000, "medium": 360000, "heavy": 480000 },
    "fallbackAttemptMs": 180000,
    "batchMs": 720000,
    "synthesisMs": 60000,
    "totalMs": 900000,
    "terminationGraceMs": 5000,
    "cleanupReserveMs": 5000,
    "minimumFallbackMs": 30000
  },
  "autoPostReviews": false,
  "allowStalePublish": true,
  "allowStaleApprovals": false,
  "approveMaxPriorityLevel": "off"
}
```

Every invocation has a host-owned monotonic 15-minute hard cap, including the two GitHub identity/lifecycle preflights, synthesis, termination grace, and reserved cleanup. The dependent preflight calls share the one invocation budget, so they cannot each add an independent command timeout before review timing begins. Defaults bound light/medium/heavy attempts to 3/6/8 minutes, a fallback attempt to 3 minutes, and the concurrent batch to 12 minutes. The complete `deadlines` object may be replaced at user scope or by a trusted project; partial, malformed, non-integer, out-of-range, or internally inconsistent objects are rejected as a unit and the last valid/default finite budget remains active. Supported inclusive ranges are: attempts 30–720 seconds, fallback 30–360 seconds, batch 60–840 seconds, synthesis 10–120 seconds, total 120–1200 seconds, TERM grace 0.1–15 seconds, cleanup reserve 1–30 seconds, and minimum useful fallback 10–120 seconds. Minimum fallback must not exceed its attempt cap, and batch + synthesis + termination grace + cleanup must fit inside total.

A timed-out or retryable quota/rate-limit/capacity lane may start at most one configured fallback attempt. It starts only when at least `minimumFallbackMs` plus cleanup reserve remains; the host never changes the configured model, thinking level, or tool policy to save time. If a tier is unset, its existing nearest-configured-tier/Pi-default behavior is unchanged.

On an attempt deadline the host records timeout separately from user cancellation, sends TERM to the original child, waits only `terminationGraceMs`, then sends KILL if no exit was observed and stops draining after the cleanup reserve. Partial assistant text and telemetry survive this lifecycle. The synthesis cap arms only once review work goes quiet: any turn that starts or any review tool that runs again while the cap is armed defers it, and it re-arms from the next turn end, so early review-tool turns (for example verification discovery) cannot starve later heavy lanes. Batch/total expiry stops queued work and waiting lanes; completed and partial artifacts proceed to Markdown synthesis or deterministic lane assembly, identify every incomplete lens/shard, and remain eligible for the safe body-only `COMMENT` publication path. A timed-out lane is never reported as `NO FINDINGS` or full coverage, and a lane ended by the host total or synthesis deadline is disclosed with that kind (`deadline_expired`) instead of being mistaken for its own attempt deadline expiring. Host lane artifacts are authoritative for completeness in both directions: a false assistant completion claim cannot upgrade incomplete lanes, and a paraphrased or omitted `Lane completeness` line cannot downgrade a host-complete batch away from the concise renderer.

Initial operating targets are ordinary-review p50 ≤ 6 minutes and p95 ≤ 12 minutes, and large-review p50 ≤ 10 minutes and p95 ≤ 14 minutes, with the 15-minute hard cap authoritative. Invocation telemetry starts before GitHub preflight and records configured deadline source/caps, termination grace, cleanup reserve, and active wall time; batch details record first event/output timing, lifecycle counts, configured and effective batch-truncated attempt deadlines, fallback starts/budget rejections, external total/synthesis deadline expiries per lane, and termination grace/escalation data. These are initial production targets, not a promise that every provider completes before its host deadline.

Ordinary reviewer output is reconstructed from every text part of the authoritative final assistant message in order. A zero process exit is not enough to mark a lane complete: completion also requires a terminal `stop` and the expected lane sections (or an explicitly emitted `NO FINDINGS.` where that response is allowed). Empty success is never synthesized into `NO FINDINGS.`; length-limited, malformed, timed-out, and failed attempts retain their raw text with an explicit lifecycle. Batch details include raw text, attempt artifacts, lifecycle counts and elapsed totals, while the displayed batch remains in deterministic input order.

## One-shot self-review for top-level tasks

For an eligible long-running coding task started by direct interactive or RPC input, Pi exposes `self_review_subagent` near the end of the task. The tool takes no arguments. Its empty schema is closed with `additionalProperties: false`; the extension—not the caller—fixes the objective, heavy tier, P0–P2-only severity policy, no-minor-hygiene policy, and no-tools isolation.

The permit is bound to one top-level task generation, the Pi session instance, cwd, and canonical Git worktree. Dispatch is additionally bound to the tool-call ID from an assistant `message_end` containing exactly one tool call, `self_review_subagent`; mixed, multiple, or direct unbound dispatches are denied without consuming the reusable task permit. A bound permit is consumed atomically before delta capture, so concurrent or replayed calls are rejected and the tool is hidden immediately. It is never available during `/pr-review`. Low-level `agent_end` events do not revoke it because Pi may still retry, compact, or run queued continuations; unused authority is cleared only at terminal `agent_settled` (or earlier cancellation/session/input boundaries).

The child uses Pi RPC mode with a bounded ten-minute total runtime. Before startup, the host creates a mode-`0700` temporary `PI_CODING_AGENT_DIR`, copies and normalizes the trusted user settings there with retry and compaction disabled, and exposes only validated regular `auth.json`/`models.json` files through controlled symlinks. The same private directory—not the mutable worktree—is the child process cwd, and inherited runtime preload flags (`NODE_OPTIONS` and `BUN_OPTIONS`) are removed. RPC control acknowledgements can therefore persist only to temporary settings. The host attempts synchronous recursive removal after every supervised outcome; unsafe source configuration or cleanup failure fails the call closed. Environment-based authentication otherwise remains inherited, and no credentials are placed in arguments or prompts. The host waits for acknowledgements that automatic compaction and automatic retry are disabled before it submits the sole prompt, and it also aborts on timeout, bounded stdout/stderr overflow, any retry/compaction lifecycle event, or a second `agent_start`. There is no fallback, sharding, extension discovery, tools, publication, or verification behavior.

Self-review is deliberately fail-closed. At extension startup, the host resolves one canonical executable Git from that startup `PATH`; the same absolute executable is bound through clean-baseline capture, permit validation, and delta capture, so later `PATH` changes cannot select repository-controlled Git. The worktree must be clean when the top-level task starts and HEAD must remain unchanged. Baseline capture receives its abort signal immediately, so new input, cancellation, or session/tree navigation can stop even the initial Git inspection. At execution, the host builds a complete bounded diff of Git-visible tracked, staged, and non-ignored untracked changes relative to that starting HEAD. It rejects an empty delta, any changed or dirty submodule, more than 200 status records, more than 4 MiB of diff, a changed session/cwd/worktree/HEAD, or a status change during capture.

The child must return strict JSON containing only a `findings` array. Every finding must pass an exact host-owned schema: P0/P1/P2 severity and matching title/blocking state, concrete impact/trigger/evidence strings, normalized repo-relative changed-line coordinates, side, task/diff relationship flags, and bounded confidence. The host derives changed-line anchors from the captured unified diff and requires each claimed range to lie completely within one changed-line run in one hunk on the exact claimed path and side; binary and no-hunk paths have no valid anchors. Markdown, malformed JSON, extra or missing fields, P3/nits, inconsistent metadata, out-of-delta anchors, and unsafe paths are rejected rather than shown as review results. No findings is `{"findings":[]}`.

This is a practical Git-derived boundary, not a filesystem snapshot or sandbox. Ignored files are not included, and an external process that rewrites ordinary file contents without changing status shape could race capture. Requiring a clean start, rejecting submodule deltas, checking HEAD and status before/after capture, incrementally bounding all output, and failing closed avoids silently presenting a partial oversized delta. The RPC leader starts in a detached POSIX process group; on failure, abort, timeout, or retained descendants, the host sends group TERM then KILL, destroys inherited pipes, and stops waiting after a bounded drain deadline. A descendant that deliberately creates a different process group/session can escape those signals, although it cannot force the host to retain the supervised pipes indefinitely. Use a separate sandbox or snapshot system when stronger filesystem, process, or network isolation is required.

## Publish to GitHub

Publishing is off by default.

```text
/pr-review 123 --comment       # publish this run
/pr-review 123 --no-comment    # never publish this run
/pr-review-config auto_post_reviews=true
```

The extension owns normal publishing. Before review execution it captures repository, hostname, PR number/title, reviewed head, lifecycle state, posting/stale authority, and invocation identity independently of assistant text. After synthesis, it caches one validated completed review (the host-owned canonical artifact) per repository and PR in the current Pi session. `autoPostReviews` and `--comment` publish that cached review after completion; `--no-comment` suppresses publication for the run.

Review semantics are Markdown-first. A deterministic tolerant parser normalizes line endings, extracts complete findings when possible, and ignores heading-like text inside CommonMark fenced-code and HTML-block contexts. Every degraded synthesis — ambiguous, partially parsed, incomplete lane coverage, or absent terminal synthesis — publishes one deterministic host-rendered `COMMENT` body with generic code-review labels: a `Coverage` section with the exact lane lifecycle disclosure, a `Findings` section with host-formatted parsed findings (never a clean-review claim when nothing parsed), and the complete original synthesis plus every retained lane artifact preserved verbatim under `Retained synthesis` / `Retained lane output` with heading levels shifted so they nest. A contradictory completion claim inside retained text is reconciled to the host verdict. Reserved markers are sanitized, size limits are enforced, and the canonical marker is appended only by host code. Optional formatting repair is never required and can never suppress the degraded fallback.

You can publish the cache later with `/pr-review-publish 123`, or directly ask the agent to “post the inline review,” “post it as an inline review,” or “publish the review for PR #123.” The extension handles that request directly before an agent turn. `/pr-review-publish` and a matching direct request publish only the cache; they never start or rerun review agents. Unnumbered direct requests select the latest cached review for the current repository. Only fresh interactive/RPC input can use the direct path.

Every authorized publish path builds one GitHub review payload and sends at most one review `POST`; it never submits `REQUEST_CHANGES` or retries a rejected write with a fallback POST. Fully parsed Markdown with one complete retained artifact for every host-registered dispatch may emit a gated `APPROVE` through the same host binding, priority, lifecycle, self-author, and stale checks as strict JSON. Host lane evidence is authoritative for completeness: a paraphrased or omitted `All requested lanes completed.` disclosure cannot downgrade a host-complete batch, and a false disclosure cannot upgrade incomplete or missing lane coverage; the assistant's canonical line is consulted only when no batch evidence exists. Verdict fields outside the document preamble, hidden in CommonMark code/HTML blocks, or inside lazy container continuations, severity-tagged headings outside `Findings`, incomplete or missing host lane coverage, malformed or unsafe output, and lane-fallback artifacts remain `COMMENT` reviews; their safely parsed findings keep inline placement, while unparsable output publishes body-only. Cache restore reclassifies persisted lane output and requires the exact host-recorded artifact key set, with every complete artifact matching the frozen invocation generation, tier, and minor-hygiene contract, and re-synthesizes the retained raw text under that frozen binding before retaining approval eligibility. For a current, open PR, the first 50 eligible P0–P3 findings with valid, unique diff anchors are inline. The concise top-level body starts with the verdict, points readers to inline findings, and places nits, off-diff findings, unavailable diff metadata, duplicate anchors, and overflow under `Other Notes`; overview, verification, strengths, and transport diagnostics stay out of the public summary. The complete original Markdown remains retained internally; if the concise body plus its canonical marker exceeds GitHub's limit, the host uses its sanitized, size-bounded Markdown projection instead of dropping the review. Stale or authorized non-open reviews are body-only. A stale approval additionally requires `allowStaleApprovals: true`.

All publication paths apply host-enforced safety gates: captured posting authority, repository and requested-PR binding, reviewed/current-head and stale policy, bounded bodies and payloads, draft and lifecycle checks, non-open authorization, authenticated-identity same-head duplicate detection, and a final head check. Fully or partially parsed review paths additionally enforce safe inline locations, including degraded incomplete-lane reviews whose findings still parse. Raw and lane-assembled fallbacks without parsed findings are body-only; every degraded path is `COMMENT`-only, and assistant text cannot select event, commit, repository, hostname, API path, or inline anchors. Unknown or invalid host states fail closed before a write.

Stale publication is enabled by default through `allowStalePublish: true`; disable it with `/pr-review-config allow_stale_publish=false`. Automatic posting and `/pr-review-publish` use the setting captured when the review starts unless the command supplies the explicit override:

```text
/pr-review-publish 123 --allow-stale
```

A matching direct request permits stale publication. Inline comments are always disabled for stale reviews because the original anchors may no longer be valid; the body identifies both the reviewed and current commit. For a qualified fully parsed review, set trusted `allowStaleApprovals: true` before starting the review to permit an eligible stale `APPROVE`; authorized non-open publications may also approve when every host gate qualifies them. Degraded Markdown remains `COMMENT` in every lifecycle state. The session-backed cache survives extension reloads and session resumes and remains bound to the originating session instance and repository.

## Optional finding extraction (experimental)

Degraded reviews — incomplete lanes, malformed synthesis — publish a deterministic host-rendered body whose findings were only what the deterministic parser could extract. An experimental opt-in adds one bounded light-tier model call that extracts findings from the review Markdown (including prose the parser cannot read) and merges them after host validation:

```json
{ "extractFindings": true }
```

Set it in **user scope only** (`~/.pi/agent/pr-review.json`); project configuration cannot enable it. Every extracted finding must carry a verbatim quote from the input verified by the host, its claimed path must appear in the input, anchors are re-validated against diff metadata at publication, and extracted severity is display-only — it can never change the verdict line or make a degraded review approve-eligible. Any failure (timeout, malformed output, unverifiable quotes) keeps the deterministic artifact unchanged. **Enabling it sends a bounded extraction payload — the review synthesis plus retained heavy-lane evidence gathered from repository context, byte-capped at 256 KiB — to the configured light-tier provider (or the ambient default model when no light tier is configured; the effective model is recorded in each `pr-review-extraction` entry)**, which may differ from the provider configured for your heavy lanes.

Outcomes are recorded in session `pr-review-extraction` entries for the Phase 2 evaluation described in [docs/review-quality-plan.md](docs/review-quality-plan.md).

Development notes (v2 telemetry semantics, default remains **off**): the extraction child now starts only when the invocation actually retained host review-lane evidence for the active generation and the assembled degraded Markdown input is nonempty — absent-synthesis sessions and same-head skip notices are never sent to the provider and are recorded as excluded `not_run` events (`no_lane_evidence`/`empty_input`) that do not count as attempts. Every eligible current terminal record carries `schemaVersion`, `attemptId`, `inputBytes`, and `elapsedMs`, plus `effectiveModel` where emitted; `merged`, `empty`, counts-bearing `rejected`, and `published` records additionally carry complete counts including the mandatory `provenanceChecked` denominator (exactly accepted + rejected) with aggregate reason counters (`sourceQuoteAbsent`, `locationQuoteAbsent`, `locationQuotePathMismatch`) that partition the rejects exactly — counts only, never payload text — while bare parse-rejection `rejected` records and `failed`/`timeout`/`aborted` carry no counts or reasons. A schema-valid `{"findings":[]}` answer on eligible evidence counts as extractor **execution** success only (it still never claims the review is clean); child failures and provenance-rejected records remain failures. The 18-run campaign against 1.15.7 proved the pre-v2 outcome denominator mixed incompatible semantics, so the default-on decision still requires a fresh homogeneous `schemaVersion: 2` cohort of at least 15 eligible real extraction attempts; the development tally evaluates only that cohort and prints legacy history separately.

## Optional verification

You can define fixed test commands in `verificationBaselines` in the **user** config. Project config cannot add or override these profiles. The reviewer may select at most one applicable profile and runs it against the exact captured PR head.

```json
{
  "verificationBaselines": {
    "unit": {
      "description": "Run the unit tests",
      "repository": {
        "host": "github.com",
        "owner": "YOUR-ORG",
        "repo": "YOUR-REPO"
      },
      "argv": ["/absolute/canonical/path/to/bun", "test"],
      "platforms": ["darwin", "linux"],
      "totalTimeoutMs": 120000,
      "allowForks": false,
      "acknowledgeUnsandboxedPrCodeRisk": true
    }
  }
}
```

Profiles require an exact repository identity, a canonical absolute executable, an applicable POSIX platform, a total timeout, and explicit risk acknowledgement. Fork PRs are rejected unless `allowForks` is `true`; Windows fails closed.

> **Risk:** verification executes PR code without a filesystem or network sandbox. Cleanup supervises the original POSIX process group, but deliberately detached processes can escape it. Use an external sandbox or container for untrusted PRs.

Verification fetches into extension-owned temporary Git state, checks the exact SHA before and after importing it, runs in a detached worktree with a minimal secret-scrubbed environment, and leaves the user's checkout and `FETCH_HEAD` unchanged.

## Review output

Each finding includes:

- severity: `P0`, `P1`, `P2`, `P3`, or `nit`;
- whether it blocks the verdict;
- an explanation and confidence score;
- a diff-anchored file and line range when available.

| Severity | Meaning |
|---|---|
| `P0` | Drop everything; blocking. |
| `P1` | Urgent; blocking. |
| `P2` | Normal defect. |
| `P3` | Low-priority improvement. |
| `nit` | Trivial or optional. |

The semantic verdict is `request_changes` only when a validated P0 or P1 finding exists. Otherwise it is `approve` or `comment`. `approveMaxPriorityLevel` applies equally to fully parsed, complete Markdown and retained strict host-bound JSON: when set to `P2`, `P3`, or `nit`, an otherwise-qualified review whose verdict is `approve` and whose findings are all at or below that level may publish as `APPROVE`. GitHub does not permit authors to approve their own PRs, degraded artifacts cannot approve, and a stale approval additionally requires `allowStaleApprovals: true`.

| Setting | Behavior |
|---|---|
| `off` (default) | Always `COMMENT`; never auto-approve. |
| `P2` | `APPROVE` if a fully parsed, complete verdict is `approve` and all findings are P2/P3/nit. |
| `P3` | `APPROVE` if a fully parsed, complete verdict is `approve` and all findings are P3/nit. |
| `nit` | `APPROVE` if a fully parsed, complete verdict is `approve` and all findings are nits. |

Configure it with `/pr-review-config approve_max_priority_level=P2`. To permit an eligible stale review to approve, also set `/pr-review-config allow_stale_approvals=true` before starting the review. Both settings follow the same user/project overlay pattern as `autoPostReviews`.

## Safety and cost

- `review_subagent`, `review_subagents`, and `pr_review_verify` are exposed only during a direct interactive or RPC `/pr-review` loop. Extension-generated input cannot authorize them.
- Every review tool also checks an in-memory, session- and cwd-bound loop lease before reading review context, running verification, or spawning a reviewer. Hiding the tools is not the only enforcement boundary.
- Unrelated input, terminal completion, cancellation, session navigation, or tree navigation revokes the lease and aborts in-flight review work. Tools are suspended while a non-open PR waits for confirmation.
- Reviewer subprocesses start with extension discovery disabled, so they cannot recursively invoke this package's agents or verification tool.
- `self_review_subagent` has separate one-shot authority for an eligible direct top-level task; it cannot authorize `review_subagent`, `review_subagents`, or `pr_review_verify`, and those permissive schemas remain exclusively behind `ReviewLoopCoordinator`.
- Self-review execute-time checks are authoritative: visibility alone never grants a permit, and consumption hides the tool before any asynchronous delta or child work.
- Reviewers receive the captured diff and are instructed not to modify files.
- The orchestrator does not check out, commit, or push PR code.
- GitHub writes require `--comment`, an effective `autoPostReviews: true` setting, the model-free `/pr-review-publish` command, or a narrowly matched direct interactive/RPC publish request handled by the extension before an agent turn. `allowStalePublish` controls whether an invocation/config-authorized write may be stale; it does not independently authorize a write.
- Publication authority is captured before review or optional verification begins, so PR code cannot enable it mid-run.
- Multiple model calls run per PR. Use a cheaper `light` model and reserve stronger models for `heavy` passes to control cost.
- Same-head review markers prevent duplicate publication by the same GitHub identity.

## Development

Run the test suite with:

```bash
bun test
npm run test:tooling
```

Review-topology changes must also use the versioned seeded semantic benchmark. Its deterministic planner and scorer report P0/P1, P2, per-lens, and cross-file recall alongside clean-control false positives, duplicates, lane completeness, fallback rates, variance, and p50/p95 latency. They never invoke models, GitHub, or publication themselves; the separately acknowledged collector runs real provider reviews against local fixture repositories through a read-only GitHub shim. See [docs/semantic-review-benchmark.md](docs/semantic-review-benchmark.md) for corpus, collector, and immutable result-bundle contracts, and [docs/semantic-benchmark-baseline-v5.md](docs/semantic-benchmark-baseline-v5.md) for the preserved but gate-ineligible v5 diagnostic history. Fresh topology evidence uses corpus v6.

The package consists of the `/pr-review` prompt, tiered subagent and rendering extensions, and supporting libraries under `lib/`. To use only the prompt template:

```bash
cp prompts/pr-review.md ~/.pi/agent/prompts/
```

Releases use conventional squash-merged PR titles and npm trusted publishing. See [RELEASING.md](RELEASING.md).
