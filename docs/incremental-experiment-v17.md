# Cumulative incremental final campaign v17

Status: **frozen; collection not started**.

## Candidate

- post-confirmation omitted-gap recovery: `271443a`
- deterministic recovery regression: `a899d06`
- candidate-label and Markdown hard-break normalization: retained from `a37765d` and `204e726`

V17 validates explicit `--incremental` only; selector and `--fresh` mechanics are out of scope.

## Immutable campaign

- Corpus: `pi-pr-review-semantic-v17`
- Corpus SHA-256: `23291bc4d2ac81ea379456094e3e36b404802f1be75080be14b55b706ff2ca51`
- Plan ID: `faa5595590008d25a0f5e3b1441d5c6b47b6fc3d1f16e8408be326394ab11f67`
- Plan SHA-256: `4f97e57203b63d306b76a322c3faf4b7c5a3fd47d84fcb53a88d82da2ca7e920`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

Execute every row exactly once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

## Gates

1. Exact relationships/statuses and complete still-open carry-forward.
2. Visible seeded-defect recall and exact severity no worse than fresh.
3. Clean controls, duplication, operational completion, and fallback rate no worse than fresh.
4. Every required incremental lane completes.
5. Complete-pair incremental median latency is no worse than fresh.
6. Any omitted-gap recovery is post-confirmation, bounded, evidence-preserving, and requires one finalization resubmission.
