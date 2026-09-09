# Incremental re-review experiment v7 evidence

Status: **complete; automatic defaulting rejected, explicit incremental mode retained**.

Immutable 24-row fresh/incremental comparison for `pi-pr-review-semantic-v7`:

- Plan ID: `9b51c3009f05b563bde49e153e818f306260b713b528ead5cfd6eed0bd535439`
- Corpus SHA-256: `e5b2758891b2003b7be18c39dc59ec704d85b2ae1b38a0a51e6cab9f943b99d2`
- Plan file SHA-256: `1b983e26b6967938ca89ca8f3d5c3f68b8cf51dd8163028ee8a68a0a395fd46d`
- Report SHA-256: `ead9ccd642139d94117b71a543012db8868e3afe315c9e65a30c4ee302b70393`
- Sanitized run-manifest SHA-256: `67ccd2eeb7158c797c9a8d7deb40c7bdfd6a3fb018119fe8bcb0c7ef183a478e`
- Private source run-manifest SHA-256: `85cda414682af9ff5fa07466c606fb37250fb70227018bde02eb7deb69ee46e4`
- Strategies: `fresh`, `incremental`
- Review mode: `balanced`
- Repetitions: 2
- Cases: 6
- Rows: 24/24 exact planned rows

Each committed run is a privacy-sanitized derivative of one atomically installed private result containing both hash-bound evidence payloads. `privacy-transform.json` binds the private source manifest, sanitizer, sanitized manifest, and report. Semantic content, timing, lifecycle, model, and GitHub audit evidence are unchanged.

## Results

| Metric | Fresh | Incremental |
|---|---:|---:|
| Aggregate P0/P1 recall | 66.67% | 50% |
| Aggregate P2 recall | 50% | 100% |
| Clean-control case false-positive rate | 50% | 0% |
| Duplicate rate | 30% | 0% |
| Complete lane rate | 75% | 70% |
| Publication fallback rate | 25% | 25% |
| Median total wall time | 118.98 s | 119.33 s |
| Total retained lane time | 1,099.47 s | 646.99 s |
| Relationship accuracy | n/a | 100% (12/12) |
| Exact prior-status accuracy | n/a | 75% (6/8) |
| Still-open semantic carry-forward | n/a | 100% (4/4) |
| Resolved/obsolete findings republished | n/a | 0 |
| Same-head approval-eligible rows | n/a | 0/2 |

Six rows had retained operational failures: three fresh and three incremental. Five ended with terminal-assistant/completed-review mismatch and one incremental no-prior row hit the collector hard timeout. Failures remain in all aggregate denominators.

Seven case/repetition pairs had operationally valid rows for both strategies. Within that paired cohort, both strategies retained every represented seeded defect (2/2 P0/P1 and 1/1 P2). Incremental median lane time was 60.36 s versus fresh 77.27 s (21.9% lower), and aggregate lane time was 10.4% lower. Median total wall time was nevertheless 108.09 s versus fresh 95.83 s (12.8% slower). The valid same-head pair improved from 92.67 s fresh to 50.15 s incremental (45.9% faster). The four valid ancestor-incremental pairs were slower overall despite reduced lane work.

## Decision

**Reject automatic incremental detection as the default.** The experiment demonstrates useful behavior—perfect relationship selection, complete still-open carry-forward, no resolved/obsolete republication, fewer clean-control findings, lower lane work, and a material same-head speedup—but fails the frozen rule because:

1. exact prior-status accuracy was not 100% (one successful row paraphrased the required prior title; one row failed operationally);
2. six rows failed operational evidence requirements;
3. incremental aggregate P0/P1 recall was lower after failures;
4. incremental median total latency was not lower, and valid ancestor-delta pairs were slower.

Keep `--incremental` opt-in. Prioritize exact-title prompt enforcement, terminal completion consistency, and parent revalidation latency before another paired campaign. Publication-v2 same-head approval and thread replies remain separate follow-ups.

## Pre-campaign harness pilots

No pilot result was reused in the final campaign:

- Superseded plan `8a316c18b5f3eb00568afb1016bf845cce4855b24093627ecca347fbe032ee6c`: one successful review was falsely rejected because host-recovered findings were absent from terminal Markdown. Schema-v2 evidence now separately binds terminal and host-rendered Markdown.
- Superseded plan `ef9b76228e882b900c215f2ecf176afc6a48491bcb2e93106adbebec134feb01`: all 24 rows exposed an obsolete fixture marker, causing incremental invocations to correctly fail open to full review.
- Superseded plan `8eebfdc2fb62fcabfd9860ada54db60af545e6d1432ad8554bb032c7ef0f6ebc`: two preflight rows confirmed relationship discovery but exposed a status parser that required a colon instead of the prompt-conformant em dash.

Each correction changed the corpus hash and plan entry IDs before final collection. The final decision rule is frozen in `docs/incremental-experiment-v7.md`.
