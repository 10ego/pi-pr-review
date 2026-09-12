# Automatic fresh versus incremental selection v2

Status: **complete; automatic defaulting rejected**.

V2 repeats the exact v1 relationships, cases, strategies, repetitions, order policy, model, and gates after one bounded parser correction: an exact single-backtick code span around a recognizable candidate `location` value is unwrapped before the existing strict path/range validator runs. Malformed, unmatched, multiple, traversal, absolute, and backtick-bearing paths remain rejected.

- candidate: `44cb10dee0877e53cfb87473100f466418075d04`
- corpus SHA-256: `98f111ce42ecc6892701514ad43f3046915dc0c1b775ae9b928447f136927df0`
- plan ID: `f44d43f732243a60adc21c02af33350e51b5cdca2fc5390757a51e318bd18dd2`
- plan SHA-256: `72917802ebe2d4ca482a44c96f0812431a0daf0ba5c46157045f1e1770b0f53a`
- 36 rows: fresh, explicit incremental, and automatic; two repetitions; no reruns

## Results

- 36/36 rows retained with process exit 0 and no reruns, skips, or substitutions;
- automatic selection telemetry and relationships: 12/12 exact;
- automatic prior statuses: 8/8 exact;
- automatic still-open carry-forward: 4/4;
- automatic operational completion: 12/12;
- automatic required-lane completion: 48/48;
- automatic fallback: 0/12;
- explicit fresh completion: 12/12 runs and 60/60 lanes;
- explicit incremental completion: 11/12 runs and 47/48 lanes;
- automatic raw recall: P0/P1 100%, P2 50%, cross-file 100%;
- separately adjudicated automatic seeded-defect presence: 8/8, the same as both explicit strategies;
- adjudicated exact severity: automatic 7/8, fresh 8/8, incremental 8/8;
- duplicate rate: automatic 15.0%, fresh 29.3%, incremental 15.0%;
- automatic median latency: 94.2s versus 84.3s for the corresponding explicit strategy (ratio 1.118).

The only raw automatic matcher miss is visibly the expected same-head listener-cleanup defect, reported twice at the correct location, but both canonical findings overclassify the expected P2 as P1. The scorer rejects both because P1 is outside the expected finding's P2-only severity constraint; semantic presence is clear, but severity accuracy genuinely fails. Automatic selection also exceeded the corresponding explicit median latency by 11.8%. Automatic defaulting therefore remains unreleased.

## Post-campaign forensics

Retained phase timing showed automatic execution was faster in 8/12 corresponding pairs, with a nearest-rank median within-pair delta of −14.8s and an 11.6s lower lane-sum median. The apparent 11.8% regression came from subtracting marginal medians under high model-runtime variance. Future selector campaigns use the corpus-defined automatic↔explicit pairing and gate the median within-pair delta; both marginal medians remain diagnostic.

The severity miss exposed a deterministic host boundary: same-title model or parent re-entry could replace a canonical still-open finding at a higher severity. The follow-up implementation discards such re-entry and renders the source-revalidated prior finding from its host-owned canonical title and exact recorded severity. V2 remains rejected and immutable; these corrections require new evidence.

## Directional pilot

A disposable six-case post-fix automatic-only pilot completed 6/6 operational runs and 24/24 required lanes with exact relationship and strategy behavior, 100% raw seeded-defect recall, zero fallback, and 65.8s median latency. Directional evidence does not override the failed immutable severity and latency gates.
