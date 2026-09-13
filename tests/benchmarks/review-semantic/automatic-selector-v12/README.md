# Automatic selector v12 evidence

Status: **complete; precommitted automatic-defaulting gates passed**.

- candidate: `5ea22b4521e90a927b9e4ba27255e6a38d40744a`
- frozen plan: `7678b67`
- corpus SHA-256: `b58dd8a9ff439466694d5dfa6be0beed14b1bc350bd8d2db00fa85c72b02bd38`
- plan ID: `154b1d4f72734d60d11cf6b6023104e54e27a03fa9ddfb1990dfa319aefd3db3`
- plan SHA-256: `13d9144e5b4581f7ac3fecda1756ba681e01b136cb6a092831a0c2bf0f756271`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order. Automatic selection was exact 12/12, automatic statuses were exact 8/8, all 156 lanes completed, all 12 pairs were operational, and no strategy used fallback. Adjudicated defect presence and exact severity were 8/8 for every strategy. Automatic and corresponding fresh each had one clean-control finding in the same repetition; duplication was zero.

The paired automatic-minus-corresponding-explicit median was −5.686 seconds (−7.0%). Automatic p95 was 232.817 seconds versus 350.962 seconds for corresponding explicit rows. The precommitted operational, quality, duplication, fallback, and latency gates pass.
