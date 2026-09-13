# Automatic selector v11 evidence

Status: **complete; automatic defaulting rejected by one corresponding explicit failure**.

- candidate: `e05a79faaa75111bb005ec64633893677424fb5c`
- frozen plan: `ab225a9`
- corpus SHA-256: `2fbeee62bacd55e372511ffd43adcafce048783d8a1df7276d2cd65c289a665f`
- plan ID: `b030c8b1f4ebb858fa2e1c62ccb77bf5eb7538c62ed04d935fa597efd52b81e0`
- plan SHA-256: `159cad6a0f4f20690c7351eb40485c705f8449f5124b853bc44131faa31ee1db`
- model: `openai-codex/gpt-5.6-sol`, medium effort

All 36 rows were collected exactly once in stored order. Automatic selection was exact 12/12, automatic statuses were exact 8/8, automatic and incremental lanes completed 48/48, and neither strategy used fallback. Adjudicated defect presence and exact severity were 8/8 for every strategy.

V11 failed because corresponding explicit fresh no-prior row `976b306437c8e2d89961a518` completed all five child lanes but spent several minutes on parent shell validation until review authority cleared before host finalization. Its visible findings were retained, but the session had no valid host completion and failed closed. Only 11/12 planned automatic pairs were operational.

The eleven operational pairs had a -5.147-second (-5.0%) median delta. Automatic p95 was 155.228 seconds versus 153.779 seconds for corresponding explicit rows, which also narrowly fails the no-p95-regression gate. Automatic defaulting remains unreleased.
