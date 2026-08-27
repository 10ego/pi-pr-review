# Review topology experiment v6

Status: **frozen; evidence not yet collected**.

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
