# Cumulative incremental final campaign v17

Status: **complete; publication and automatic selection rejected**.

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

## Results

All 24 rows were collected once in stored order. One incremental clean-control row was retained as a failed result without rerun.

- exact relationships/statuses: 12/12;
- still-open carry-forward: 6/6;
- adjudicated seeded-defect presence: 12/12 for both strategies;
- operational completion: 11/12 for both;
- required-lane completion: 98.3% fresh and 95.0% incremental;
- publication fallback rate: 8.3% for both;
- duplicate rate: 31.9% fresh and 11.1% incremental;
- complete-pair median latency: 75.9s fresh and 73.3s incremental (0.966 ratio);
- paired raw P0/P1 recall: 62.5% fresh and 37.5% incremental;
- paired raw cross-file recall: 100% fresh and 0% incremental.

The failed incremental row claimed host finalization but retained neither required same-head lane. It contained no seeded defect, so visible-defect adjudication remains complete, but operational and lane reliability fail the absolute gate. Publication and automatic selection remain rejected. Raw scoring is unchanged; equivalent findings missed by the bounded matcher are recorded separately in `adjudication.json`.
