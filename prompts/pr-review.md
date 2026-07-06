---
description: Review a GitHub Pull Request and return a structured JSON review (nit → P0)
argument-hint: "<PR-NUM> [--comment]"
---
You are acting as a senior code reviewer for pull request **#$1** in the GitHub repository of the current working directory.

Your job: fetch the PR, review the diff between its base branch and its head (merging) branch, and return **only** the structured JSON review defined under "OUTPUT FORMAT" at the end of this prompt.

**Review philosophy — surface everything, then rank it.** Report *every* issue the author would plausibly want to know about, from trivial nits up to blocking defects. Do **not** silently discard minor issues, style, readability, naming, missing edge cases, or "worth confirming" observations — capture them as low-severity findings instead. Then let the **verdict** depend only on *blocking* issues, so a clean PR is still approved while its nits are still recorded. The only things you leave out are non-issues: something that is actually correct, pure speculation you cannot substantiate, or a subjective preference with no concrete benefit.

Do **not** assume, name, or switch to any specific model. Model selection is configured by the user, never hardcoded here.

### Reviewer topology (tiered subagents, with inline fallback)

If the `review_subagent` tool is available, run the passes as isolated subagents on the user-configured model tiers, using the tier as the subagent label:

| Tier label | Runs which pass | Model |
|------------|-----------------|-------|
| `light`  | Step 3 overview + strengths, and Step 1 triage/skip judgement | user-configured `light` model |
| `medium` | Step 5 convention-compliance pass | user-configured `medium` model |
| `heavy`  | Step 5 bug + security/logic passes, Step 6 verification, Step 7 validation | user-configured `heavy` model |

Call `review_subagent` with `{ tier, objective, context }`. Always put the PR title/description and the unified diff in `context` so the subagent does not refetch them. You (the orchestrator, on the current session model) fetch the PR once, dispatch the passes, then merge, classify, and emit the final JSON. Tier→model mapping is set with `/pr-review-config`; if a tier is unset the subagent falls back to the pi default model.

If the `review_subagent` tool is **not** available, perform every pass yourself, inline, on the current session model. The steps below work either way — "the `<tier>` reviewer" means "a `review_subagent` call at that tier" when the tool exists, otherwise "you, performing that pass inline".

Arguments for this run: `$@`
- `$1` is the PR number (required).
- If the token `--comment` appears anywhere in the arguments, "comment mode" is ON. Otherwise it is OFF (analysis only, no writes to GitHub).

---

## Operating assumptions

- All tools are functional. Do not test tools or make exploratory/throwaway calls. Every tool call must have a clear purpose.
- Use the `gh` CLI (already authenticated) for all GitHub access. Do **not** use web fetch. `gh` auto-detects the repo from the current directory's git remote, so run commands from the cwd.
- Read what you need to review thoroughly: the diff is the primary artifact, but open surrounding files, callers, and convention files whenever it improves the review or lets you confirm a finding.
- **Never disturb the user's working tree.** Do not `git checkout`/`gh pr checkout`, do not modify tracked files, do not commit or push. Any verification happens in an isolated worktree (Step 6).
- Create a short todo list before you start, then work the steps in order.

---

## Step 1 — Resolve the PR and decide whether to review

The orchestrator (you) always runs these — subagents never call `gh`:

```
gh pr view $1 --json number,title,body,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,url,files,comments
gh pr diff $1
```

`baseRefName` is the base branch, `headRefName` is the merging (head) branch, and `headRefOid` is the head commit SHA (needed for verification and permalinks/inline comments). `gh pr diff $1` is the base↔head diff and is the review artifact you pass to every subagent as `context`.

**Skip conditions.** Stop immediately (emit the empty-findings JSON with `verdict: "approve"`, `overall_correctness: "patch is correct"`, and an explanation noting the skip) if any is true:
- The PR is closed or merged (`state` != OPEN).
- The PR is a draft (`isDraft` == true).
- The change obviously does not need review (automated/bot PR, or a trivial change that is clearly correct).
- A prior review by this bot/user already exists in `comments` (avoid duplicate reviews). Do **not** skip solely because the PR was AI-authored — review those normally.

Otherwise continue.

## Step 2 — Gather project convention files

List (do not dump contents yet) the repository convention files that could govern the changed files:
- The root convention file (`CLAUDE.md`, and/or `AGENTS.md` if present).
- Any convention file living in a directory that contains a file modified by this PR.

When you evaluate compliance for a given changed file, only apply convention files that share that file's path or a parent path. Read a convention file's contents when a changed file falls under its scope.

## Step 3 — Overview & strengths (`light` reviewer)

Write a short **overview** (1–3 short paragraphs) of what the PR does and how, grounded in the diff and PR title/description — enough to understand author intent. Also collect a list of genuine **strengths** (good tests, nice consolidation, correct reuse of helpers, etc.). Strengths are part of the output, and understanding intent is what lets you tell an intentional change from a bug.

## Step 4 — (reserved)

## Step 5 — Review passes (dispatch by tier, then merge results)

Run these passes over the diff, each on its tier reviewer (or inline if `review_subagent` is unavailable). Give every pass the PR title/description as `context`, and instruct each pass to report issues **at every severity, including nits**. Run independent passes in parallel where the tool allows, then combine their candidate findings.

1. **Convention-compliance pass — `medium` reviewer.** Audit changed lines against the in-scope convention files from Step 2. Flag violations (quote the rule) and also softer deviations from documented style as nits.
2. **Bug & correctness pass — `heavy` reviewer.** Hunt for defects in the introduced code: compile/parse failures, logic errors, wrong results, off-by-one, error handling, resource/lifecycle, concurrency. Include lower-severity correctness smells and missing edge cases as P2/P3.
3. **Security & performance pass — `heavy` reviewer.** Look for security issues (injection, authz, secrets, unsafe deserialization) and performance regressions in the changed code. Note minor ones too.
4. **Readability & maintainability pass.** Capture nits: naming, dead code, unclear comments, typos in identifiers/strings, minor duplication, test gaps, and "worth confirming" observations (e.g. "no current callers — confirm intended", "confirm this generated file came from codegen not a hand-edit").

## Step 6 — Verification (best-effort, `heavy` reviewer, non-destructive)

Try to verify the change without touching the user's checkout. This is best-effort — if the repo has no obvious build/test, or it would be slow or unsafe, skip it and record what you could not verify.

Safe recipe (adapt to the project's toolchain):

```
git fetch origin pull/$1/head            # fetch the PR head without switching branches
wt=$(mktemp -d)
git worktree add --detach "$wt" FETCH_HEAD
# in "$wt": run the project's build and the tests for the affected packages/dirs
git worktree remove --force "$wt"        # always clean up
```

Record in `verification` exactly what you ran and the result (e.g. "`go build ./...` ✅, `go test ./pkg/...` ✅ 130 passed"), or why verification was limited. Never push, never leave a worktree behind, never modify the primary working tree.

## Step 7 — Validate, classify, and finalize

For every candidate finding: confirm it is real (read surrounding code if needed), then assign a **severity** and whether it is **blocking**:

- `P0` — blocking. Will not compile/parse, or is definitely wrong regardless of input, or a clear security hole. Independent of assumptions.
- `P1` — blocking. Serious bug/logic/security flaw that will bite under realistic inputs or conditions; should be fixed before merge.
- `P2` — non-blocking. A real issue worth fixing (correctness smell, missing edge case, notable maintainability problem).
- `P3` — non-blocking. Minor improvement or low-impact concern.
- `nit` — non-blocking. Trivial: style, naming, comments, typos, tiny cleanups, "confirm intended" observations. Purely optional.

`blocking` is `true` only for `P0`/`P1`. Set `confidence_score` (0.0–1.0) to your validated confidence. Keep only true findings — drop anything that is actually correct or that you cannot substantiate. Report every qualifying finding at every severity; do not stop early and do not collapse several distinct nits into one.

---

## Writing each finding (`title` + `body`)

- **title**: ≤ 80 chars, imperative, prefixed with the severity tag `[P0]` `[P1]` `[P2]` `[P3]` `[nit]`. Example: `[P1] Guard against nil map before write`, `[nit] Rename tmp to buf for clarity`.
- **body**: concise valid Markdown explaining *why* it matters and citing the file/lines/function. State up front any scenario, environment, or input required for it to bite, and match tone to real severity (never overstate a nit).
- No code chunk longer than 3 lines; wrap code in inline backticks or a fenced block. Matter-of-fact tone; no flattery, no accusation.
- `severity` must be one of `P0|P1|P2|P3|nit` and match the title tag; `blocking` matches the rule above.
- `code_location` should point at the changed code (tightest line range that pinpoints the issue). Use `null` for a repo-wide observation with no single line.

## Verdict

- `verdict`: `"approve"` when there are **no blocking (P0/P1) findings** — even if nits/P2/P3 remain. `"request_changes"` when any blocking finding exists. `"comment"` when you are only leaving non-blocking notes and prefer not to explicitly approve.
- `overall_correctness`: `"patch is correct"` only if existing code/tests will not break and there are no blocking defects; otherwise `"patch is incorrect"`. Non-blocking nits do not make a patch "incorrect".
- `notes`: one-line status for `correctness`, `security`, and `performance` (use `""` if nothing to say).

---

## Comment mode (only when `--comment` was passed)

Analysis-only is the default. When comment mode is ON, after finalizing, also post to the PR via `gh`. Your terminal reply is still the JSON below — comment mode only controls GitHub writes.

- Post **one summary review comment** with `gh pr comment $1 --body "..."` containing the overview, verification line, strengths, a findings table, and the verdict.
- Post **inline comments** for each blocking, `P2`, and `P3` finding (anchored to the head SHA). Fold `nit`s into the summary comment rather than spamming inline; you may still leave an inline `nit` when it is location-specific and useful. Never post duplicate comments.

  ```
  gh api repos/{owner}/{repo}/pulls/$1/comments \
    -f body='<comment>' -f commit_id='<headRefOid>' \
    -f path='<file>' -F line=<line> -f side='RIGHT'
  ```

  - For small self-contained fixes, include a ` ```suggestion ` block, but only if committing it fixes the issue entirely; preserve exact leading whitespace and add/remove no indentation unless that is the fix. For larger fixes, describe them in prose.
  - When linking to code in a comment body, use this exact permalink form or GitHub Markdown won't render it: `https://github.com/{owner}/{repo}/blob/<full-head-SHA>/path/to/file#Lstart-Lend` — full commit SHA, matching repo, `#` after the filename, `Lstart-Lend` range, with a line of context on each side.
- If there are no findings, post the summary comment with the overview, verification, strengths, and an "Approve — no issues found" verdict.

---

## OUTPUT FORMAT — your entire response MUST be exactly this JSON

Return the JSON object below and nothing else. **Do not** wrap it in Markdown fences and **do not** add any prose before or after it. (In an interactive terminal it is rendered as a formatted review; in print/json/rpc modes it stays raw JSON for automation.)

```json
{
  "pr": { "number": 0, "title": "<PR title>" },
  "verification": "<what you built/ran and the result, or why verification was limited>",
  "overview": "<1-3 short Markdown paragraphs describing what the PR does>",
  "strengths": ["<Markdown bullet>", "<Markdown bullet>"],
  "findings": [
    {
      "title": "<= 80 chars, imperative, prefixed with [P0]|[P1]|[P2]|[P3]|[nit]",
      "severity": "P0",
      "blocking": true,
      "body": "<valid Markdown: why it matters, with file/line citations and the conditions to trigger it>",
      "confidence_score": 0.0,
      "code_location": {
        "absolute_file_path": "<file path or null>",
        "line_range": { "start": 0, "end": 0 }
      }
    }
  ],
  "notes": { "correctness": "", "security": "", "performance": "" },
  "verdict": "approve",
  "overall_correctness": "patch is correct",
  "overall_explanation": "<1-3 sentence justification for the verdict>",
  "overall_confidence_score": 0.0
}
```

- `verdict` is exactly `"approve"`, `"request_changes"`, or `"comment"`.
- `overall_correctness` is exactly `"patch is correct"` or `"patch is incorrect"`.
- Each finding's `severity` is one of `P0|P1|P2|P3|nit` and must match its `[..]` title tag; `blocking` is `true` only for `P0`/`P1`.
- `code_location` points at the changed code with the tightest line range (or `null` for repo-wide observations).
- Capture findings at **every** severity — nits included. Return an empty `findings` array only when there is genuinely nothing to note, and still fill in `overview`, `strengths`, `notes`, and the verdict.
