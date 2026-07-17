# pi-pr-review

Parallel, model-agnostic AI code review for GitHub pull requests in the [Pi coding agent](https://pi.dev).

Give it a PR number and it will:

- fetch the PR metadata and diff with `gh`;
- run focused review passes in parallel using models you choose;
- validate candidate findings before reporting them;
- render a structured review with severity, location, confidence, and verdict;
- optionally publish one safe GitHub `COMMENT` review with inline comments.

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

In the TUI, the result is rendered as a readable review. In `print`, `json`, and `rpc` modes, Pi returns the raw JSON payload.

## Review modes

| Command | Behavior |
|---|---|
| `/pr-review 123` | Balanced default: all validated P0–P2 findings plus up to three direct-diff P3/nits. |
| `/pr-review 123 --major-only` | P0–P2 only. |
| `/pr-review 123 --full` | Adds convention/maintainability review and reports all qualifying severities. |
| `/pr-review 123 --balanced` | Explicit alias for the default mode. |
| `/pr-review 123 --include-closed` | Reviews a closed or merged PR without asking first. |

`--full`, `--major-only`, and `--balanced` are mutually exclusive. Without `--include-closed` or `--review-closed`, Pi asks before reviewing a non-open PR.

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

The view shows pass status, attempt/model, tool names and completion state, and bounded assistant output. It never stores the pass objective, input context, captured diff, raw child events, tool arguments, tool results, or stderr. Assistant text is sanitized and capped at 48 KiB per pass and 256 KiB across the active review; older text is evicted with an on-screen marker. State exists only in memory for the active session/cwd-bound `/pr-review` generation and is synchronously purged on completion, cancellation, replacement, or session/tree lifecycle changes.

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
  "autoPostReviews": false,
  "allowStalePublish": true,
  "approveMaxPriorityLevel": "off"
}
```

Tier subprocesses retry configured fallbacks only for retryable quota, rate-limit, or capacity failures. If a tier is unset, it uses the nearest configured tier and then Pi's default model.

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

The extension—not the model—owns publishing. After a successful review, it caches one validated completed review per repository and PR in the current Pi session. `autoPostReviews` and `--comment` publish that cached review after completion; `--no-comment` suppresses publication for the run.

If the agent's final review is not valid exact-contract JSON, the extension logs the reason and automatically asks the same agent to correct its completed output once, with tools disabled and the original posting authority unchanged. An invalid correction, a tool call, or overlapping input stops publication rather than starting another correction loop.

You can publish the cache later with `/pr-review-publish 123`, or directly ask the agent to “post the inline review,” “post it as an inline review,” or “publish the review for PR #123.” The extension handles that request directly before an agent turn. `/pr-review-publish` and a matching direct request publish only the cache; they never start or rerun review agents. Unnumbered direct requests select the latest cached review for the current repository. Only fresh interactive/RPC input can use the direct path.

Every authorized publish path builds one `COMMENT` payload and sends at most one GitHub review `POST`; it never submits `APPROVE` or `REQUEST_CHANGES` and never retries a rejected write with a fallback POST. For a current, open PR, the first 50 eligible P0–P3 findings with valid, unique diff anchors are inline. All other findings that pass content validation stay in the top-level review body, including nits, off-diff findings, unavailable diff metadata, duplicate anchors, and overflow. Stale or authorized non-open reviews are body-only.

The same safety gates apply to every path: captured posting authority, exact repository/PR/review binding, safe locations, no reserved review markers, bounded bodies and payloads, current-head and stale policy, draft and lifecycle checks, non-open authorization, same-head duplicate detection, and a final head check. Unknown or invalid states fail closed before a write.

Stale publication is enabled by default through `allowStalePublish: true`; disable it with `/pr-review-config allow_stale_publish=false`. Automatic posting and `/pr-review-publish` use the setting captured when the review starts unless the command supplies the explicit override:

```text
/pr-review-publish 123 --allow-stale
```

A matching direct request permits stale publication. Inline comments are always disabled for stale reviews because the original anchors may no longer be valid; the body identifies both the reviewed and current commit. The session-backed cache survives extension reloads and session resumes and remains bound to the originating session instance and repository.

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

The verdict is `request_changes` only when a validated P0 or P1 finding exists. Otherwise it is `approve` or `comment`. By default, publication uses the GitHub `COMMENT` event. When `approveMaxPriorityLevel` is set to a severity level (e.g. `P2`), a review whose verdict is `approve` and whose findings are all at or below that level is published as a GitHub `APPROVE` event instead.

| Setting | Behavior |
|---|---|
| `off` (default) | Always `COMMENT`; never auto-approve. |
| `P2` | `APPROVE` if verdict is `approve` and all findings are P2/P3/nit. |
| `P3` | `APPROVE` if verdict is `approve` and all findings are P3/nit. |
| `nit` | `APPROVE` only if verdict is `approve` and all findings are nits. |

Configure it with `/pr-review-config approve_max_priority_level=P2`. The setting follows the same user/project overlay pattern as `autoPostReviews`.

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
```

The package consists of the `/pr-review` prompt, tiered subagent and rendering extensions, and supporting libraries under `lib/`. To use only the prompt template:

```bash
cp prompts/pr-review.md ~/.pi/agent/prompts/
```

Releases use conventional squash-merged PR titles and npm trusted publishing. See [RELEASING.md](RELEASING.md).
