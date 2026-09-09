# Incremental re-review experiment v7 evidence

Status: **collection pending**.

Frozen 24-row fresh/incremental comparison for `pi-pr-review-semantic-v7`:

- Plan ID: `ef9b76228e882b900c215f2ecf176afc6a48491bcb2e93106adbebec134feb01`
- Corpus SHA-256: `77f1fc82d39e1cc9a0b48f36b6d4128110601d5d71bc312779ef10488be9a4ab`
- Plan file SHA-256: `bff4af2bdb8fa3e0494c37709bd4ac1029ed4a6a1493aade1829e1a77df64801`
- Strategies: `fresh`, `incremental`
- Review mode: `balanced`
- Repetitions: 2
- Cases: 6
- Planned rows: 24

The decision rule is frozen in `docs/incremental-experiment-v7.md`. Result rows must be collected in exact plan order with the acknowledged real-model collector. Reruns, substitutions, skips, and reordered entries are forbidden.

## Pre-campaign pilot

One row from superseded plan `8a316c18b5f3eb00568afb1016bf845cce4855b24093627ecca347fbe032ee6c` was attempted before collection. The review itself completed, but collector preflight falsely required every host-recovered structured finding to occur in terminal assistant Markdown. The immutable failed pilot remains under local evidence; no result from that plan is eligible for this campaign. Schema-v2 evidence now binds exact terminal `rawMarkdown` separately from host-rendered publication Markdown, and the revised corpus/plan hashes prevent entry reuse.
