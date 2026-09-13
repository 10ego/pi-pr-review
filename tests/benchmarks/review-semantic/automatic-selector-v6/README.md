# Automatic selector v6 evidence

Status: **complete; automatic defaulting rejected by retained harness failure**.

- candidate: `fdd18697e78634c1653ff47fd0d07ed542bb322a`
- corpus SHA-256: `06b727f8bdcd69a2ad33a30c4f527dda9c2f014fccbc099beeb5c82009594754`
- plan ID: `ef342993d7ce6cacf58a4c62ca03cee5be8905e638dcbbabec61d2a6451645ab`
- plan SHA-256: `411d7f3fb6343eb3fe20d1fe324cac129fdc16826e9b2066fac380d65e4d08c3`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order through the detached sequential collector, without reruns, skips, or substitutions. Selection events and relationships were exact 12/12; automatic statuses were 8/8 and carry-forward 4/4. Adjudicated defect presence and exact severity were 8/8 for every strategy. There were no structural partial lanes, confirming the bounded bold-title fix.

One automatic no-prior row consumed the 900-second lane batch deadline, produced visible fallback findings, and then failed to terminate; the collector retained it at its 1,230-second hard timeout. Automatic operational completion was consequently 11/12, with 43/48 complete lanes and fallback 1/12. Over the 11 operational corresponding pairs, median automatic latency delta was +4.2s. Automatic defaulting remains unreleased. This is a Pi/provider lifecycle limitation rather than a remaining selector or candidate-parser defect; the failed row is retained without rerun.
