# Review topology experiment v6

Status: **complete; deep topology retention rejected**.

This experiment compares the current balanced and full topologies with the integrated full-diff deep topology on `pi-pr-review-semantic-v6`. Corpus v5 and the interrupted deep-v5 slice are historical context only and are ineligible for retention decisions.

## Frozen design

- Modes: `balanced`, `full`, `deep`.
- Repetitions: 2.
- Cases: all 12 v6 cases per mode and repetition (72 immutable rows).
- Order: deterministic planner order, interleaved by case/mode and rotated by repetition.
- Runtime: one row per collector invocation; no reruns, substitutions, skips, or reordered rows.
- Configuration: one provider/model/thinking/tool/deadline/runtime/source/environment identity across every row.
- Publication: disabled; GitHub access is served only by the read-only shim.
- Evidence: one atomic result envelope per row with embedded hash-bound lane/session/process/audit/review artifacts.

## Predeclared decision rule

The deep topology is eligible for retention only if all conditions hold in the complete two-repetition cohort:

1. Deep P0/P1, security, and cross-file recall are no lower than both balanced and full.
2. Deep P2 and every other per-lens recall are no lower than balanced; any deficit versus full rejects replacing full mode.
3. Deep clean-control case false-positive rate is no higher than balanced, with no duplicate-rate increase.
4. Deep lane completion is no lower than either comparator and publication fallback is lower than both.
5. Deep p50 is no more than 5% above balanced, while p95 and population standard deviation are no worse than balanced.
6. The large sharded-registry case retains its expected cross-file finding in both deep repetitions.
7. Every planned row is present and passes artifact, session, model, topology, timing, and no-write validation.

Because two repetitions remain a small sample, satisfying this rule permits a reviewed topology change but does not create an absolute long-term quality gate. Failure rejects the topology change; criteria will not be relaxed after outcomes.

## Immutable evidence

- Plan ID: `a6487655d69a59d48a53d3f455fd2985780d14cea9a276e9543c21db6426af3f`
- Plan SHA-256: `6347c6a90e4df76518908789978d4fa46635d4f8408e7c0e2699706b998dc930`
- Report SHA-256: `0db10a7d791e43c91f8621c7e4f91aa4baf31ee2f56f834848ed2728f131940c`
- Sanitized run-manifest SHA-256: `9938234904e7a8268a2290c41c5fbf4e65331b11065e4fce9ef209bba10e53bb`
- Private source run-manifest SHA-256: `d2d1d5fc13db8cb1e283ac775c752ebb0965b3d856ba8b3f57bc1e6c4ced63a5`
- Privacy sanitizer SHA-256: `58903ced1e70bcf8c48203ab25752f103a723989c687fb3c73ee5429fe6e5b26`
- Rows: 72/72 exact plan entries; 24 per mode.
- Evidence: `tests/benchmarks/review-semantic/topology-v6/` (privacy-sanitized derivative; transform provenance retained).

## Results

| Metric | Balanced | Full | Deep |
|---|---:|---:|---:|
| P0/P1 recall | 85.71% | 92.86% | 92.86% |
| P2 recall | 50% | 83.33% | 100% |
| Cross-file recall | 83.33% | 83.33% | 83.33% |
| Security recall | 75% | 100% | 100% |
| Performance/resource recall | 50% | 75% | 100% |
| Clean controls with findings | 25% | 100% | 0% |
| Duplicate rate | 0% | 1.61% | 3.57% |
| Complete lane rate | 77.69% | 85.90% | 95.83% |
| Publication fallback rate | 50% | 50% | 8.33% |
| p50 | 154.77 s | 236.56 s | 156.06 s |
| p95 | 284.67 s | 468.49 s | 308.86 s |
| Standard deviation | 217.45 s | 115.93 s | 220.59 s |

## Decision

**Reject topology retention.** Deep met or exceeded every semantic recall target, eliminated clean-control case false positives, materially reduced fallback, and kept p50 within 5% of balanced. It failed three frozen conditions:

1. duplicate rate increased from balanced's 0% to 3.57%;
2. p95 and standard deviation were worse than balanced;
3. the second deep large-case row hard-timed out, so the expected integration finding was not retained in both repetitions.

No default, balanced, or full topology is changed. Deep remains an explicit opt-in mode. Criteria were not relaxed after outcomes.
