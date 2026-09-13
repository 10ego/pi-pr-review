# Automatic selector v10 plan

Status: **prospectively frozen; no rows collected**.

- runtime fix: `5443a06e3a28e2f7a35c989b5e59a3a85595a8586`
- candidate: `8b8d32372644879652c0beee1e111d09c14e56b4`
- corpus SHA-256: `1b3e8e197339e6762235d2f56a285c32d663ed7501cf76f21459222585a5a8bf`
- plan ID: `7c1f3b8f665a11aaeba742413b3b5d692c124cdbe16ed51fea4c8974392fe41b`
- plan SHA-256: `dd9abaadbd2f71a45b879c93b3a5a18d03834cddecb4e8d4bc835c5da63a08ed`
- model: `openai-codex/gpt-5.6-sol`, medium effort

The 36 balanced fresh/incremental/automatic rows use two repetitions of the six V9 relationship scenarios. Collection is exact-once and stored-order. Failures remain immutable; no row may be rerun, substituted, skipped, or rewritten.
