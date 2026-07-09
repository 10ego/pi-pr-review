# pi-pr-review

A model-agnostic GitHub pull-request review prompt for [pi](https://pi.dev).

Pass a PR number and pi will:

1. Resolve the PR in the **current directory's git repo** via `gh`.
2. Derive the **base branch** and **head (merging) branch** automatically from the PR.
3. Review the base↔head diff with disciplined passes (overview, convention compliance, bugs, security/perf, readability), best-effort build/test verification, then validate each candidate.
4. Return a **full structured review**: overview, strengths, verification, findings at **every** severity (`nit → P3 → P2 → P1 → P0`) with a blocking flag, correctness/security/performance notes, and a verdict.
5. Optionally post the review + inline PR comments (`--comment`).

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
/pr-review-config light=<spec> medium=<spec> heavy=<spec>   # set non-interactively
/pr-review-config medium=unset                      # clear a tier (back to pi default)
/pr-review-config tools=read,bash,grep,find,ls      # tools granted to each subagent
```

Running `/pr-review-config` with no arguments in the TUI opens an interactive settings menu that mirrors pi's `/settings` and the NERVous `/nervous:config`:

- One row per tier (`light` / `medium` / `heavy` model) plus a `subagent tools` row.
- Press Enter on a tier to pick a model from a searchable list (or `(unset — pi default)`); Enter/Space on `subagent tools` cycles presets.
- Selections apply and persist **immediately**; Esc closes the menu.
- Type to search, and tab-completion is available for the `key=value` form.

Outside the TUI (or with `show`), the command posts a Markdown summary table of your settings and the effective values instead.

A `<spec>` is any pi model pattern, e.g. `provider/model` or `provider/model:high` (with a thinking level). The mapping is stored in:

- **User:** `~/.pi/agent/pr-review.json`
- **Project:** `<repo>/.pi/pr-review.json` (overlays user config; only read when the project is trusted)

Example `pr-review.json`:

```json
{
  "tiers": {
    "light": "<fast-model-spec>",
    "medium": "<balanced-model-spec>",
    "heavy": "<strong-model-spec:high>"
  },
  "tools": ["read", "bash", "grep", "find", "ls"]
}
```

Each tier runs in an **isolated `pi` subprocess** on its configured model. The `review_subagents` batch tool runs independent passes concurrently (default `max_parallel: 4`, capped at 6) and returns ordered per-pass results; the older single-pass `review_subagent` tool remains available as a compatibility fallback. If a tier is unset, that subagent falls back to the nearest configured tier, then to your pi default model.

### 2. The orchestrator / fallback model

The orchestrator (which fetches the PR, merges findings, and emits the JSON) and the inline-fallback path both run on your pi session model:

- **Per run:** `pi --model <model-id> "/pr-review 123"`
- **Persistent default (user):** `~/.pi/agent/settings.json` → `{ "defaultModel": "<model-id>", "defaultThinkingLevel": "high" }`
- **Persistent default (project):** the same keys in `.pi/settings.json`
- **Switch mid-session:** `/model`, or `Ctrl+P` to cycle.

## Usage

Type `/` in the pi editor and pick `pr-review`, or:

```
/pr-review 123            # analysis only — prints the JSON report, no GitHub writes
/pr-review 123 --comment  # also posts inline review comments to the PR
```

`123` is the PR number in the current repo.

### Response format

In the **interactive TUI**, the final JSON is rendered as a full review: a `## Code Review — PR #N: <title>` header, a **Verification** line, **Overview**, **Strengths**, a **Findings** table (sorted `P0 → nit`, with a blocking column, location, and confidence) plus per-finding details, **Correctness / Security / Performance** notes, and a **Verdict**. In `print` / `json` / `rpc` modes the raw JSON is left untouched so piping and automation keep a machine-readable payload.

Under the hood the assistant replies with **only** the JSON object (no prose, no fences):

```json
{
  "pr": { "number": 33, "title": "fix(logs): parse date-time log timestamps" },
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

**Inline-comment ready.** Each finding's `code_location` is diff-anchored — repo-relative `absolute_file_path`, `line_range` on `side` (`RIGHT` for added/context lines, `LEFT` for removed), and `commentable` (whether the lines are inside a diff hunk). The rendered table shows an **Inline** ✎ column for findings that can be posted as GitHub inline review comments. With `--comment`, a summary review is posted plus inline comments (single- or multi-line, using each finding's anchor) for every commentable blocking/P2/P3 finding; nits and off-diff/repo-wide observations fold into the summary.

## What's in the package

```
pi-pr-review/
├─ package.json                      # pi manifest: prompts + extensions
├─ prompts/pr-review.md              # the /pr-review orchestrator prompt
├─ extensions/pr-review-subagent.ts  # review_subagents/review_subagent tools + /pr-review-config command
└─ extensions/review-table.ts        # renders the final JSON as a table (TUI only)
```

## Security & cost notes

- The `review_subagents` batch tool and `review_subagent` fallback spawn isolated `pi` subprocesses (`--mode json -p --no-session`) on your configured tier models. Subagents are read-only reviewers (`read,bash,grep,find,ls` by default) and never post comments or edit files.
- Project-local `pr-review.json` is only read when the project is trusted.
- Tiered review calls multiple models per PR, now concurrently for independent passes. Point `light` at a cheap model for overview/risk scan; reserve `heavy` for the deep passes.

## Design notes

- **Process** mirrors the Claude review workflow (PR-number driven, skip closed/draft/already-reviewed, overview + strengths, convention/readability/maintainability, best-effort build/test verification, validate-then-classify, optional comment posting with strict GitHub permalink rules) with bounded parallel multi-model fan-out (configurable light/medium/heavy tiers).
- **Captures every severity** (`nit → P0`) with a `blocking` flag; the verdict depends only on blocking findings, so nothing minor is lost but a clean PR still gets approved.
- **Verification is non-destructive:** any build/test runs in an isolated `git worktree` on the PR head — the prompt never checks out, commits, or pushes in your working tree.
- pi has no built-in sub-agents, so tiering is implemented as an extension that spawns isolated `pi` subprocesses per tier; the batch tool gives deterministic parallelism, and the prompt degrades gracefully to single-pass or inline review when the extension is absent.
