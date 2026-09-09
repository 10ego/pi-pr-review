# Conversation-aware cumulative incremental experiment v8

Status: **24-row plan frozen; collection pending**.

- Corpus: `pi-pr-review-semantic-v8`
- Corpus SHA-256: `ec27dedb58b484f6ec8a4a13abeb4c8fe77e0d90b0d91ff7c43d4cf3306365a7`
- Plan ID: `e4691cb15d1c2b949852b2a0f9ca5f845eb3d6a9f1ee13cb53589e8ed06cd385`
- Plan file SHA-256: `66445acbd5d15b667c08ef14d7b0c85b37e921213066f1f89acd659495c1664a`
- Mode: balanced
- Strategies: fresh, incremental
- Repetitions: 2
- Rows: 24

The six cases cover verified and false fix claims, valid and invalid rejection rationales, instruction-like reply text, an original-diff defect missed by the prior review, a new cross-file delta defect, and same-head missed-defect hunting. Collection follows the immutable protocol in `docs/incremental-experiment-v8.md`.
