# Automatic fresh versus incremental selection v4

Status: **invalid incomplete collection; no release decision permitted**.

V4 replaced externally interrupted V3 and retained the same source-bound severity and paired-latency corrections. The first 17 rows were retained once in order. A provider-failure row consumed most of a six-row batch, after which the top-level 1,800-second execution limit interrupted row 18 before retention. It was not rerun; later rows were never attempted.

The result demonstrates that bounded multi-row batches are still unsafe. A replacement campaign must use a new identity and a detached sequential runner or one host command per row so top-level command deadlines cannot interrupt collection.
