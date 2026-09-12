# Automatic fresh versus incremental selection v4

Status: **frozen; collection not started**.

V4 is the replacement for externally interrupted V3. It uses the same source-bound prior severity rule, paired automatic latency metric, six selector cases, three strategies, and two repetitions. Rows are collected in stored order using bounded command batches so the top-level harness deadline cannot interrupt the full campaign command.

- candidate: `9558a0637a868e3a50e94cb6d7f090cde94473e9`
- corpus SHA-256: `110baeb5f6ebe073cd04af4adf0d385abf629621ebe3e0646bb5d80de4ac6fff`
- plan ID: `1df2b5c58265c8cfe57a15df1ad2153627d80b82dac3e83a58cdd29149ce2e7f`
- plan SHA-256: `265e0a35f1432f25aa54eebcff97904b218911f39e4ac9c553055f09e597a1f4`

Release gates are unchanged from V3.
