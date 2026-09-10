# Incremental v10 evidence

Invalidated immutable 24-row campaign after v9 collector invalidation. All rows remain retained without reruns.

- runtime: `6cf2354`
- collector: `2adb06c`
- corpus SHA-256: `0cf8605d8a7be22738c7d40cad360657f12a752caff49d69c1e1ea923ef15223`
- plan ID: `d0ab5a97c9b1be67e1cd177da7f10ebd9b79664e2f30a0539f3935da2ad08ee7`
- plan SHA-256: `e43f897634b47bef5ef9e78a40d42d466711c62cdc115238d7b2551e0fd4ac67`
- model: `openai-codex/gpt-5.6-sol`, medium effort

Every row was executed once in stored order. The campaign was invalidated because its lifecycle check incorrectly passed host-finalized JSON through the Markdown parser. See `docs/incremental-experiment-v10.md`; the raw report must not be used for product decisions.
