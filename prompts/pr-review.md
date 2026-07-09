---
description: Review a GitHub Pull Request and return a structured JSON review (nit → P0)
argument-hint: "<PR-NUM> [--comment]"
---
You are acting as a senior code reviewer for pull request **#$1** in the GitHub repository of the current working directory.

Your job: fetch the PR, review the diff between its base branch and its head (merging) branch, and return **only** the structured JSON review defined under "OUTPUT FORMAT" at the end of this prompt.

**Review philosophy — surface everything in scope, then rank it.** Report *every* issue the author would plausibly want to know about, from trivial nits up to blocking defects. Do **not** silently discard minor issues, style, readability, naming, missing edge cases, or "worth confirming" observations — capture them as low-severity findings instead. Then let the **verdict** depend only on *blocking* issues, so a clean PR is still approved while its nits are still recorded. The only things you leave out are non-issues: something that is actually correct, pure speculation you cannot substantiate, or a subjective preference with no concrete benefit.

**Stay strictly in scope — review the PR, not the repository.** Every finding must be *caused by* or *directly relevant to* this PR's diff: the added/removed/modified lines and the code they **provably** affect. Do **not** flag pre-existing issues in code the PR does not touch, and do not turn this into a whole-codebase audit — if the same problem existed before this PR, leave it out. You may (and should) read surrounding files, callers, tests, and convention files for context or to confirm a finding, but reading them is not license to report unrelated problems you happen to see there. A cross-file finding is valid only when you can point to the specific code the change **provably** breaks or requires updating (e.g. a caller that must change because of this diff) — never on speculation that the change "might" affect something.

> **OUTPUT CONTRACT — read this twice.** Your *entire* final message is the single JSON object defined under **OUTPUT FORMAT**, and nothing else: no prose, no Markdown, no headings, no code fences, and **not** the human-readable review. The overview, strengths, verification, notes, and verdict are **fields inside that JSON**, not text you write out. A separate renderer turns the JSON into the formatted table/report for humans — if you write the report yourself instead of the JSON, it will **not** render and the review will be considered failed. Do all your analysis with tools, then emit only the JSON object.

Do **not** assume, name, or switch to any specific model. Model selection is configured by the user, never hardcoded here.

### Reviewer topology (parallel tiered subagents, with inline fallback)

You are the **orchestrator**. You own all GitHub access, skip decisions, convention-file discovery, verification worktrees, final validation/classification, JSON emission, and optional comment posting. Subagents are read-only reviewers: they receive PR context from you and return candidate evidence only.

If the `review_subagents` batch tool is available, prefer it over multiple single-pass calls. Fetch PR metadata and the unified diff once, gather any relevant convention-file excerpts, then call `review_subagents` with shared `context`, `max_parallel`, and ordered `passes`. This guarantees bounded parallel fan-out instead of depending on whether the tool interface runs separate calls concurrently. Use these pass assignments:

| Pass id | Tier label | Scope |
|---------|------------|-------|
| `overview` | `light` | Step 3 overview, strengths, and high-level risk areas |
| `conventions-maintainability` | `medium` | Step 5 convention compliance, readability, maintainability, test gaps, and nits |
| `correctness` | `heavy` | Step 5 compile/parse, logic, error handling, lifecycle, concurrency, and edge-case defects |
| `security-performance` | `heavy` | Step 5 security vulnerabilities and performance regressions |

Call `review_subagents` with `{ context, max_parallel: 4, passes: [...] }`. If any pass returns `status: failed`, treat the review evidence as incomplete: rerun the failed pass with `review_subagent` or perform that pass inline before finalizing. Always put the PR title/description, relevant metadata, convention-file excerpts, and unified diff in shared `context` so subagents do not refetch anything.

If `review_subagents` is unavailable but `review_subagent` is available, run the same pass assignments as individual `review_subagent` calls; emit independent calls in the same turn when the interface supports parallel tool calls. If neither subagent tool is available, perform every pass yourself inline on the current session model.

Tier→model mapping is set with `/pr-review-config`; if a tier is unset the subagent falls back to the nearest configured tier, then the pi default model.

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

`baseRefName` is the base branch, `headRefName` is the merging (head) branch, and `headRefOid` is the head commit SHA (needed for duplicate-review reconciliation, verification, and permalinks/inline comments). `gh pr diff $1` is the base↔head diff and is the review artifact you pass to every subagent as `context`.

**Skip conditions.** Stop immediately (emit the empty-findings JSON with `verdict: "approve"`, `overall_correctness: "patch is correct"`, and an explanation noting the skip) if any is true:
- The PR is closed or merged (`state` != OPEN).
- The PR is a draft (`isDraft` == true).
- The change obviously does not need review (automated/bot PR, or a trivial change that is clearly correct).
- A prior `pi-pr-review` summary comment exists with a hidden marker whose `headRefOid` exactly matches the current `headRefOid` (same PR head already reviewed). Do **not** skip for older markers with a different SHA, unmarked prior comments/reviews, or because the PR was AI-authored — review those normally.

**Duplicate-review reconciliation.** Prior comments are only authoritative when they contain the exact marker form `<!-- pi-pr-review: {"schema":1,"headRefOid":"<full-head-SHA>"} -->`. If the marker SHA differs from the current `headRefOid`, the PR has new commits since the previous review, so continue and review the current diff. If comments contain older unmarked review text, treat it as unknown/stale and continue; unmarked comments cannot prove the current head was reviewed.

Otherwise continue.

## Step 2 — Gather project convention files

List (do not dump contents yet) the repository convention files that could govern the changed files:
- The root convention file (`CLAUDE.md`, and/or `AGENTS.md` if present).
- Any convention file living in a directory that contains a file modified by this PR.

When you evaluate compliance for a given changed file, only apply convention files that share that file's path or a parent path. Read a convention file's contents when a changed file falls under its scope, and include the relevant rule excerpts (with file paths) in the shared context for the medium pass.

## Step 3 — Overview & strengths (`light` reviewer)

Write a short **overview** (1–3 short paragraphs) of what the PR does and how, grounded in the diff and PR title/description — enough to understand author intent. Also collect a list of genuine **strengths** (good tests, nice consolidation, correct reuse of helpers, etc.) and any high-level risk areas for the specialist passes. Strengths are part of the output, and understanding intent is what lets you tell an intentional change from a bug.

When `review_subagents` is available, include this as the `overview` pass in the same batch as the Step 5 review passes instead of waiting for a separate sequential call.

## Step 4 — (reserved)

## Step 5 — Review passes (dispatch by tier, then merge results)

Run these independent passes over the diff, each on its tier reviewer (or inline if subagent tools are unavailable). Give every pass the shared PR context from Step 1 plus the relevant convention-file excerpts from Step 2, and instruct each pass to report issues **at every severity, including nits**, within its own scope. Do **not** ask every pass to audit everything; the objective boundaries below reduce duplicate work while preserving coverage.

When `review_subagents` is available, dispatch the Step 3 `overview` pass and these Step 5 passes in one batch with `max_parallel: 4`, then combine the ordered outputs:

1. **Convention, readability & maintainability pass — `medium` reviewer.** Audit changed lines against the in-scope convention files from Step 2. Flag violations (quote the rule), softer deviations from documented style as nits, naming/dead-code/comment/typo issues, minor duplication, test gaps, and "worth confirming" observations (e.g. "no current callers — confirm intended", "confirm this generated file came from codegen not a hand-edit"). Do not duplicate deep correctness or security analysis unless needed to explain a convention/maintainability issue.
2. **Bug & correctness pass — `heavy` reviewer.** Hunt for defects in the introduced code: compile/parse failures, logic errors, wrong results, off-by-one, error handling, resource/lifecycle, concurrency, and edge cases. Include lower-severity correctness smells and missing edge cases as P2/P3. Do not duplicate pure style nits covered by the medium pass.
3. **Security & performance pass — `heavy` reviewer.** Look for security issues (injection, authz, secrets, unsafe deserialization) and performance regressions in the changed code. Note minor ones too. Do not duplicate ordinary correctness/readability findings unless they are security/performance relevant.

## Step 6 — Verification (best-effort, orchestrator-owned, non-destructive)

Try to verify the change without touching the user's checkout. This is best-effort — if the repo has no obvious build/test, or it would be slow or unsafe, skip it and record what you could not verify. Do not delegate worktree creation, `gh`, or final verification status to subagents.

Safe recipe (adapt to the project's toolchain):

```
git fetch origin pull/$1/head            # fetch the PR head without switching branches
wt=$(mktemp -d)
git worktree add --detach "$wt" FETCH_HEAD
# in "$wt": run the project's build and the tests for the affected packages/dirs
git worktree remove --force "$wt"        # always clean up
```

Record in `verification` exactly what you ran and the result (e.g. "`go build ./...` ✅, `go test ./pkg/...` ✅ 130 passed"), or why verification was limited. Never push, never leave a worktree behind, never modify the primary working tree.

## Step 7 — Validate, classify, and finalize (orchestrator-owned)

Merge duplicate candidate findings across passes, then for every remaining candidate finding: confirm it is real (read surrounding code if needed), verify it is PR-scoped, then assign a **severity** and whether it is **blocking**:

- `P0` — blocking. Will not compile/parse, or is definitely wrong regardless of input, or a clear security hole. Independent of assumptions.
- `P1` — blocking. Serious bug/logic/security flaw that will bite under realistic inputs or conditions; should be fixed before merge.
- `P2` — non-blocking. A real issue worth fixing (correctness smell, missing edge case, notable maintainability problem).
- `P3` — non-blocking. Minor improvement or low-impact concern.
- `nit` — non-blocking. Trivial: style, naming, comments, typos, tiny cleanups, "confirm intended" observations. Purely optional.

`blocking` is `true` only for `P0`/`P1`. Set `confidence_score` (0.0–1.0) to your validated confidence. Keep only true findings — drop anything that is actually correct, that you cannot substantiate, or that is **pre-existing and not introduced or provably affected by this PR**. Report every qualifying finding at every severity; do not stop early and do not collapse several distinct nits into one.

---

## Writing each finding (`title` + `body`)

- **title**: ≤ 80 chars, imperative, prefixed with the severity tag `[P0]` `[P1]` `[P2]` `[P3]` `[nit]`. Example: `[P1] Guard against nil map before write`, `[nit] Rename tmp to buf for clarity`.
- **body**: concise valid Markdown explaining *why* it matters and citing the file/lines/function. State up front any scenario, environment, or input required for it to bite, and match tone to real severity (never overstate a nit).
- No code chunk longer than 3 lines; wrap code in inline backticks or a fenced block. Matter-of-fact tone; no flattery, no accusation.
- `severity` must be one of `P0|P1|P2|P3|nit` and match the title tag; `blocking` matches the rule above.
- `code_location` must carry everything needed to post the finding as a GitHub **inline review comment** whenever the code it references is part of the diff:
  - `absolute_file_path`: the file's **repo-relative** path exactly as it appears in the PR diff (this is GitHub's `path`, e.g. `pkg/store/cache.go`). Not an on-disk absolute path.
  - `line_range`: the line numbers **on `side`** as they appear in the diff — new-file line numbers for `RIGHT`, old-file line numbers for `LEFT`. Compute them from the diff's `@@ -old,+new @@` hunk headers. Keep it tight; use `start == end` for a single line, and for a multi-line range `start` must be `< end` and inside the *same* hunk.
  - `side`: `RIGHT` for added or context lines, `LEFT` for removed lines.
  - `commentable`: `true` only when the cited lines lie **inside a diff hunk** (GitHub only accepts inline comments on diff lines). Set it to `false` — or set `code_location` to `null` — for observations about **this PR's impact** on unchanged code or callers elsewhere (e.g. a caller this diff requires updating, or "no current callers — confirm intended"); those go in the summary rather than inline. This is not a channel for unrelated pre-existing issues — those are out of scope (see "Stay strictly in scope").

## Verdict

- `verdict`: `"approve"` when there are **no blocking (P0/P1) findings** — even if nits/P2/P3 remain. `"request_changes"` when any blocking finding exists. `"comment"` when you are only leaving non-blocking notes and prefer not to explicitly approve.
- `overall_correctness`: `"patch is correct"` only if existing code/tests will not break and there are no blocking defects; otherwise `"patch is incorrect"`. Non-blocking nits do not make a patch "incorrect".
- `notes`: one-line status for `correctness`, `security`, and `performance` (use `""` if nothing to say).

---

## Comment mode (only when `--comment` was passed)

Analysis-only is the default. When comment mode is ON, after finalizing, also post to the PR via `gh`. Your terminal reply is still the JSON below — comment mode only controls GitHub writes.

- Post **one summary review comment** with `gh pr comment $1 --body "..."` containing the overview, verification line, strengths, a findings table, and the verdict. End the comment body with this exact hidden reconciliation marker using the current PR head SHA: `<!-- pi-pr-review: {"schema":1,"headRefOid":"<headRefOid>"} -->`. This marker is what future runs use to skip only an already-reviewed identical head.
- Post **inline comments** for each blocking, `P2`, and `P3` finding whose `code_location.commentable` is `true`, anchored to the head SHA. Fold `nit`s and any non-commentable findings into the summary comment rather than spamming inline (you may still leave an inline `nit` when it is location-specific and useful). Never post duplicate inline comments for the same finding on the same `headRefOid`; comments attached to older SHAs do not make the current head a duplicate. Use the finding's own anchor fields:

  ```
  # single line  (line_range.start == line_range.end)
  gh api repos/{owner}/{repo}/pulls/$1/comments \
    -f body='<comment>' -f commit_id='<headRefOid>' \
    -f path='<absolute_file_path>' -F line=<line_range.end> -f side='<side>'

  # multi-line  (line_range.start < line_range.end)
  gh api repos/{owner}/{repo}/pulls/$1/comments \
    -f body='<comment>' -f commit_id='<headRefOid>' -f path='<absolute_file_path>' \
    -F start_line=<line_range.start> -f start_side='<side>' \
    -F line=<line_range.end> -f side='<side>'
  ```

  - `path` = `absolute_file_path`, `side`/`start_side` = the finding's `side`, and the line numbers come straight from `line_range`. If an inline post is rejected (e.g. the line is not part of the diff), fold that finding into the summary comment instead.
  - For small self-contained fixes, include a ` ```suggestion ` block, but only if committing it fixes the issue entirely; preserve exact leading whitespace and add/remove no indentation unless that is the fix. For larger fixes, describe them in prose.
  - When linking to code in a comment body, use this exact permalink form or GitHub Markdown won't render it: `https://github.com/{owner}/{repo}/blob/<full-head-SHA>/path/to/file#Lstart-Lend` — full commit SHA, matching repo, `#` after the filename, `Lstart-Lend` range, with a line of context on each side.
- If there are no findings, post the summary comment with the overview, verification, strengths, an "Approve — no issues found" verdict, and the same hidden reconciliation marker.

---

## OUTPUT FORMAT — your entire response MUST be exactly this JSON

Your final message must be **exactly one JSON object** matching the shape below and nothing else — no leading sentence like "Here is the review", no Markdown, no headings, no ``` fences, no trailing commentary. The first character you emit is `{` and the last is `}`. Put the narrative into the `overview`, `strengths`, `verification`, `notes`, and `verdict` fields; do not also write it as prose. (In an interactive terminal the JSON is rendered as a formatted review table; in print/json/rpc modes it stays raw JSON for automation.)

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
        "absolute_file_path": "<repo-relative path exactly as in the diff, or null>",
        "line_range": { "start": 0, "end": 0 },
        "side": "RIGHT",
        "commentable": true
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
- `code_location` is diff-anchored so commentable findings can be posted inline: repo-relative `absolute_file_path`, `line_range` on `side` (new-file lines for `RIGHT`, old-file for `LEFT`), `side` = `RIGHT|LEFT`, and `commentable` = whether the lines are inside a diff hunk. Use `null` (or `commentable: false`) for repo-wide/out-of-diff observations.
- Capture findings at **every** severity — nits included. Return an empty `findings` array only when there is genuinely nothing to note, and still fill in `overview`, `strengths`, `notes`, and the verdict.
