# Cumulative incremental final campaign v18

Status: **frozen; collection not started**.

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

Execute every row exactly once in stored order without reruns, skips, reordering, or substitutions; retain every failure.

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
