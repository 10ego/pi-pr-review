# Automatic fresh versus incremental selection v5

Status: **complete; automatic defaulting rejected**.

V5 replaced interrupted V4 without changing the source-bound prior severity rule, semantic cases, or release gates. A detached sequential collector isolated collection from host command deadlines.

- candidate: `9558a0637a868e3a50e94cb6d7f090cde94473e9`
- corpus SHA-256: `afadda8cf975e7fe1a4fd5c788c6aaaea56f8be7f48d4f0725238d27ad4bbdc2`
- plan ID: `94b9f16b7bf4d9d6cce3b9e126b9afa4410e93656a22ff64799121c0016822b0`
- plan SHA-256: `872f1396b2936c2cbc817072d01857031bb1f81c80aa4aeaa1b6bb50dfcc9426`

## Results

- 36/36 rows retained once in stored order, with no reruns, skips, or substitutions;
- automatic selection events and relationships: 12/12 exact;
- automatic prior statuses: 8/8; still-open carry-forward: 4/4;
- adjudicated defect presence and exact severity: 8/8 for fresh, incremental, and automatic;
- automatic completion: 11/12 runs, 47/48 lanes, fallback 1/12;
- fresh completion: 12/12 runs, 60/60 lanes, no fallback;
- incremental completion: 10/12 runs, 43/48 complete lanes, fallback 2/12;
- automatic duplicate rate: 22.2%, versus fresh 37.5% and incremental 17.6%;
- paired automatic latency over nine operational pairs: −30.3s median delta, automatic faster or equal in 7/9.

The sole automatic partial was a no-prior `correctness-contracts` lane with all candidate fields present and valid except for an exact bold wrapper around the title value. The subsequent bounded parser correction accepts only exact non-nested bold title scalars and deterministically reclassifies the retained output as complete. Frozen V5 evidence is not rewritten, so V5 remains rejected and replacement evidence is required.
