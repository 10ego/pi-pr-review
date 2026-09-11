# Cumulative incremental final campaign v18

Status: **complete; explicit opt-in publication gates passed**.

## Candidate

- one-shot host continuation for incomplete incremental terminal responses: `187926e`
- lifecycle, delivery, cancellation, and context hardening through `b4e6e1c`
- post-confirmation omitted-gap recovery retained from `271443a`

V18 validates explicit `--incremental` only. Automatic selection and `--fresh` mechanics remain out of scope.

## Immutable campaign

- Candidate commit: `b4e6e1cc5a89f051b1b1f42cf2f0b298c644fc28`
- Corpus: `pi-pr-review-semantic-v17`
- Corpus SHA-256: `23291bc4d2ac81ea379456094e3e36b404802f1be75080be14b55b706ff2ca51`
- Plan ID: `faa5595590008d25a0f5e3b1441d5c6b47b6fc3d1f16e8408be326394ab11f67`
- Plan SHA-256: `4f97e57203b63d306b76a322c3faf4b7c5a3fd47d84fcb53a88d82da2ca7e920`
- Model: `openai-codex/gpt-5.6-sol`, medium effort
- 24 rows: balanced, fresh and explicit incremental, two repetitions of six cases

Every row was executed exactly once in stored order without reruns, skips, reordering, or substitutions; every result was retained.

## Results

- 24/24 rows retained with process exit 0;
- exact relationships/statuses: 12/12;
- still-open carry-forward: 6/6;
- adjudicated seeded-defect presence: 12/12 for both strategies;
- adjudicated exact severity: 58.3% fresh and 66.7% incremental;
- operational completion: 11/12 fresh and 12/12 incremental;
- required-lane completion: 98.3% fresh and 100% incremental;
- publication fallback rate: 8.3% fresh and 0% incremental;
- duplicate rate: 33.3% fresh and 11.1% incremental;
- complete-pair median latency: 90.0s fresh and 71.2s incremental (0.792 ratio);
- clean-control false-positive rate: 0% for both.

The raw matcher undercounted nine visibly equivalent findings. They are retained separately in `adjudication.json`; the frozen raw report and run evidence are unchanged. Explicit opt-in `--incremental` passes every publication gate. Automatic selection remains deferred because selector and explicit `--fresh` mechanics were outside this campaign.

## Pre-freeze evidence

- 579 Bun tests and 145 tooling tests pass.
- Independent exact-snapshot review found no P0–P2 issues.
- Six-case normal incremental pilot: 6/6 operational, 20/20 lanes complete, exact relationships/statuses/carry-forward, no fallbacks, 66.9s median latency.
- Deliberately induced real-Pi omission: host continuation queued and delivered, both missing same-head lanes completed, canonical finalization had no fallback, and persisted continuation content was empty.

## Gates

1. Exact relationships/statuses and complete still-open carry-forward.
2. Adjudicated visible seeded-defect recall and exact severity no worse than fresh.
3. Clean controls, duplication, operational completion, and fallback rate no worse than fresh.
4. Every required incremental lane completes.
5. Complete-pair incremental median latency is no worse than fresh.
6. Any host continuation is one-shot, invocation-bound, budget-bound, privacy-safe, and retained separately from provider fallback telemetry.
