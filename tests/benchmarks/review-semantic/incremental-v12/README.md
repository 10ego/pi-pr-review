# Incremental v12 evidence

Invalidated immutable 24-row campaign. All rows remain retained without reruns.

- runtime: `6cf2354`
- collector/scorer: `649cb17`
- corpus SHA-256: `764281a0bbc6bd8059be7ad22cf6d9b862b2fea98736a20bef696fe925b9c6db`
- plan ID: `3864b3285db35edc2775bdc2302ef7a0df8ad7d4d02a7fa387886ca06816bbac`
- plan SHA-256: `0c53290bead6b0a654c64f51526fc8efaa9e60f407a8161d2c57f08d6b948ac4`
- model: `openai-codex/gpt-5.6-sol`, medium effort

Every row was executed once in stored order. The campaign was invalidated because the shared lifecycle binding omitted the ordinary host-normalization path where terminal text equals `publicationBody` and `rawText` is canonicalized. See `docs/incremental-experiment-v12.md`; the report cannot support product decisions.
