# Automatic fresh versus incremental selection v6

Status: **complete; automatic defaulting rejected by retained harness failure**.

V6 replaced V5 after bounded normalization of exact non-nested bold title scalars. It retained source-bound prior severity, paired automatic latency, the same six selector cases, three strategies, and two repetitions.

- candidate: `fdd18697e78634c1653ff47fd0d07ed542bb322a`
- corpus SHA-256: `06b727f8bdcd69a2ad33a30c4f527dda9c2f014fccbc099beeb5c82009594754`
- plan ID: `ef342993d7ce6cacf58a4c62ca03cee5be8905e638dcbbabec61d2a6451645ab`
- plan SHA-256: `411d7f3fb6343eb3fe20d1fe324cac129fdc16826e9b2066fac380d65e4d08c3`

## Results

- 36/36 rows retained once in stored order, without reruns, skips, or substitutions;
- automatic selection events and relationships: 12/12 exact;
- automatic prior statuses: 8/8; still-open carry-forward: 4/4;
- adjudicated defect presence and exact severity: 8/8 for every strategy;
- no structurally partial lanes, validating the bold-title correction;
- fresh completion: 12/12 runs and 60/60 lanes;
- incremental completion: 12/12 runs and 48/48 lanes;
- automatic completion: 11/12 runs and 43/48 lanes, fallback 1/12;
- paired automatic latency across 11 operational pairs: +4.2s median delta, with automatic faster or equal in 5/11.

The failed automatic no-prior row reached the 900-second lane batch deadline, emitted visible fallback findings, and then did not terminate. The collector killed and retained it at the 1,230-second hard timeout. The row is retained without rerun, and automatic defaulting remains unreleased because absolute completion and paired-latency gates fail.

Post-campaign hardening reserves the configured secondary-attempt window before primary dispatch, so one hung primary cannot consume the entire batch and prevent its single host-authorized replacement from starting. This host workaround requires new immutable evidence; V6 remains unchanged and rejected.
