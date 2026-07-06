# pi-pr-review

A model-agnostic GitHub pull-request review prompt for [pi](https://pi.dev).

Pass a PR number and pi will:

1. Resolve the PR in the **current directory's git repo** via `gh`.
2. Derive the **base branch** and **head (merging) branch** automatically from the PR.
3. Review the base↔head diff with disciplined passes (convention compliance, bugs, security/logic), validate each candidate, and filter false positives.
4. Return a **structured JSON report** (findings with priority tags + an overall-correctness verdict).
5. Optionally post the findings as inline PR comments (`--comment`).

No model name is hardcoded anywhere. The package ships an extension that adds **tiered review subagents** — `light` / `medium` / `heavy` — that you map to whatever models you like. If the extension isn't loaded, the same prompt runs every pass inline on your current session model, so it always works.

## Requirements

- [`gh`](https://cli.github.com/) installed and authenticated (`gh auth login`).
- Run pi from inside the git repository that hosts the PR (so `gh` auto-detects the repo).

## Install

Install as a pi package (user scope):

```bash
pi install git:github.com/10ego/pi-pr-review
```

Or project scope (shareable with your team, auto-installed on trust):

```bash
pi install -l git:github.com/10ego/pi-pr-review
```

You can also publish it to npm/git and install with `pi install npm:pi-pr-review` or `pi install git:github.com/<you>/pi-pr-review`.

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
| `light`  | triage / skip decision / change summary | fast + cheap |
| `medium` | convention-file (CLAUDE.md/AGENTS.md) compliance | balanced |
| `heavy`  | bug + security/logic review and validation | strongest |

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

Each tier runs in an **isolated `pi` subprocess** on its configured model. If a tier is unset, that subagent falls back to the nearest configured tier, then to your pi default model.

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

The assistant's reply is **only** the JSON object (no prose, no fences):

```json
{
  "findings": [
    {
      "title": "[P1] Guard against nil map before write",
      "body": "Explanation of why this is a problem, citing file/lines...",
      "confidence_score": 0.86,
      "priority": 1,
      "code_location": {
        "absolute_file_path": "pkg/store/cache.go",
        "line_range": { "start": 42, "end": 45 }
      }
    }
  ],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "One P1 nil-map write can panic under concurrent access.",
  "overall_confidence_score": 0.8
}
```

Priority tags: `[P0]` blocking/drop-everything · `[P1]` urgent · `[P2]` normal · `[P3]` nice-to-have. When findings exist and `--comment` is set, each distinct finding is posted once as an inline comment anchored to the PR head commit; with no findings it posts a single "no issues found" summary.

## What's in the package

```
pi-pr-review/
├─ package.json                      # pi manifest: prompts + extensions
├─ prompts/pr-review.md              # the /pr-review orchestrator prompt
└─ extensions/pr-review-subagent.ts  # review_subagent tool + /pr-review-config command
```

## Security & cost notes

- The `review_subagent` tool spawns isolated `pi` subprocesses (`--mode json -p --no-session`) on your configured tier models. Subagents are read-only reviewers (`read,bash,grep,find,ls` by default) and never post comments or edit files.
- Project-local `pr-review.json` is only read when the project is trusted.
- Tiered review calls multiple models per PR. Point `light` at a cheap model to keep triage inexpensive; reserve `heavy` for the deep passes.

## Design notes

- **Process** mirrors the Claude review workflow (PR-number driven, skip closed/draft/already-reviewed, convention-file compliance, high-signal-only, validate-then-filter, optional comment posting with strict GitHub permalink rules) and its multi-model fan-out (haiku/sonnet/opus → configurable light/medium/heavy tiers).
- **Output** matches the GPT review schema (findings + `overall_correctness`, priority tags, tight `code_location` ranges).
- pi has no built-in sub-agents, so tiering is implemented as an extension that spawns isolated `pi` subprocesses per tier; the prompt degrades gracefully to inline passes when the extension is absent.
