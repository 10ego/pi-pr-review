# Automatic selector v11 plan

Status: **prospectively frozen; no rows collected**.

- candidate: `e05a79faaa75111bb005ec64633893677424fb5c`
- corpus SHA-256: `2fbeee62bacd55e372511ffd43adcafce048783d8a1df7276d2cd65c289a665f`
- plan ID: `b030c8b1f4ebb858fa2e1c62ccb77bf5eb7538c62ed04d935fa597efd52b81e0`
- plan SHA-256: `159cad6a0f4f20690c7351eb40485c705f8449f5124b853bc44131faa31ee1db`
- model: `openai-codex/gpt-5.6-sol`, medium effort

The 36 balanced fresh/incremental/automatic rows use two repetitions of the six retained relationship scenarios. Collection is exact-once and stored-order. Failures remain immutable; no row may be rerun, substituted, skipped, or rewritten.
