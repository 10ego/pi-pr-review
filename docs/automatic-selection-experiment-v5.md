# Automatic fresh versus incremental selection v5

Status: **frozen; collection not started**.

V5 replaces interrupted V4 without changing the candidate behavior, semantic cases, or gates. A detached sequential collector isolates the campaign from top-level host command limits while preserving stored order and exact-once row collection.

- candidate: `9558a0637a868e3a50e94cb6d7f090cde94473e9`
- corpus SHA-256: `afadda8cf975e7fe1a4fd5c788c6aaaea56f8be7f48d4f0725238d27ad4bbdc2`
- plan ID: `94b9f16b7bf4d9d6cce3b9e126b9afa4410e93656a22ff64799121c0016822b0`
- plan SHA-256: `872f1396b2936c2cbc817072d01857031bb1f81c80aa4aeaa1b6bb50dfcc9426`

Release gates remain exact selector/prior behavior, 100% operational and lane completion, no-worse adjudicated semantic quality/duplication/fallback, and non-positive median paired automatic latency delta.
