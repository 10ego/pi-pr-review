# pi-pr-review

A model-agnostic GitHub pull-request review prompt for [pi](https://pi.dev).

Pass a PR number and pi will:

1. Resolve the PR in the **current directory's git repo** via `gh`.
2. Derive the **base branch** and **head (merging) branch** automatically from the PR.
3. Review the base↔head diff with disciplined passes (overview, convention compliance, bugs, security/perf, readability), optional trusted user-level named baseline verification, then validate each candidate.
4. Return a **full structured review**: overview, strengths, verification, findings at **every** severity (`nit → P3 → P2 → P1 → P0`) with a blocking flag, correctness/security/performance notes, and a verdict.
5. Optionally publish one formal GitHub `COMMENT` review with a top-level body and associated inline comments.

**Captures everything, then ranks it.** Unlike a high-signal-only reviewer, it does not discard minor issues — nits, style, naming, missing edge cases, and "worth confirming" observations are all reported as low-severity findings. The **verdict** depends only on *blocking* (P0/P1) findings, so a clean PR is still approved while its nits are still recorded.

No model name is hardcoded anywhere. The package ships an extension that adds **tiered review subagents** — `light` / `medium` / `heavy` — that you map to whatever models you like. Independent review passes fan out through a batch tool so overview, conventions/maintainability, correctness, and security/performance can run in parallel. If the extension isn't loaded, the same prompt runs every pass inline on your current session model, so it always works.

## Requirements

- [`gh`](https://cli.github.com/) installed and authenticated (`gh auth login`).
- Run pi from inside the git repository that hosts the PR (so `gh` auto-detects the repo).

## Install

Install straight from the public repo (user scope):

```bash
pi install git:github.com/10ego/pi-pr-review
```

Or project scope (shareable with your team, auto-installed on trust):

```bash
pi install -l git:github.com/10ego/pi-pr-review
```

You can also install from a local checkout by pointing at the package directory, e.g. `pi install ./pi-pr-review` (add `-l` for project scope).

### Alternative: use the template without packaging

The prompt is a plain template — just copy it into a prompts directory pi already scans:

```bash
# global (all projects)
cp prompts/pr-review.md ~/.pi/agent/prompts/
# or per-project
mkdir -p .pi/prompts && cp prompts/pr-review.md .pi/prompts/
```

## Configure the review models

Model selection is configuration, not code. There are two layers:

### 1. Tiered subagent models (recommended)

The `/pr-review-config` command maps three labels to models:

| Tier | Used for | Pick a model that is… |
|------|----------|----------------------|
| `light`  | overview / strengths / high-level risk scan | fast + cheap |
| `medium` | convention compliance + readability / maintainability | balanced |
| `heavy`  | bug + security/logic review | strongest |

```
/pr-review-config                                   # open the settings menu (like /settings & /nervous:config)
/pr-review-config show                              # print the current mapping
/pr-review-config light=<spec> medium=<spec> heavy=<spec>   # set primary tier models
/pr-review-config heavy_fallbacks=<spec>,<spec>     # retry chain for quota/rate-limit failures
/pr-review-config light_thinking=low medium_thinking=medium heavy_thinking=high
/pr-review-config light_tool_policy=none            # tier default when a pass omits tool_policy
/pr-review-config auto_post_reviews=true            # opt in to automatic GitHub COMMENT reviews
/pr-review-config auto_post_reviews=false           # disable automatic posting (the default)
/pr-review-config medium=unset                      # clear a tier (back to pi default)
/pr-review-config heavy_fallbacks=unset             # clear a fallback chain
/pr-review-config light_thinking=unset              # inherit the ambient pi default
/pr-review-config light_tool_policy=unset           # restore legacy configured-tool behavior
/pr-review-config tools=read,bash,grep,find,ls      # allowlist used by configured policy
```

Running `/pr-review-config` with no arguments in the TUI opens an interactive settings menu that mirrors pi's `/settings` and the NERVous `/nervous:config`:

- One primary-model, fallback-model, thinking-level, and tool-policy row per tier (`light` / `medium` / `heavy`), an automatic-posting toggle, plus a configured-tool allowlist row.
- Press Enter on a primary or fallback row to pick a model from a searchable list (or unset it); Enter/Space cycles thinking levels, tool policies, and allowlist presets. The menu sets one fallback model at a time; use the `key=value` form for longer fallback chains.
- Selections apply and persist **immediately**; Esc closes the menu.
- Type to search, and tab-completion is available for the `key=value` form.

Outside the TUI (or with `show`), the command posts a Markdown summary table of your settings and the effective values instead.

A `<spec>` is any pi model pattern, e.g. `provider/model` or `provider/model:high` (with a thinking level). Each of `light_thinking`, `medium_thinking`, and `heavy_thinking` accepts every pi-supported level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`:

```
/pr-review-config light_thinking=off       # or minimal|low|medium|high|xhigh|max
/pr-review-config medium_thinking=minimal  # or off|low|medium|high|xhigh|max
/pr-review-config heavy_thinking=max       # or off|minimal|low|medium|high|xhigh
/pr-review-config light_thinking=unset medium_thinking=unset heavy_thinking=unset
```

`unset` removes the tier override, so that child pi process inherits the ambient pi default; it does not mean `off`. When an effective tier or fallback model has no supported `:thinking` suffix and its tier thinking is unset, `/pr-review-config show` and review-tool output warn that the ambient default is inherited. If a model spec does include a supported suffix, such as `<model-spec>:xhigh`, its `:thinking` suffix takes precedence over `<tier>_thinking`; output warns when it shadows an explicit tier setting. This precedence applies to primary, nearest-tier, and fallback model attempts.

A model-agnostic starting profile is:

```
/pr-review-config light_thinking=low medium_thinking=medium heavy_thinking=high
```

This is an opt-in cost/quality balance, not a speed guarantee: lower thinking can reduce reasoning work but may miss subtle risks, while higher thinking can improve depth at greater latency and token cost. Adjust against your own review results and model capabilities.

Review-model settings are stored in:

- **User:** `~/.pi/agent/pr-review.json`
- **Project:** `<repo>/.pi/pr-review.json` (overlays model/tool/publication settings only when the project is trusted)

Verification profiles are different: `verificationBaselines` is read **only** from the user file. A project-local field with that name is always ignored, including in trusted projects.

Example `pr-review.json`:

```json
{
  "tiers": {
    "light": "<fast-model-spec>",
    "medium": "<balanced-model-spec>",
    "heavy": "<strong-model-spec:high>"
  },
  "fallbacks": {
    "light": ["<backup-fast-model>"],
    "medium": ["<backup-balanced-model>"],
    "heavy": ["<backup-strong-model:high>", "<balanced-model-spec>"]
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
  "autoPostReviews": false,
  "verificationBaselines": {
    "unit": {
      "description": "Run the fixed unit-test entry point",
      "repository": { "host": "github.com", "owner": "YOUR-ORG", "repo": "YOUR-REPO" },
      "argv": ["/canonical/absolute/path/to/bun", "test"],
      "platforms": ["darwin", "linux"],
      "totalTimeoutMs": 120000,
      "allowForks": false,
      "acknowledgeUnsandboxedPrCodeRisk": true
    }
  },
  "tools": ["read", "bash", "grep", "find", "ls"]
}
```

Each tier runs in an **isolated `pi` subprocess** on its configured model. The `review_subagents` batch tool runs independent passes concurrently (default `max_parallel: 4`, capped at 6) and returns ordered per-pass results; the older single-pass `review_subagent` tool remains available as a compatibility fallback. If a tier model fails with a retryable quota/rate-limit/capacity error, the subprocess retries that tier's configured `fallbacks` in order. Non-quota failures do not blindly cycle through fallbacks. If a tier is unset, that subagent falls back to the nearest configured tier, then to your pi default model.

Thinking resolution and tool policy are independent. For thinking, a supported model-spec `:thinking` suffix wins; otherwise `thinkingLevels[tier]` is passed to the child process, and an unset tier inherits the ambient pi default. Tool policy remains additive and backward compatible: `none` emits Pi's explicit `--no-tools`; `configured` uses the existing `tools` allowlist. A tool call's optional `tool_policy` overrides `toolPolicies[tier]`, which in turn falls back to legacy `configured` behavior. The shipped `/pr-review` prompt explicitly uses `none` only for overview because its complete evidence is supplied in context. Conventions/maintainability and both heavy specialist passes use `configured` repository-context tools so they can inspect surrounding files when needed. Fallback model attempts keep the original pass policy.

### Optional trusted verification baselines

Verification is disabled when the user config has no `verificationBaselines`. The orchestrator first calls `pr_review_verify` with `action: "list"`; it may then call `action: "run"` with only `pr_number`, the exact 40-character `head_sha`, and one returned `baseline_name`. The tool schema rejects legacy model-supplied `command` and `timeout_ms` overrides.

Every profile is strict: a repository `{host, owner, repo}` identity, a nonempty fixed `argv` whose executable is an absolute canonical executable file, one or more applicable POSIX `platforms`, `totalTimeoutMs`, optional `description`, optional `allowForks` (default `false`), and `acknowledgeUnsandboxedPrCodeRisk: true`. Unknown fields invalidate the profile. Verification is disabled by default, profiles are user-file-only, and this acknowledgement must be exactly `true`; project config cannot enable or acknowledge it. Windows fails closed. Before fetching or executing PR code, the extension resolves canonical `git` and `gh` executables from the PATH captured when the extension starts and queries the profile's canonical repository for the current PR head and cross-repository status. It fails clearly if either trusted executable is unavailable. A cross-repository/fork PR is rejected unless that trusted profile explicitly sets `allowForks: true`.

The only network fetch runs in a freshly initialized extension-owned bare staging repository under the verification temporary directory. Its fetch has no system, global, or local Git config and no installed hooks. Private HTTPS setup fetches use `gh auth token --hostname <profile-host>` inside the profile's total setup deadline. The token and mode-0700 askpass helper exist only for that staging fetch; all authenticated stdout/stderr is zeroed and suppressed, every observed byte is counted as dropped, and failures return only generic trusted context. After deleting the token/helper, the extension verifies the staged ref against the exact captured SHA, imports only that already-fetched ref into the original repository over a local path with a secret-free minimal Git environment and `--no-write-fetch-head`, and verifies the imported SHA again. Original local hooks or URL rewrites may observe this secret-free local import, but never the token. `FETCH_HEAD` remains unchanged. If `gh` has no token, public repositories still get an unauthenticated HTTPS staging fetch and retain bounded diagnostics plus observed/dropped-byte accounting, including on timeout or abort; private fetch failures explicitly identify missing authentication.

`totalTimeoutMs` bounds the normal setup, command, termination, and reserved-cleanup lifecycle. A fixed 2-second emergency cleanup allowance is unconditionally available to bounded cleanup beyond that budget, so a pathological run may take up to 2 seconds longer than `totalTimeoutMs`.

**Risk disclosure:** the command executes code from the pull request without a filesystem or network sandbox. The lifecycle code supervises only the original POSIX process group; PR code can deliberately call `setsid` or otherwise create a new session and survive supervision and cleanup. This is not full process-tree containment. Use an external sandbox or container wrapper for untrusted pull requests, and configure a profile only when you explicitly accept this residual risk.

### 2. The orchestrator / inline-fallback model

The orchestrator (which fetches the PR, merges findings, and emits the JSON) and the inline fallback path both run on your pi session model:

- **Per run:** `pi --model <model-id> "/pr-review 123"`
- **Persistent default (user):** `~/.pi/agent/settings.json` → `{ "defaultModel": "<model-id>", "defaultThinkingLevel": "high" }`
- **Persistent default (project):** the same keys in `.pi/settings.json`
- **Switch mid-session:** `/model`, or `Ctrl+P` to cycle.

## Usage

Type `/` in the pi editor and pick `pr-review`, or:

```
/pr-review 123                                  # use autoPostReviews (false by default)
/pr-review 123 --comment                        # force one COMMENT review for this run
/pr-review 123 --no-comment                     # suppress posting for this run
/pr-review 123 --include-closed                 # review a closed/merged PR without a confirmation prompt
/pr-review 123 --review-closed --comment        # review and attempt a body-only COMMENT review
/pr-review-publish 123                          # publish the completed review cached in this session
/pr-review-publish 123 --allow-stale            # publish it after the PR head changed; never rerun the model
```

`123` is the PR number in the current repo.

### Closed or merged PRs

Closed/merged PRs no longer hard-skip. If you run `/pr-review 123` on a non-open PR, the prompt asks whether to continue before producing a review. Use `--include-closed` or `--review-closed` to proceed non-interactively. When publication is enabled, the extension preemptively folds inline findings into one body-only formal `COMMENT` review; if GitHub rejects it, publication fails explicitly without creating an issue comment.

### Automatic GitHub review posting

`autoPostReviews` is a strict top-level boolean and defaults to `false`. A trusted project `.pi/pr-review.json` value overlays the user value; malformed effective values never enable posting. `/pr-review-config` edits user scope only and displays the effective value/source—if a trusted project overlay wins, edit that project file or use `--no-comment` for the run. Invocation flags are captured before prompt expansion: `--comment` forces posting for one run, `--no-comment` suppresses it, and using both is rejected.

Publishing is extension-owned—the model never constructs the write request, and final JSON marked `disposition: "skipped"` is never published. It creates exactly one formal pull-request review. The top-level body contains overview/verdict information, inline-vs-summary counts, nits, and findings that cannot be posted inline; successfully attached P0–P3 findings appear only in their associated inline comments, not duplicated in the top-level body. The GitHub event is hardcoded to `COMMENT`; the publisher cannot send `APPROVE` or `REQUEST_CHANGES`, even when the review's suggested verdict is `request_changes`. It validates the current head and every inline diff anchor before the single POST, so an invalid open-PR inline comment fails without leaving a partial review. Closed/merged PRs require either `--include-closed`/`--review-closed` or the one-shot affirmative confirmation, then use one body-only `COMMENT` review with each formerly-inline finding folded into the body exactly once. Unknown or unconfirmed non-open lifecycle states fail without posting.

### Publishing a completed review after a new commit

The latest valid, reviewed final result for each repository and PR is cached before GitHub publication preflight for the current extension session. If a commit lands after review generation and the normal stale-head guard refuses to post, do **not** rerun `/pr-review` with `--comment` and do not ask the model to bypass its write policy. Use the extension-owned publish-only command:

```
/pr-review-publish 123 --allow-stale
```

This command calls no review model and reuses the completed result for PR `123`. The default `/pr-review-publish 123` still rejects a stale head; `--allow-stale` is the explicit acknowledgement. A stale review is posted as one body-only formal `COMMENT` review against the head observed during preflight, begins with a warning that shows both the reviewed and observed full SHAs, and keeps every finding in the body. Inline comments are intentionally disabled because their original diff anchors may no longer be valid. Repository binding, duplicate, draft, lifecycle, payload-size, identity, and final head-stability checks remain active. If another commit lands during the publish preflight, run the same publish-only command again to acknowledge that newer observed head.

The in-memory cache is discarded when a new pi session starts or extensions reload. `/pr-review-publish` explicitly refuses to start or rerun a review when no cached result exists, and it will not publish an older cached result while a new review of the same PR is active.

### Duplicate review handling

Published reviews include a hidden `pi-pr-review` marker with the reviewed `headRefOid`. A later run skips only when it finds a same-head marker authored by the current authenticated GitHub identity in either formal reviews or legacy issue comments. If new commits were pushed, the head SHA changes and `/pr-review` reviews the PR again. Older or unmarked content is not proof that the current head was reviewed.

### Response format

For actual review output, the assistant replies with **only** the JSON object (no prose, no fences). The only exception is the pre-review confirmation question for closed/merged PRs when `--include-closed` / `--review-closed` was not supplied.

In the **interactive TUI**, the final JSON is rendered as a full review: a `## Code Review — PR #N: <title>` header, a **Verification** line, **Overview**, **Strengths**, a **Findings** table (sorted `P0 → nit`, with a blocking column, location, and confidence) plus per-finding details, **Correctness / Security / Performance** notes, and a **Verdict**. In `print` / `json` / `rpc` modes the raw JSON is left untouched so piping and automation keep a machine-readable payload.

Example payload:

```json
{
  "pr": { "number": 33, "title": "fix(logs): parse date-time log timestamps", "head_sha": "0123456789abcdef0123456789abcdef01234567" },
  "disposition": "reviewed",
  "verification": "`go build ./...` ✅, `go test ./...` ✅ (130 passed)",
  "overview": "Migrates log timestamps from epoch-ms to RFC3339 to match the endpoint contract.",
  "strengths": ["Reuses FormatTimestamp instead of ad-hoc formatting; net -3 lines."],
  "findings": [
    {
      "title": "[P1] Guard against nil map before write",
      "severity": "P1",
      "blocking": true,
      "body": "Panics under concurrent writes; guard with a mutex.",
      "confidence_score": 0.9,
      "code_location": {
        "absolute_file_path": "pkg/store/cache.go",
        "line_range": { "start": 42, "end": 45 },
        "side": "RIGHT",
        "commentable": true
      }
    }
  ],
  "notes": { "correctness": "build confirms; no unused imports", "security": "none", "performance": "negligible" },
  "verdict": "approve",
  "overall_correctness": "patch is correct",
  "overall_explanation": "Clean, well-scoped contract-alignment change with matching tests.",
  "overall_confidence_score": 0.9
}
```

Severity tags: `[P0]` blocking/drop-everything · `[P1]` blocking/urgent · `[P2]` normal · `[P3]` low · `[nit]` trivial/optional. Verdict is `approve` (no blocking findings), `request_changes` (a blocking finding exists), or `comment`.

**Inline-comment ready.** Each finding's `code_location` is diff-anchored — repo-relative `absolute_file_path`, `line_range` on `side` (`RIGHT` for added/context lines, `LEFT` for removed), and `commentable` (whether the lines are inside a diff hunk). The rendered table shows an **Inline** ✎ column. When publishing is enabled, the extension validates these anchors against current GitHub diff metadata and attaches eligible P0–P3 findings under the single formal review; nits and off-diff observations stay in the top-level body.

## What's in the package

```
pi-pr-review/
├─ package.json                      # pi manifest: prompts + extensions
├─ prompts/pr-review.md              # the /pr-review orchestrator prompt
├─ lib/pr-review-policy.ts           # pure tool-policy resolution/argv helpers
├─ lib/pr-review-publish.ts          # safe COMMENT-review payload, validation, and gh publisher
├─ lib/pr-review-telemetry.ts        # monotonic invocation intervals and overlap-safe summaries
├─ lib/pr-review-thinking.ts         # tier thinking resolution and warnings
├─ lib/pr-review-verify.ts           # strict profiles, exact-head verification, group supervision + cleanup
├─ extensions/pr-review-subagent.ts  # review tools, named verification + /pr-review-config
├─ extensions/review-table.ts        # renders JSON and triggers trusted configured publishing
├─ tests/pr-review-policy.test.ts     # focused policy compatibility tests
├─ tests/pr-review-prompt.test.ts     # orchestrator scheduling and safety contract tests
├─ tests/pr-review-publish.test.ts    # posting gate, payload, marker, and anchor tests
├─ tests/pr-review-telemetry.test.ts  # monotonic lifecycle and overlap accounting tests
├─ tests/pr-review-thinking.test.ts   # tier thinking compatibility tests
└─ tests/pr-review-verify.test.ts     # verification success/failure/timeout/abort cleanup tests
```

## Speed, security & cost notes

### Concurrent review and verification

- The four independent review lenses remain intact. Only overview runs context-only with `--no-tools`; medium and both heavy specialists retain configured tools for surrounding-file validation. All subprocesses use `--no-context-files` because the orchestrator supplies the base review context explicitly, and convention excerpts are sent only to the medium pass instead of every model.
- After gathering PR metadata, the complete diff, and applicable conventions, the orchestrator uses `pr_review_verify` `action=list` to discover zero or more applicable **user-level** names, then selects at most one. Missing config means verification is disabled; project-local profiles are ignored. The model never supplies argv or a timeout.
- When a profile is selected, the review batch and `action=run` are emitted in the **same assistant turn**. Run accepts only `pr_number`, exact `head_sha`, and `baseline_name`. Before PR-code setup, the extension resolves canonical Git/gh from its startup PATH, uses trusted `gh` metadata to revalidate the exact head, and rejects cross-repository PRs unless `allowForks` is true.
- The sole network fetch is isolated in a fresh extension-owned bare staging repository with config and hooks absent. Authentication and askpass exist only during that staging fetch, whose output is fully suppressed and accounted. After exact staged-SHA verification, a secret-free local-path fetch imports the ref into the original repository with `--no-write-fetch-head`, followed by a second exact-SHA check. Original hooks/URL rewrites never see the token. Unauthenticated timeout/abort paths retain bounded diagnostics and byte accounting.
- The fixed argv runs without a shell/stdin, with a minimal secret-scrubbed environment and temporary HOME/cache. `totalTimeoutMs` bounds the normal setup+command+termination+reserved-cleanup lifecycle; a fixed 2-second emergency cleanup allowance is unconditionally available to bounded cleanup beyond it. Output uses a shared raw-byte cap, UTF-8/control sanitization, exact dropped-byte counts, and a final serialized cap. Timeout/abort or residual members of the original process group trigger group TERM, then unconditional group KILL after grace, followed by bounded drain. `primaryOutcome`, `terminationOutcome`, and `cleanupOutcome` remain independent.
- Verification still executes unsandboxed PR code. Supervision covers only the original POSIX process group; deliberate `setsid`/session escape can survive. Use an external sandbox/container wrapper for untrusted PRs. If no profile applies or the tool is unavailable, verification is skipped rather than replaced with prompt-owned bash.

### Performance telemetry

Review-tool results expose the effective `toolPolicy`, monotonic `elapsedMs`, per-attempt timing, and observable batch scheduling offsets. In addition, when an accepted `/pr-review` reaches a recorded terminal, cleared, or replaced boundary, it appends a durable `pr-review-telemetry` session entry with these fields:

- `schemaVersion` (currently `2`), `clock`, `prNumber`, and `completion` identify the schema, monotonic clock, PR, and terminal boundary (`terminal_response`, `cleared`, or `replaced`).
- `totalWallMs` is measured directly from accepted input to that boundary and includes any human-confirmation wait. Publication occurs afterward and is excluded.
- `activeReviewMs` is the active timeline after human-confirmation wait is removed.
- `phases.humanConfirmationWait.elapsedMs` reports time paused after the one-shot question for a non-open PR until affirmative input resumes the review or the invocation reaches its recorded completion. This wait is also removed from active interval offsets rather than attributed to model or orchestration time.
- `phases.reviewSubagentTools` and `phases.baselineVerificationTool` report interval-unioned `elapsedMs` plus observed tool intervals. Baseline timing is attributed only to `pr_review_verify` calls with `action=run`; `action=list` discovery and bash calls remain aggregate orchestration. Each interval contains `toolCallId`, `toolName`, `startOffsetMs`, `endOffsetMs`, `elapsedMs`, and `endObserved` on the active timeline.
- `phases.overlapMs` is the intersection of those two phase interval sets. `phases.observableToolWallMs` is their union, so concurrent work is not double-counted.
- `phases.aggregateOrchestration.elapsedMs` is the remaining active time. It intentionally groups metadata/context gathering, model orchestration, targeted checks, and final validation because their individual lifecycle boundaries are not directly observed; it is not a model-only timing claim.
- `notes` records these accounting boundaries in the durable entry so downstream consumers do not have to infer them.

These measurements describe observed execution and do not guarantee speed. Lower defaults, cache reordering, sharding, and further context/tool reduction remain deferred pending evidence that review quality is preserved. Restore tools for a custom pass with `tool_policy: "configured"`; omitted policy retains legacy behavior unless `toolPolicies` config says otherwise.

### Security, cost, and publishing

- The `review_subagents` batch tool and `review_subagent` fallback spawn isolated `pi` subprocesses (`--mode json -p --no-session`) on your configured tier models. Reviewer prompts prohibit modifications, but a configured allowlist containing `bash` is not technically read-only; use a narrower allowlist if stronger enforcement is required.
- Project-local model/tool/publication settings in `pr-review.json` are read only when the project is trusted; project-local `verificationBaselines` is always ignored. Because project `autoPostReviews: true` causes writes under your authenticated `gh` identity, the effective setting and source are surfaced when publication occurs.
- GitHub publication uses `gh` only, verifies the current identity and PR head, checks paginated formal reviews and legacy comments for same-head markers, and hardcodes `event: COMMENT`. Ambiguous transport failures are reconciled once and never blindly retried. The performance changes above do not alter these publishing gates or opt-in defaults.
- **`gh api -f` caution:** `gh api ... -f body=@/tmp/file.md` posts the literal text `@/tmp/file.md`; unlike `gh pr comment --body-file`, `-f` does not expand `@file`. Use a JSON payload via `gh api ... --input -` for API requests. The built-in publisher already does this.
- Tiered review calls multiple models per PR, concurrently for independent passes. Point `light` at a model suitable for overview/risk scan; reserve `heavy` for deep passes, and configure per-tier `fallbacks` only for acceptable backup models because retries can increase cost.

## Design notes

- **Process** is PR-number driven: confirm non-open PRs, skip draft/same-head-already-reviewed work, fan out four review lenses, verify, validate/classify, emit JSON, then optionally publish one extension-owned formal `COMMENT` review.
- **Captures every severity** (`nit → P0`) with a `blocking` flag; the verdict depends only on blocking findings, so nothing minor is lost but a clean PR still gets approved.
- **Verification is non-destructive to Git state:** a selected user-level named baseline runs through `pr_review_verify` in an extension-owned worktree pinned to the captured full PR SHA. Staging and local import use `--no-write-fetch-head`; cleanup reports worktree/ref/temp removal separately. The prompt never owns cleanup and never checks out, commits, or pushes in your working tree. Verification is nevertheless unsandboxed PR-code execution, so it is disabled by default and requires explicit user acknowledgement plus an external sandbox/container wrapper when the PR is untrusted.
- pi has no built-in sub-agents, so tiering is implemented as an extension that spawns isolated `pi` subprocesses per tier; the batch tool gives deterministic parallelism, and the prompt degrades gracefully to single-pass or inline review when the extension is absent.
