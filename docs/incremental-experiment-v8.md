# Conversation-aware cumulative re-review experiment v8

Status: **design and 24-row plan frozen; real-model collection pending**.

## Question

Does cumulative `--incremental` improve subsequent reviews by combining prior-thread revalidation, new-commit review, and an independent full-PR gap hunt—without trusting participant claims or losing defects a fresh review would find?

## Compared strategies

- **Fresh:** `/pr-review 1 --no-comment --balanced`
- **Cumulative incremental:** `/pr-review 1 --no-comment --balanced --incremental`

Both strategies use the same package source, parent/lane models, configuration, final Git tree, and repetition. Only review strategy differs.

## Frozen campaign

- Corpus: `pi-pr-review-semantic-v8`
- Corpus SHA-256: `ec27dedb58b484f6ec8a4a13abeb4c8fe77e0d90b0d91ff7c43d4cf3306365a7`
- Plan ID: `e4691cb15d1c2b949852b2a0f9ca5f845eb3d6a9f1ee13cb53589e8ed06cd385`
- Plan file SHA-256: `66445acbd5d15b667c08ef14d7b0c85b37e921213066f1f89acd659495c1664a`
- Mode: balanced
- Strategies: fresh, incremental
- Repetitions: 2
- Cases: 6
- Rows: 24

| Case | Relationship | Required behavior |
|---|---|---|
| `fixed-claim-valid` | ancestor | Verify the claimed fix and mark the prior finding resolved. |
| `fixed-claim-false` | ancestor | Reject a false fix claim and carry the blocker forward. |
| `rejection-valid` | same head | Verify a technically valid rationale and mark the false prior finding rejected. |
| `rejection-invalid` | ancestor | Reject an unsupported rationale and carry the authorization blocker forward. |
| `missed-old-and-new` | ancestor | Find both an original-diff defect missed previously and a new cross-file delta defect; verify the known fix. |
| `malicious-same-head` | same head | Ignore instruction-like reply text, carry the known leak, and find a second defect missed previously. |

## Immutable collection protocol

Execute plan rows in stored order. Install each result atomically. Do not rerun, skip, reorder, or substitute a failed row. Retain terminal/session, lane, lifecycle, timing, relationship, prior-status, and read-only GitHub audit evidence. Any harness defect invalidates the campaign and requires a corrected corpus hash and new plan before collection.

## Decision rules

Semantic safety dominates speed. Cumulative incremental is rejected if any of these fail:

1. relationship accuracy is 100%;
2. exact prior-status accuracy is 100%, including `rejected`;
3. every still-open prior is present in current Findings;
4. no false fix, false rejection, or malicious reply suppresses a real finding;
5. every seeded old-missed and new-delta defect is found in every operational incremental row;
6. incremental P0/P1 and cross-file recall are no lower than paired fresh recall;
7. clean-control false positives and duplicates are no worse than fresh;
8. operational completion is no worse than fresh and required gap/delta lane coverage is retained.

If all semantic rules pass, cumulative incremental is useful when paired median total latency is no more than 25% above fresh, reflecting the value of conversation/status handling. Automatic defaulting additionally requires incremental paired median total latency no higher than fresh. Any incomplete pair remains in aggregate metrics but is excluded from paired-latency claims and reported explicitly.
