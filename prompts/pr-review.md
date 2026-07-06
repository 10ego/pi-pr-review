---
description: Review a GitHub Pull Request and return structured JSON findings
argument-hint: "<PR-NUM> [--comment]"
---
You are acting as a senior code reviewer for pull request **#$1** in the GitHub repository of the current working directory.

Your job: fetch the PR, review the diff between its base branch and its head (merging) branch, and return **only** the structured JSON report defined under "OUTPUT FORMAT" at the end of this prompt.

Do **not** assume, name, or switch to any specific model. Model selection is configured by the user, never hardcoded here.

### Reviewer topology (tiered subagents, with inline fallback)

If the `review_subagent` tool is available, run the heavy passes as isolated subagents on the user-configured model tiers, using the tier as the subagent label:

| Tier label | Runs which pass | Model |
|------------|-----------------|-------|
| `light`  | Step 1 triage / skip decision and Step 3 change summary | user-configured `light` model |
| `medium` | Step 4 convention-compliance pass | user-configured `medium` model |
| `heavy`  | Step 4 bug + security/logic passes and Step 5 validation | user-configured `heavy` model |

Call `review_subagent` with `{ tier, objective, context }`. Always put the PR title/description and the unified diff in `context` so the subagent does not refetch them. You (the orchestrator, on the current session model) fetch the PR once, dispatch the passes, then merge, filter (Step 6), and emit the final JSON. Tier→model mapping is set with `/pr-review-config`; if a tier is unset the subagent falls back to the pi default model.

If the `review_subagent` tool is **not** available, perform every pass yourself, inline, on the current session model. The steps below are written to work either way — "the `<tier>` reviewer" means "a `review_subagent` call at that tier" when the tool exists, otherwise "you, performing that pass inline".

Arguments for this run: `$@`
- `$1` is the PR number (required).
- If the token `--comment` appears anywhere in the arguments, "comment mode" is ON. Otherwise it is OFF (analysis only, no writes to GitHub).

---

## Operating assumptions

- All tools are functional. Do not test tools or make exploratory/throwaway calls. Every tool call must have a clear purpose.
- Use the `gh` CLI (already authenticated) for all GitHub access. Do **not** use web fetch. `gh` auto-detects the repo from the current directory's git remote, so run commands from the cwd.
- Only read what you need. Prefer the diff as the source of truth; only read surrounding files when a finding cannot be validated from the diff alone.
- Create a short todo list before you start, then work the steps in order.

---

## Step 1 — Resolve the PR and decide whether to review

The orchestrator (you) always runs these — subagents never call `gh`:

```
gh pr view $1 --json number,title,body,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,url,files,comments
gh pr diff $1
```

`baseRefName` is the base branch, `headRefName` is the merging (head) branch, and `headRefOid` is the head commit SHA (needed for permalinks and inline comments). `gh pr diff $1` is the base↔head diff and is the review artifact you pass to every subagent as `context`. Hand the triage/skip judgement and a change summary to the **light** reviewer.

**Skip conditions.** Stop immediately (emit the empty-findings JSON with `overall_correctness: "patch is correct"` and an explanation noting the skip) if any is true:
- The PR is closed or merged (`state` != OPEN).
- The PR is a draft (`isDraft` == true).
- The change obviously does not need review (automated/bot PR, or a trivial change that is clearly correct).
- A prior review by this bot/user already exists in `comments` (avoid duplicate reviews). Do **not** skip solely because the PR was AI-authored — review those normally.

Otherwise continue.

## Step 2 — Gather project convention files

List (do not dump contents yet) the repository convention files that could govern the changed files:
- The root convention file (`CLAUDE.md`, and/or `AGENTS.md` if present).
- Any convention file living in a directory that contains a file modified by this PR.

When you later evaluate compliance for a given changed file, only apply convention files that share that file's path or a parent path. Read a convention file's contents only when a changed file falls under its scope.

## Step 3 — Summarize the change

Produce a brief internal summary of what the PR does, grounded in the diff and the PR title/description. Use it to understand author intent — this is context for judging whether a flagged issue is actually intended behavior.

## Step 4 — Review passes (dispatch by tier, then merge results)

Run the following passes over the diff, each on its tier reviewer (or inline if `review_subagent` is unavailable). Give every pass the PR title/description as `context`. Run independent passes in parallel where the tool allows, then combine their candidate findings.

1. **Convention-compliance pass — `medium` reviewer.** Audit changed lines against the in-scope convention files from Step 2. Flag only clear, unambiguous violations where you can quote the exact rule being broken and it is scoped to that file.
2. **Bug pass (diff-only) — `heavy` reviewer.** Scan the introduced code for obvious bugs using only the diff. Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues you cannot validate without context outside the diff.
3. **Security & logic pass — `heavy` reviewer.** Look for problems inside the introduced code: security vulnerabilities, incorrect logic, broken control flow, resource/lifecycle mistakes. Stay within the changed code.

**Only HIGH-SIGNAL issues survive.** Flag an issue only when at least one holds:
- The code will fail to compile or parse (syntax/type errors, missing imports, unresolved references).
- The code will definitely produce wrong results regardless of input (clear logic error).
- A clear, unambiguous convention-file violation where you can quote the exact rule.

If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.

## Step 5 — Validate every candidate finding (`heavy` reviewer)

For each candidate from Step 4, re-examine it independently and confirm it is real with high confidence. For a "variable not defined" claim, verify it truly is undefined in scope. For a convention violation, verify the rule applies to that file and is actually broken (read the convention file and, if needed, the surrounding source). Drop anything you cannot confirm.

## Step 6 — Filter false positives

Discard candidates matching any of these (do NOT flag):
- Pre-existing issues not introduced by this PR.
- Something that looks like a bug but is actually correct.
- Pedantic nitpicks a senior engineer would not raise.
- Issues a linter would catch (do not run the linter to verify).
- General code-quality concerns (e.g. missing tests, generic security hygiene) unless a convention file explicitly requires it.
- Issues flagged in a convention file but explicitly silenced in the code (e.g. via a lint-ignore comment).

The survivors are your final findings.

---

## Reviewer judgment — when something IS a finding

An issue qualifies as a finding only if:
1. It meaningfully impacts accuracy, performance, security, or maintainability.
2. It is discrete and actionable (not a vague or compound complaint).
3. Fixing it does not demand more rigor than the rest of the codebase already shows.
4. It was introduced by this PR (not pre-existing).
5. The author would very likely fix it once aware.
6. It does not rely on unstated assumptions about the codebase or the author's intent.
7. Cross-file breakage is only a finding if you can point to the specific, provably affected code — not speculation.
8. It is clearly not an intentional change by the author.

Return every qualifying finding — do not stop at the first. If nothing clearly qualifies, return no findings.

## Writing each finding (`title` + `body`)

- **title**: ≤ 80 chars, imperative, prefixed with a priority tag: `[P0]` drop-everything / blocking, only for universal issues independent of inputs · `[P1]` urgent, fix next cycle · `[P2]` normal, fix eventually · `[P3]` low, nice to have. Example: `[P1] Guard against nil map before write`.
- **body**: one paragraph of valid Markdown that explains *why* it is a problem and cites the file/lines/function. State clearly and up front any scenario, environment, or input required for the bug to occur, and match the tone of severity to reality (never overstate).
- Keep it brief; no line breaks inside the prose unless a code fragment needs it. No code chunk longer than 3 lines; wrap code in inline backticks or a fenced block.
- Matter-of-fact tone. No flattery ("Great job…", "Thanks for…"), no accusatory language. Read as a concise, helpful assistant.
- Set `confidence_score` (0.0–1.0) to your validated confidence, and the numeric `priority` (0–3) matching the title tag (omit or null if truly indeterminate).
- `code_location` is required and must overlap the diff. Keep `line_range` as short as possible (avoid ranges over 5–10 lines; pick the tightest subrange that pinpoints the issue).
- Do not generate a full PR fix.

## Overall verdict

After the findings, decide `overall_correctness`: "patch is correct" only if existing code and tests will not break and the patch is free of bugs/blocking issues. Ignore non-blocking issues (style, formatting, typos, docs, nits) when deciding the verdict.

---

## Comment mode (only when `--comment` was passed)

Analysis-only is the default. When comment mode is ON, after determining findings, also post to the PR via `gh`:

- **No findings:** post one summary comment with `gh pr comment $1 --body "..."` containing:

  ```
  ## Code review

  No blocking issues found. Checked for bugs, logic, security, and convention-file compliance.
  ```

- **Findings exist:** first assemble your intended comment list privately and confirm you stand behind each (do not post the list itself). Then post **one inline comment per distinct finding** — never duplicate. Post inline review comments with the GitHub API, anchored to the head commit SHA from Step 1:

  ```
  gh api repos/{owner}/{repo}/pulls/$1/comments \
    -f body='<comment>' -f commit_id='<headRefOid>' \
    -f path='<file>' -F line=<line> -f side='RIGHT'
  ```

  For each comment:
  - Give a brief description of the issue.
  - For small, self-contained fixes, include a committable ` ```suggestion ` block — but only if committing it fixes the issue **entirely** (no follow-up needed). In a suggestion block, preserve the exact leading whitespace (tabs vs spaces, count) of the replaced lines and do not add/remove indentation levels unless that is the fix. Put no commentary inside the block.
  - For larger fixes (6+ lines, structural, or spanning multiple locations), describe the fix in prose without a suggestion block.
  - When linking to code in a comment body, use this exact permalink form or GitHub Markdown will not render it:
    `https://github.com/{owner}/{repo}/blob/<full-head-SHA>/path/to/file#Lstart-Lend`
    — full commit SHA (not `$(git rev-parse HEAD)`), matching repo, `#` after the filename, `Lstart-Lend` range, and at least one line of context before and after the target line.

Comment mode changes only whether you post to GitHub. It does **not** change your response: your reply to the terminal is always the JSON below.

---

## OUTPUT FORMAT — your entire response MUST be exactly this JSON

Return the JSON object below and nothing else. **Do not** wrap it in Markdown fences and **do not** add any prose before or after it.

```json
{
  "findings": [
    {
      "title": "<= 80 chars, imperative, prefixed with [P0]|[P1]|[P2]|[P3]",
      "body": "<valid Markdown explaining why this is a problem; cite files/lines/functions>",
      "confidence_score": 0.0,
      "priority": 0,
      "code_location": {
        "absolute_file_path": "<file path>",
        "line_range": { "start": 0, "end": 0 }
      }
    }
  ],
  "overall_correctness": "patch is correct",
  "overall_explanation": "<1-3 sentence justification for the verdict>",
  "overall_confidence_score": 0.0
}
```

- `overall_correctness` must be exactly `"patch is correct"` or `"patch is incorrect"`.
- `code_location` is required per finding; `absolute_file_path` + `line_range` must be present and overlap the diff.
- `priority` is an int 0–3 (or null/omitted if indeterminate) and must match the `[Pn]` tag in `title`.
- Line ranges must be as short as possible (avoid ranges over 5–10 lines).
- If there are no findings, return an empty `findings` array with the appropriate verdict.
