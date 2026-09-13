# Automatic selector v10 evidence

Status: **complete; automatic defaulting rejected by two operational failures**.

- runtime fix: `5443a06e3a28e2f7a35c989b5e59a3a85595a8586`
- frozen plan: `70479d4`
- corpus SHA-256: `1b3e8e197339e6762235d2f56a285c32d663ed7501cf76f21459222585a5a8bf`
- plan ID: `7c1f3b8f665a11aaeba742413b3b5d692c124cdbe16ed51fea4c8974392fe41b`
- plan SHA-256: `dd9abaadbd2f71a45b879c93b3a5a18d03834cddecb4e8d4bc835c5da63a08ed`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order without reruns, skips, substitutions, or rewriting. Automatic relationships were exact 12/12 and automatic prior statuses were exact 8/8. Universal fresh host finalization fixed V9's diverged fallback: fresh lanes completed 60/60 with no fallback.

V10 still failed closed. Automatic same-head row `5cf2a83700549d0113b83e1a` completed and host-finalized both lanes, but the parent attempted a benchmark-disallowed direct GitHub reviews read, invalidating its audit. Explicit incremental row `b1f1a2220335fd3764ea6d06` received a provider policy error with malformed partial gap output; the host retained the lane as partial and degraded publication because incremental lanes have no generic canonical replacement path. The campaign therefore had 10/12 automatic operational pairs, 46/48 automatic lanes complete, and automatic fallback 1/12.

The ten operational automatic pairs had a favorable -10.846-second (-11.4%) median delta. Automatic p95 was 306.472 seconds versus 487.851 seconds for corresponding explicit rows. These cannot override the absolute operational gates. Automatic defaulting remains unreleased.
