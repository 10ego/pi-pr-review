# Incremental re-review experiment v7 evidence

Status: **collection pending**.

Frozen 24-row fresh/incremental comparison for `pi-pr-review-semantic-v7`:

- Plan ID: `8eebfdc2fb62fcabfd9860ada54db60af545e6d1432ad8554bb032c7ef0f6ebc`
- Corpus SHA-256: `2966fb69c466a15328cfd38476dd3e01eead420ed56f1b8bbe6f74beeedff01a`
- Plan file SHA-256: `a76fa9c54abc665c5f12b110e006d9e8a11aaed22be4715315b82a76a6af43d5`
- Strategies: `fresh`, `incremental`
- Review mode: `balanced`
- Repetitions: 2
- Cases: 6
- Planned rows: 24

The decision rule is frozen in `docs/incremental-experiment-v7.md`. Result rows must be collected in exact plan order with the acknowledged real-model collector. Reruns, substitutions, skips, and reordered entries are forbidden.

## Pre-campaign pilot

One row from superseded plan `8a316c18b5f3eb00568afb1016bf845cce4855b24093627ecca347fbe032ee6c` was attempted before collection. The review itself completed, but collector preflight falsely required every host-recovered structured finding to occur in terminal assistant Markdown. The immutable failed pilot remains under local evidence; no result from that plan is eligible for this campaign. Schema-v2 evidence now binds exact terminal `rawMarkdown` separately from host-rendered publication Markdown, and the revised corpus/plan hashes prevent entry reuse.

A subsequent 24-row harness-validation campaign under superseded plan `ef9b76228e882b900c215f2ecf176afc6a48491bcb2e93106adbebec134feb01` revealed that its fixture used the obsolete `head=...` marker rather than the production schema-1 JSON marker. Every incremental invocation therefore correctly selected `none` and failed open to full review. Those rows measure neither incremental recall nor savings and are excluded. The current corpus requires the exact production marker template and has distinct corpus, plan, and entry hashes.
