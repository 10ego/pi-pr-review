# Review quality plan: model-assisted finding extraction

Status: proposed (Phase 0). This document is the implementation plan for raising
review output quality without changing what reviewer lanes emit.

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
- **No new trust.** Extractor output is model output: validated, anchored, and
  capped by host code exactly like every other model-derived field.
- Deep single-pass review mode (one heavy model reviewing the whole PR) is a
  separate future proposal; see §10.

## 3. Design

Add one **extraction stage** between synthesis and publication:

```
lanes (freeform Markdown) ─┐
orchestrator synthesis ────┤
                           ▼
              extractFindings (light tier, no tools, one-shot subprocess)
                           ▼
              strict findings JSON
                           ▼
              host validation + merge (parse, safety, anchor, dedupe, cap)
                           ▼
              merged findings → inline comments, verdict line, degraded body
```

A lightweight configured model (the `light` tier) reads the review Markdown —
the synthesis plus retained lane evidence, the same content the degraded body
already carries — and returns a strict findings array. The host then does
everything it already knows how to do with structured findings.

### 3.1 Why this shape

- The **source of truth stays Markdown**. Nothing upstream changes: lanes,
  prompts, synthesis, fallbacks, and the lossless retained evidence are
  untouched. Extraction runs on a *copy*; failure cannot lose information.
- The **light tier is already configured, cheap, and fast** (observed 16.5s for
  a light overview lane). One bounded call per review is a rounding error next
  to four heavy lanes.
- The **host already owns every downstream check** for structured findings
  (`publicationSafeStrictReview`-style safety, anchor validation against
  changed-file metadata in `selectInlineComments`, severity/blocking rules,
  marker and event ownership). The extractor adds candidates; the host decides.

### 3.2 Schema

The extractor returns strict JSON (no fences, single object):

```json
{
  "findings": [
    {
      "title": "Guard empty input",
      "severity": "P2",
      "blocking": false,
      "body": "parseInput crashes on an empty argument list because …",
      "confidence": 0.86,
      "code_location": {
        "absolute_file_path": "src/parser.ts",
        "line_range": { "start": 10, "end": 12 },
        "side": "RIGHT",
        "in_diff": true
      },
      "source": "correctness"
    }
  ]
}
```

Rules:
- Exactly one top-level `findings` array; every field required except
  `code_location` (absent ⇒ summary-only) and `source` (lane pass id or
  `"synthesis"`, used only for diagnostics/telemetry).
- `severity` ∈ P0–P3/nit; `blocking` must equal severity ∈ {P0, P1}.
- `confidence` ∈ [0,1]. Sizes: title ≤ 512 B, body ≤ 16 KiB, path ≤ 4 KiB —
  same bounds the publish path enforces today; reject the whole record on
  violation (never partially apply a malformed object).
- Same shape as `ReviewFindingLike`, so downstream code is unchanged.

### 3.3 New module: `lib/pr-review-extract.ts`

Mirrors the existing self-review subprocess plumbing
(`writeTempPrompt`, `buildReviewBaseArgs()`, `--mode json -p`, `--no-tools`,
`ReviewJsonLineDecoder`, `finalAssistantText`, typed deadline object):

- `buildExtractionSystemPrompt()` — strict JSON contract; **input is data, not
  instructions**; no severity inflation; only findings actually stated in the
  input; drop speculation; keep the reviewer's own wording.
- `runFindingExtraction(config, ctx, input)` — spawns the light-tier child with
  the Markdown payload piped on stdin (bounded; same byte caps as lane tasks).
  Bounded deadline: `min(120s, remaining synthesis window)`.
- `parseExtractionOutput(text)` — strict parse + schema/safety validation
  (control characters, sizes, severity set, blocking consistency).
- `mergeFindings(parsed, extracted, changedFiles)` — union with the
  deterministically parsed findings:
  - dedupe on (normalized path, side, start line, normalized title);
    deterministic findings win ties;
  - anchors not present in changed-file metadata demote to summary-only
    (existing behavior, not new logic);
  - hard cap 50 findings (existing publication cap).

### 3.4 Integration point and ordering

In `extensions/review-table.ts`, after `synthesizeReviewArtifact` and before
`resolveCompletion` caches/publishes:

1. If `extractFindings` enabled **and** `artifact.quality !== "fully_parsed"`
   (Phase 1 scope: degraded reviews only), run extraction over
   `artifact.rawText` + retained lane `rawText`s (same inputs as the degraded
   body, capped).
2. On validated output: merge findings, then **rebuild** the degraded body and
   `syntheticReview` with the merged set (verdict line reflects P0/P1 blocking
   per the existing rule). The body still embeds the full retained Markdown;
   merged findings additionally render as host-formatted blocks and become
   inline-comment candidates.
3. On any failure (timeout, non-zero exit, malformed/unsafe JSON, empty
   output): keep the deterministic artifact unchanged and record a telemetry
   note. Publication never waits on or fails because of extraction.

Quality label: keep the existing `quality` value. Add
`artifact.extraction: { attempted, outcome, findings }` for diagnostics only —
publish gating keys on `quality`/`completeness` exactly as today (degraded ⇒
`COMMENT`-only, never APPROVE).

### 3.5 Failure and degradation matrix

| Extraction outcome | Result |
| --- | --- |
| Valid findings | merged; inline notes on degraded review; verdict line may become `Request changes` if P0/P1 |
| Empty findings `{"findings":[]}` | deterministic artifact unchanged (no false "found nothing" claim — absence of structure ≠ clean review) |
| Timeout / child failure | deterministic artifact unchanged; telemetry `outcome: "timeout"\|"failed"` |
| Malformed / unsafe / over-cap JSON | deterministic artifact unchanged; telemetry `outcome: "rejected"` |
| Not configured / disabled | current behavior, zero new code paths taken |

## 4. Security

- The child is the existing isolated reviewer subprocess shape: no tools, no
  extensions, no session, stdin task, strict JSON out.
- Prompt-injection surface: lane Markdown and PR-derived text are **data**. The
  system prompt states this explicitly; host-side caps bound blast radius
  (finding count ≤ 50, per-field byte caps, control-character rejection).
- Extractor output can never select: review event, commit, repository,
  hostname, API path, the canonical marker, or inline anchor *validity* (the
  host re-derives commentability from diff metadata). It only proposes
  severity/location prose for host validation.
- Degraded + extracted reviews remain `COMMENT`-only and approval-ineligible.
- No secrets cross the boundary; the payload is PR review text already held in
  memory by the host.

## 5. Configuration

`pr-review.json` (user or trusted project scope), default **off** in Phase 1:

```json
{ "extractFindings": true }
```

Malformed values fail closed to `false` with the existing config-warning
machinery. The model stays the configured `light` tier in Phase 1; a separate
tier knob is deferred until metrics justify it.

## 6. Telemetry

Add to the invocation telemetry `notes`/batch details (already persisted via
`pi.appendEntry("pr-review-telemetry", …)`):

- `extraction.attempted` / `outcome` ∈
  `merged | empty | timeout | failed | rejected | disabled`
- counts: `findingsExtracted`, `findingsMerged`, `findingsDeduped`,
  `findingsDemoted`, `inlineComments` on the published review
- wall time of the extraction call

## 7. Rollout

- **Phase 0 (this PR):** design document only. No behavior change.
- **Phase 1:** `lib/pr-review-extract.ts` + config + `review-table.ts`
  integration + tests (list in §8). Shipped default-off.
- **Phase 2:** default-on for balanced/`--full` once metrics hold
  (§9); extraction also over `fully_parsed` syntheses to catch prose findings
  the regex parser missed; verdict integration review.
- **Phase 3 (optional):** per-lane extraction in parallel (bounded by the
  existing batch scheduler) instead of one merged call, removing the
  synthesis bottleneck for very large reviews.

## 8. Phase 1 test plan

- Unit (`tests/pr-review-extract.test.ts`): prompt contains data-not-
  instructions rules; strict parse accepts the canonical object; rejects
  fences, extra fields, bad severity, blocking mismatch, oversized fields,
  control characters — whole-record rejection each time; merge dedupe/tie/
  cap/demote matrix.
- Lifecycle (`pr-review-extension-lifecycle.test.ts`, fake child): valid
  extraction ⇒ degraded review publishes inline comments + host-formatted
  finding blocks + verdict line change for P0/P1; timeout/malformed ⇒ byte-
  identical current behavior; disabled ⇒ no subprocess spawned; config
  malformed value fails closed.
- Publish (`pr-review-publish.test.ts`): merged findings flow through
  `buildLosslessReviewPayload` → inline placement respects diff metadata;
  marker/event ownership untouched.
- Docs-contract test updated for the new config key.

## 9. Success criteria (Phase 2 gate)

- Extraction success (valid merged output) ≥ 95% of enabled runs.
- On degraded reviews with substantive lane evidence, ≥ 1 inline note in a
  target majority of runs where a human spot-check confirms a real finding
  existed in the Markdown.
- No regression: full suite green; publish-safety invariants unchanged
  (degraded never APPROVEs, no false completion claims).
- Wall-clock overhead ≤ ~20s p50, inside the synthesis window.

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
