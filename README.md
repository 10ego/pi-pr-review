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
  "autoPostReviews": false
}
```

Tier subprocesses retry configured fallbacks only for retryable quota, rate-limit, or capacity failures. If a tier is unset, it uses the nearest configured tier and then Pi's default model.

## Publish to GitHub

Publishing is off by default.

```text
/pr-review 123 --comment       # publish this run
/pr-review 123 --no-comment    # never publish this run
/pr-review-config auto_post_reviews=true
```

The extension—not the model—owns publishing. It creates one formal review with the event hardcoded to `COMMENT`; it never submits `APPROVE` or `REQUEST_CHANGES`. Before writing, it verifies the current PR head, validates inline anchors, and checks for a review of the same head by the current GitHub identity.

Closed or merged PRs use a body-only review. Open PRs attach eligible P0–P3 findings as inline comments and keep nits or off-diff findings in the review body.

If a new commit makes a completed review stale, publish the cached result without rerunning the model:

```text
/pr-review-publish 123 --allow-stale
```

Inline comments are intentionally disabled for stale reviews because the original anchors may no longer be valid. The stale review is body-only and identifies both the reviewed and current SHAs. The cache is stored in the current Pi session, survives extension reloads and session resumes, and is bound to that session instance's ID and creation metadata as well as the repository.

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

The verdict is `request_changes` only when a validated P0 or P1 finding exists. Otherwise it is `approve` or `comment`. The displayed verdict is advisory even when the review is published, because publication always uses the GitHub `COMMENT` event.

## Safety and cost

- `review_subagent`, `review_subagents`, and `pr_review_verify` are exposed only during a direct interactive or RPC `/pr-review` loop. Extension-generated input cannot authorize them.
- Every review tool also checks an in-memory, session- and cwd-bound loop lease before reading review context, running verification, or spawning a reviewer. Hiding the tools is not the only enforcement boundary.
- Unrelated input, terminal completion, cancellation, session navigation, or tree navigation revokes the lease and aborts in-flight review work. Tools are suspended while a non-open PR waits for confirmation.
- Reviewer subprocesses start with extension discovery disabled, so they cannot recursively invoke this package's agents or verification tool.
- Reviewers receive the captured diff and are instructed not to modify files.
- The orchestrator does not check out, commit, or push PR code.
- GitHub writes require `--comment` or an effective `autoPostReviews: true` setting.
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
