# Topology experiment v6 evidence

Immutable 72-run balanced/full/deep comparison for `pi-pr-review-semantic-v6`.

- Plan ID: `a6487655d69a59d48a53d3f455fd2985780d14cea9a276e9543c21db6426af3f`
- `plan.json` SHA-256: `6347c6a90e4df76518908789978d4fa46635d4f8408e7c0e2699706b998dc930`
- `report.json` SHA-256: `0db10a7d791e43c91f8621c7e4f91aa4baf31ee2f56f834848ed2728f131940c`
- `summary.json` SHA-256: `aadc3e57992250b5e0ae3d9d6382d2ce299c797830e407e69e4d5766b80aae41`
- Sanitized `run-manifest.sha256` SHA-256: `9938234904e7a8268a2290c41c5fbf4e65331b11065e4fce9ef209bba10e53bb`
- Private source run-manifest SHA-256: `d2d1d5fc13db8cb1e283ac775c752ebb0965b3d856ba8b3f57bc1e6c4ced63a5`
- Privacy sanitizer SHA-256: `58903ced1e70bcf8c48203ab25752f103a723989c687fb3c73ee5429fe6e5b26`
- Results: 72/72 exact planned rows, two repetitions, 24 rows per mode.

Each committed run is a deterministic privacy-sanitized derivative of one atomically installed private JSON envelope containing both hash-bound artifact payloads. `privacy-transform.json` binds the private source manifest, exact sanitizer, sanitized manifest, and unchanged report. Local account names and host-specific `/var/folders` paths are removed; semantic content, timing, lifecycle, and GitHub audit metrics are unchanged. `bundle/effective-review-config.json` and `bundle/plan.json` bind the shared configuration and order. The report remains diagnostic (`baseline_required`) because no absolute gate exists.

Decision: **REJECT deep topology retention** under the rule frozen in `docs/topology-experiment-v6.md`. Deep passed all semantic recall, clean-control, lane-completion, fallback, and p50 conditions, but failed duplicate rate, p95/variance, and repeated large-case integration requirements. No default or full-mode topology change is authorized by this evidence.
