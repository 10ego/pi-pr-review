# Automatic selector v7 evidence

Status: **complete; post-hardening absolute completion passed; automatic defaulting rejected by paired latency**.

- candidate: `50688b107f4646b420ba459fdd92920ee0cad1f9`
- lifecycle fix: `c650531ee0a33eaf863afc350078b66ccc5f66d0`
- corpus SHA-256: `818af2be9bc6a5ab86c760d288d6b849f679e1953ead3507006dec716a136450`
- plan ID: `45c1777b2edee4a78020ae59c524dd35c624a12917a9be16535649d6c8763722`
- plan SHA-256: `026ae92c7f4a792c7a9f0db2fc0354b23342d1fd3f68eca402576435ced54c88`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order through the detached sequential collector, without reruns, skips, or substitutions. Automatic selection events and relationships were exact 12/12; automatic statuses were 8/8 and carry-forward 4/4. Adjudicated defect presence and exact severity were 8/8 for every strategy.

The post-hardening candidate passed its absolute lifecycle gates: automatic operational completion was 12/12, all 48/48 required automatic lanes completed, and automatic fallback was 0/12. No lane timed out, so the campaign did not exercise targeted recovery; deterministic subprocess tests cover that path. Across corresponding explicit rows, automatic duplication was lower (1 versus 3), with no clean-control false positives in either cohort.

Automatic defaulting remains rejected because the median within-pair automatic latency delta was +9.626 seconds, with automatic faster or equal in 4/12 pairs. The required release threshold is non-positive. The campaign is retained unchanged and does not authorize release.
