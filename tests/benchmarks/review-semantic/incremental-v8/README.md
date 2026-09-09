# Conversation-aware cumulative incremental experiment v8

Status: **24-row plan frozen; collection pending**.

- Corpus: `pi-pr-review-semantic-v8`
- Corpus SHA-256: `04782877a21f1171aa02b9e7f44e1d566bd6b824bcb81a2b5eaaabccf0702e8c`
- Plan ID: `e3135abe427bca181d885862c81b31ba76b866d9392af7c6a3bfecb86a78da77`
- Plan file SHA-256: `c5b6bc28642e745ffe7120c08754388142525b5ef9ae37f9af1b715d12cc3591`
- Mode: balanced
- Strategies: fresh, incremental
- Repetitions: 2
- Rows: 24

The six cases cover verified and false fix claims, valid and invalid rejection rationales, instruction-like reply text, an original-diff defect missed by the prior review, a new cross-file delta defect, and same-head missed-defect hunting. Collection follows the immutable protocol in `docs/incremental-experiment-v8.md`.

## Excluded pilots

No pilot row is part of this plan or may enter final evidence. Disposable plans exposed and corrected: missing cumulative pass/lens bindings; a collector parser that omitted `rejected`; a supposed clean rejection fixture that changed an exported API and then behavior; free-form prior-status omission; premature delta-lane registration for empty/failing compares; and unbound gap context. The corrected implementation uses structured host-bound statuses, byte-for-byte GitHub full-diff verification for the required gap lane, compatible clean fixtures, and explicit paired metrics. The final corpus and plan hashes above were generated only after both an ancestor and same-head real-model pilot completed with canonical artifacts and exact statuses.
