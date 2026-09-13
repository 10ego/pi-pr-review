# Conversation-aware cumulative incremental experiment v8

Status: **complete; automatic/default cumulative incremental rejected**.

- Corpus: `pi-pr-review-semantic-v8`
- Corpus SHA-256: `04782877a21f1171aa02b9e7f44e1d566bd6b824bcb81a2b5eaaabccf0702e8c`
- Plan ID: `e3135abe427bca181d885862c81b31ba76b866d9392af7c6a3bfecb86a78da77`
- Plan file SHA-256: `c5b6bc28642e745ffe7120c08754388142525b5ef9ae37f9af1b715d12cc3591`
- Mode: balanced
- Strategies: fresh, incremental
- Repetitions: 2
- Rows: 24

The six cases cover verified and false fix claims, valid and invalid rejection rationales, instruction-like reply text, an original-diff defect missed by the prior review, a new cross-file delta defect, and same-head missed-defect hunting. Collection followed the immutable protocol in `docs/incremental-experiment-v8.md`: all 24 rows completed with no reruns or substitutions.

Raw results: incremental relationship and exact-status accuracy were 12/12, required lanes completed 36/36, and cross-file recall was 2/2 versus fresh 1/2. Incremental reduced aggregate lane work by 38.7%, but had a higher duplicate rate (17.86% versus 13.95%) and 28.3% higher median total latency. The raw scorer also reported lower recall. `adjudication.json` records why all four raw misses were visibly present findings affected by strict severity or bounded-term matching; it does not change the frozen `report.json` or reverse the rejection decision.

Evidence integrity:

- private source bundle-manifest SHA-256: `add41254ae0aca158ac0f3d70c39739027e84c71bbaa0e8e7c25ebe8451ded90`
- sanitized bundle-manifest SHA-256: `651de51ad490e24368630150eae24e857ba3024ef622c7625460adf946fd7846`
- report SHA-256: `a42a708cf9bf222f53a5c287821878ca11aea5000cfdd9f9e32844eed4b1891c`
- scorer SHA-256: `b0390bfcde16d6e9159c4c765209751e480cf195f97650102c655eca04ca5c8e`
- privacy transformation: entry-scoped temporary paths were redacted recursively inside embedded session payloads; see `privacy-transform.json`

The raw bundle can be reproduced with:

```sh
npm run benchmark:review -- score \
  --corpus tests/benchmarks/review-semantic/corpus-v8.json \
  --plan tests/benchmarks/review-semantic/incremental-v8/plan.json \
  --results tests/benchmarks/review-semantic/incremental-v8/bundle \
  --output /tmp/incremental-v8-report.json

cmp /tmp/incremental-v8-report.json \
  tests/benchmarks/review-semantic/incremental-v8/report.json

(cd tests/benchmarks/review-semantic/incremental-v8 && \
  shasum -a 256 -c run-manifest.sha256)
```

## Excluded pilots

No pilot row is part of this plan or may enter final evidence. Disposable plans exposed and corrected: missing cumulative pass/lens bindings; a collector parser that omitted `rejected`; a supposed clean rejection fixture that changed an exported API and then behavior; free-form prior-status omission; premature delta-lane registration for empty/failing compares; and unbound gap context. The corrected implementation uses structured host-bound statuses, byte-for-byte GitHub full-diff verification for the required gap lane, compatible clean fixtures, and explicit paired metrics. The final corpus and plan hashes above were generated only after both an ancestor and same-head real-model pilot completed with canonical artifacts and exact statuses.
