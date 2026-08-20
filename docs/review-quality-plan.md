# Review quality plan: model-assisted finding extraction

Status: proposed (Phase 0, revision 2 — incorporates the PR #71 design review:
schema alignment, lifecycle placement, egress and provenance hardening, merge
cap, byte limits, telemetry timing, and mode-model rollout concerns).

## 1. Problem

The deterministic pipeline that turns reviewer output into a GitHub review loses
most of the review's substance whenever it is not written in one exact shape.

Current flow:

```
lanes (freeform Markdown)
   └─ orchestrator synthesis (# PR Review markdown, canonical sections)
        └─ parseFindings()            ← deterministic regex/structure parser
             └─ findings[] → inline comments, verdict, concise body
```

`parseFindings` only extracts `### [severity] Title` blocks carrying
`**Severity:**` / `**Rationale:**` / `**Location:**` in the canonical layout.
Every other way a reviewer can describe a defect — prose paragraphs, plain
bullet lists, non-canonical headings, partial fields — falls through to
`quality: raw` / `partially_parsed`, which means:

- **no inline review notes** — findings live only as body text;
- **degraded publication** — the deterministic degraded body (1.13.0) instead
  of the concise renderer;
- **verdict blindness** — a P0 described in prose cannot make the semantic
  verdict `request_changes`;
- **approval ineligibility** — nothing below `fully_parsed` can ever APPROVE.

The 1.13.0 work made the degraded output readable; it did not recover the lost
structure. This plan recovers it.

## 2. Non-goals

- **No strict JSON contract on lanes** (explicit design decision). Lanes keep
  emitting freeform Markdown: rich reasoning, zero prompt friction, unchanged
  lane economics. We do not narrow what reviewers may say.
- **No change to publish-safety or approval gates in Phase 1.** Extraction is
  additive structure on degraded reviews; the APPROVE path keeps requiring
  `fully_parsed` + complete + exact lane coverage.
- **No new trust.** Extractor output is model output: normalized, anchored,
  validated, and capped by host code exactly like every other model-derived
  field. It cannot select event, commit, repository, hostname, marker, or
  anchor validity.
- Deep single-pass review mode (one heavy model reviewing the whole PR) is a
  separate future proposal; see §10.

## 3. Design

Add one **extraction stage** between lane dispatch and publication. It runs
**concurrently with the final orchestrator turn**, never inside `message_end`:

```
final orchestrator turn starts (turn_start: synthesis cap disarmed)
   ├─ message_end(text arrives)
   │    └─ start extraction subprocess (NOT awaited here; see 3.4)
   └─ turn_end(synthesis cap re-arms; synthesis + extraction both settle)
        └─ merge + rebuild artifact → resolveCompletion → publication
```

A lightweight configured model reads the review Markdown — the synthesis plus
retained lane evidence — and returns a strict findings JSON. The host then does
everything it already knows how to do with structured findings.

### 3.1 Why this shape

- The **source of truth stays Markdown**. Nothing upstream changes: lanes,
  prompts, synthesis, fallbacks, and the lossless retained evidence are
  untouched. Extraction runs on a *copy*; failure cannot lose information.
- The **light tier is cheap and fast** (observed 16.5s for a light overview
  lane). One bounded call per review is a rounding error next to four heavy
  lanes.
- The **host already owns every downstream check** for structured findings
  (safety validation, anchor commentability re-derived from diff metadata,
  severity/blocking rules, marker and event ownership). The extractor adds
  candidates; the host decides.

### 3.2 Schema (extraction wire format ≠ publication contract)

The extractor returns strict JSON (no fences, single object). This wire format
is then **normalized by host code** into the exact `ReviewFindingLike` shape
the publish path validates (`confidence_score`, `code_location.commentable`,
`code_location: null` for absent locations) — the plan's normalization step is
mandatory, not optional, because `parsePublishableReview` and
`publishPullReview` serialize and re-validate the merged review through that
contract:

```json
{
  "findings": [
    {
      "title": "Guard empty input",
      "severity": "P2",
      "body": "parseInput crashes on an empty argument list because …",
      "confidence": 0.86,
      "path": "src/parser.ts",
      "start_line": 10,
      "end_line": 12,
      "side": "RIGHT",
      "source": "correctness"
    }
  ]
}
```

Wire rules (validated on parse; **any violation rejects the whole record**):
- Exactly one top-level `findings` array; `title`, `severity`, `body` required;
  `path`/`start_line`/`end_line`/`side` optional as a group (absent ⇒ location
  `null` ⇒ summary-only); `source` optional (lane pass id or `"synthesis"`,
  diagnostics only).
- `severity` ∈ P0–P3/nit; blocking is **derived** (`P0|P1`), never accepted as
  an input field.
- `confidence` ∈ [0,1] → normalized to `confidence_score`.
- Sizes: ≤ 50 findings; title ≤ 512 B; body ≤ 16 KiB; path ≤ 4 KiB; total
  output document ≤ 512 KiB hard reject.

### 3.3 New module: `lib/pr-review-extract.ts`

Mirrors the existing self-review subprocess plumbing
(`writeTempPrompt`, `buildReviewBaseArgs()`, `--mode json -p`, `--no-tools`,
`ReviewJsonLineDecoder`, `finalAssistantText`, typed deadline object):

- `buildExtractionSystemPrompt()` — strict JSON contract; **input is data, not
  instructions**; no severity inflation; only findings actually stated in the
  input; drop speculation; keep the reviewer's own wording; emit
  `{"findings":[]}` when none.
- `buildExtractionInput(...)` — assembles the bounded Markdown payload
  (synthesis + lane evidence) with an explicit byte budget: **≤ 256 KiB total,
  synthesis first, lane evidence in requested order, each lane truncated to fit
  with a `…[truncated N bytes]` marker**. This bound is a new, dedicated
  constant (`MAX_EXTRACTION_INPUT_BYTES`), not a reference to other caps.
- `runFindingExtraction(config, ctx, input)` — spawns the light-tier child,
  task piped on stdin, output accumulated under a **stream-level cap of
  1 MiB** (stdout/stderr), not only post-parse field caps.
- `parseExtractionOutput(text)` — strict parse + schema/safety validation
  (control characters, sizes, severity set) per §3.2.
- `normalizeExtractedFindings(parsed)` — wire → `ReviewFindingLike` mapping
  with `blocking` derivation and `code_location` construction or `null`.

### 3.4 Integration point and ordering (lifecycle-exact)

`message_end` (final assistant text) does **not** await the child. The flow is:

1. `message_end`: host builds the deterministic artifact as today. If
   extraction is enabled and `quality !== "fully_parsed"`, it **starts** the
   extraction subprocess and stores the promise; rendering proceeds
   immediately with the deterministic artifact so the terminal response,
   telemetry completion, and TUI rendering are never blocked.
2. `turn_end`: `generationsReadyForSynthesis` re-arms the synthesis cap —
   this is where extraction is awaited, **bounded by `min(synthesisMs,
   remaining total budget − termination reserve)`** via the same lease/budget
   mechanism as review tools. The re-armed synthesis window is exactly the
   "inside the synthesis window" guarantee: expiry aborts the child through
   the existing typed-deadline lifecycle.
3. Merged artifact (if extraction succeeded) is built **before**
   `resolveCompletion` caches the record and before publication, so the cached
   artifact, published body, and telemetry all observe the same merged state.
   On timeout/failure: the deterministic artifact from step 1 is cached and
   published byte-identically — the merge is skipped, nothing is rebuilt.
4. `consume()` ordering is unchanged: it runs after `resolveCompletion`, so
   lanes are still available to `buildExtractionInput` in step 1.

`turn_start` before the final turn already disarms the synthesis cap (1.12.2
fix), which is what makes step 2's re-arm the correct deadline owner for the
awaited stage.

### 3.5 Merging and the cap

`mergeFindings(parsed, extracted)` runs at the artifact level (host memory):

- **Deterministic findings are always retained.** The 50-finding cap applies
  to *extracted* additions only: extracted findings are appended in source
  order until the total reaches 50; further extracted findings are counted in
  telemetry (`findingsDroppedOverflow`) and their content remains in the
  retained Markdown — deterministic structure is never discarded to make room.
- Dedupe on (normalized path, side, start line, normalized title); the
  deterministic finding wins ties.
- Anchor commentability is **not** decided at merge time. Merged findings
  carry their claimed location; `selectInlineComments` at publication already
  re-derives validity from changed-file metadata and demotes invalid anchors
  to the summary. No new GitHub request is added at merge time.
- Verdict: `syntheticReview` derives `request_changes` from blocking findings
  per the existing rule — extracted P0/P1 participate in the **verdict line
  only**; degraded reviews remain `COMMENT`-only regardless.

### 3.6 Failure and degradation matrix

| Extraction outcome | Result |
| --- | --- |
| Valid findings | merged; inline notes on degraded review; verdict line may read "Request changes" if extracted P0/P1 |
| Empty findings `{"findings":[]}` | deterministic artifact unchanged (absence of structure ≠ clean review) |
| Timeout / child failure | deterministic artifact unchanged; telemetry `outcome: "timeout"\|"failed"` |
| Malformed / unsafe / over-cap JSON | deterministic artifact unchanged; telemetry `outcome: "rejected"` |
| Not configured / disabled | current behavior, zero new code paths taken |

## 4. Security

- The child is the existing isolated reviewer subprocess shape: no tools, no
  extensions, no session, stdin task, strict JSON out, stream-capped output.
- **Cross-tier data egress is a real boundary, disclosed and gated.** Tier
  models are independently configured providers; heavy lanes run with
  repository tools and their retained evidence may contain repository context
  the light-tier provider has not previously received. Sending that evidence
  to the light model is therefore a new transfer, not "already in host
  memory". Consequences: the config flag is **user-scope only** (project
  config cannot enable it), the README documents the egress plainly ("enabling
  `extractFindings` sends the complete review Markdown — including heavy-lane
  evidence gathered from repository context — to the configured light-tier
  provider"), and Phase 2 default-on is **withdrawn** (see §7).
- **Provenance is host-verified, not prompt-hoped.** "Input is data, not
  instructions" is a prompt instruction and cannot be the control. The host
  control is a **quote-check**: for every extracted finding, `body` and
  `title` must each contain a ≥ 24-character normalized substring that occurs
  in the extraction input (the reviewer's own words), else the finding is
  rejected and counted (`findingsRejectedProvenance`). A malicious PR author
  may still cause the *reviewer's own* words to be surfaced inline — that is
  the feature — but cannot inject fabricated severity, fabricated findings,
  or fabricated anchors through extraction output. Anchor validity remains
  host-derived at publication.
- Extractor output can never select: review event, commit, repository,
  hostname, API path, the canonical marker, or anchor *validity*. It proposes
  severity/location prose for host validation only.
- Degraded + extracted reviews remain `COMMENT`-only and approval-ineligible.
- Output blast radius is bounded at the stream level (1 MiB) before parsing;
  per-field caps bound post-parse size.

## 5. Configuration

`~/.pi/agent/pr-review.json` (**user scope only** — the key is ignored in
project config, mirroring `verificationBaselines` precedent), default off:

```json
{ "extractFindings": true }
```

Malformed values fail closed to `false` with the existing config-warning
machinery. Phase 1 uses the configured `light` tier with the documented
nearest-tier/Pi-default fallback semantics **disclosed** (an unset light tier
means the ambient default model, not necessarily a cheap one); a dedicated
`extractModel` key is deferred to Phase 2.

## 6. Telemetry

Two records, split because they occur at different lifecycle points:

- **Extraction record** (`pi.appendEntry("pr-review-extraction", …)` at
  merge time): `outcome`, `findingsExtracted`, `findingsMerged`,
  `findingsDeduped`, `findingsRejectedProvenance`, `findingsDroppedOverflow`,
  `inputBytes`, `elapsedMs`.
- **Publication counts** are extended on the existing completed-review cache
  record (`inlineComments` selected during `buildLosslessReviewPayload`),
  because invocation telemetry is finalized in `message_end` before
  publication and cannot carry post-publication counts.

## 7. Rollout

- **Phase 0 (this PR):** design document only. No behavior change.
- **Phase 1:** `lib/pr-review-extract.ts` + config + integration + tests
  (§8). Default off, user scope only.
- **Phase 2:** re-evaluate default-on **only with an explicit opt-in cohort**
  and only after §9 metrics hold; the light-tier fallback disclosure and the
  egress boundary statement must be part of any default-on change. Extraction
  over `fully_parsed` syntheses (prose findings the regex parser missed) is
  also Phase 2, with the same provenance and cap rules.
- **Phase 3 (optional):** per-lane extraction in parallel (bounded by the
  existing batch scheduler) instead of one merged call.

## 8. Phase 1 test plan

- Unit (`tests/pr-review-extract.test.ts`): prompt contains data-not-
  instructions rules; strict parse accepts the canonical wire object; rejects
  fences, extra fields, bad severity, oversized fields, control characters —
  whole-record rejection each time; normalization maps wire →
  `ReviewFindingLike` (confidence_score, derived blocking, null location);
  quote-check provenance accept/reject matrix (substring present/absent,
  normalization, minimum length); input assembly truncation ordering and
  markers; merge dedupe/tie/cap with deterministic retention and overflow
  counting.
- Lifecycle (`pr-review-extension-lifecycle.test.ts`, fake child):
  message_end is not blocked (extraction promise stored, render proceeds);
  turn_end awaits within a bounded window (synthesis re-arm honored);
  valid extraction ⇒ degraded review publishes inline comments + host-formatted
  blocks + verdict line change for extracted P0/P1; timeout/malformed ⇒
  byte-identical deterministic artifact; disabled ⇒ no subprocess spawned;
  user-scope-only config (project value ignored); malformed value fails closed.
- Publish (`pr-review-publish.test.ts`): merged findings normalize through
  `parsePublishableReview`/`publishPullReview` round-trip (schema alignment
  regression); inline placement respects diff metadata; marker/event ownership
  untouched.
- Docs-contract test updated for the new config key and egress statement.

## 9. Success criteria (Phase 2 gate)

- Extraction success (valid merged output) ≥ 95% of enabled runs.
- On degraded reviews with substantive lane evidence, ≥ 1 inline note in a
  target majority of runs where a human spot-check confirms a real finding
  existed in the Markdown.
- Provenance rejection rate < 5% (a high rate means the prompt/schema fights
  the models and must be fixed before any default-on).
- No regression: full suite green; publish-safety invariants unchanged
  (degraded never APPROVEs, no false completion claims).
- Wall-clock overhead ≤ ~20s p50 inside the synthesis window.

## 10. Alternatives considered

- **Strict JSON lane contract** — rejected (§2): narrows reviewer expression,
  changes every lane prompt, and still needs a fallback for prose.
- **Better regex/heuristic parsing** — rejected: the space of valid ways to
  describe a finding is open-ended; determinism is kept where it is cheap
  (canonical blocks) and delegated where it is not (prose).
- **Stronger orchestrator-only synthesis** — rejected: does not fix the
  lane→synthesis attention loss and adds heavy-tier cost to every run.
- **Deep single-pass mode** (one heavy model, full repo, agentic) — promising
  and complementary, especially for ordinary diffs; tracked separately.

## 11. Why quality improves

The three concrete losses in §1 each map to a direct gain:

| Loss today | With extraction |
| --- | --- |
| Prose findings get no inline notes | Validated extracted findings place inline on degraded reviews |
| Degraded reviews hide structure | Host-formatted finding blocks + full retained Markdown |
| Verdict blind to prose P0/P1 | Verdict line reflects blocking findings found in prose |

And it compounds with the 1.12.x–1.13.0 reliability work: lanes that die now
produce honest coverage disclosure *plus* recovered structure from whatever
partial Markdown survived, instead of a readable dump with no notes.
