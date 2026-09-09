# Conversation-aware cumulative re-review experiment v8

Status: **complete; cumulative incremental remains opt-in and automatic defaulting is rejected**.

## Question

Does cumulative `--incremental` improve subsequent reviews by combining prior-thread revalidation, new-commit review, and an independent full-PR gap hunt—without trusting participant claims or losing defects a fresh review would find?

## Compared strategies

- **Fresh:** `/pr-review 1 --no-comment --balanced`
- **Cumulative incremental:** `/pr-review 1 --no-comment --balanced --incremental`

Both strategies use the same package source, parent/lane models, configuration, final Git tree, and repetition. Only review strategy differs.

## Frozen campaign

- Corpus: `pi-pr-review-semantic-v8`
- Corpus SHA-256: `04782877a21f1171aa02b9e7f44e1d566bd6b824bcb81a2b5eaaabccf0702e8c`
- Plan ID: `e3135abe427bca181d885862c81b31ba76b866d9392af7c6a3bfecb86a78da77`
- Plan file SHA-256: `c5b6bc28642e745ffe7120c08754388142525b5ef9ae37f9af1b715d12cc3591`
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

## Results

All 24 immutable rows completed with canonical publication artifacts and complete required lanes. There were no collector, lifecycle, or publication failures.

| Metric | Fresh | Cumulative incremental |
|---|---:|---:|
| Raw P0/P1 recall | 87.5% (7/8) | 75% (6/8) |
| Raw P2 recall | 100% (4/4) | 75% (3/4) |
| Raw cross-file recall | 50% (1/2) | 100% (2/2) |
| Clean-control case false positives | 0% | 0% |
| Duplicate rate | 13.95% | 17.86% |
| Required lane completion | 100% (60/60) | 100% (36/36) |
| Median total latency | 95.8 s | 122.9 s |
| Aggregate lane work | 1,385.5 s | 849.6 s |

Incremental relationship selection and exact structured prior status were both 100% (12/12). Raw still-open carry-forward was 83.33% (5/6), resolved or obsolete findings were never republished, and three of four same-head rows were approval-eligible. All 12 pairs were operationally complete. Incremental reduced aggregate lane work by 38.7%, but median end-to-end latency was 28.3% higher; same-head rows were modestly faster while simple ancestor rows were slower.

## Adjudication and decision

The raw scorer's four apparent misses were inspected without changing the frozen corpus or report. Every cited defect was explicit in the corresponding canonical artifact: one fresh token-log finding failed a bounded term matcher; two incremental open-redirect findings were split across evidence or assigned P2 where the corpus accepted only P0/P1; and one incremental listener leak was escalated to P1 where the corpus accepted only P2. The immutable adjudication record therefore gives both strategies 12/12 defect-presence recall and incremental 6/6 still-open carry-forward.

That adjudication does not reverse the decision. Incremental had the higher duplicate rate and exceeded the predeclared 25% median-latency allowance, so cumulative incremental is **rejected for automatic/default use** and remains explicitly opt-in. The evidence supports its conversation semantics and complete-diff coverage, but not the intended cheaper/faster product claim. The next iteration must reduce parent synthesis/deduplication cost without weakening the independently bound full-diff gap hunt.

Committed evidence is under `tests/benchmarks/review-semantic/incremental-v8/`; `report.json` is the untouched raw score and `adjudication.json` records the four post-collection semantic decisions.
