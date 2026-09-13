# Automatic fresh versus incremental selection v7

Status: **complete; post-hardening absolute completion passed; automatic defaulting rejected by paired latency**.

V7 evaluates the candidate containing the host-side deadline reservation and one-shot targeted fresh-lane recovery introduced in `c650531`. It uses a newly frozen corpus/plan identity while retaining the same six selector cases, three strategies, two repetitions, source-authoritative prior handling, and paired automatic latency policy.

- candidate: `50688b107f4646b420ba459fdd92920ee0cad1f9`
- lifecycle fix: `c650531ee0a33eaf863afc350078b66ccc5f66d0`
- corpus SHA-256: `818af2be9bc6a5ab86c760d288d6b849f679e1953ead3507006dec716a136450`
- plan ID: `45c1777b2edee4a78020ae59c524dd35c624a12917a9be16535649d6c8763722`
- plan SHA-256: `026ae92c7f4a792c7a9f0db2fc0354b23342d1fd3f68eca402576435ced54c88`
- model: `openai-codex/gpt-5.6-sol`, medium effort

## Results

- 36/36 rows retained exactly once in stored order, without reruns, skips, or substitutions;
- automatic selection events and relationships: 12/12 exact;
- automatic prior statuses: 8/8; still-open carry-forward: 4/4;
- adjudicated defect presence and exact severity: 8/8 for every strategy;
- fresh completion: 12/12 runs and 60/60 lanes;
- incremental completion: 12/12 runs and 48/48 lanes;
- automatic completion: 12/12 runs and 48/48 lanes;
- automatic fallback: 0/12;
- corresponding explicit fallback: 0/12;
- automatic duplicates: 1, versus 3 across corresponding explicit rows;
- clean-control false-positive runs: 0 for automatic and 0 across corresponding explicit rows;
- paired automatic latency: +9.626s median delta, with automatic faster or equal in 4/12 pairs.

The absolute lifecycle failure seen in V6 did not recur: every automatic run and every required automatic lane completed, no fallback artifact was required, and no collector hard timeout occurred. Because no lane timed out, this campaign establishes post-hardening absolute completion but does not exercise the targeted recovery path; that path remains covered by deterministic subprocess lifecycle tests.

Four raw semantic matcher misses were visibly equivalent findings: three source-authoritative locationless carry-forwards of the tenant-ownership blocker, and one anchored automatic finding that explicitly described cross-tenant retrieval after removing `ctx.tenantId` from the query. `adjudication.json` records these decisions separately; the immutable rows and raw report remain unchanged.

Automatic defaulting remains unreleased. Although selection, prior handling, operational completion, adjudicated quality, duplication, and fallback gates pass, the release policy in force for V7 required a non-positive median within-pair automatic latency delta. V7 measured +9.626s, so it cannot authorize defaulting.

After V7 was frozen and reviewed, the product owner prospectively accepted bounded selector latency in exchange for automatic strategy selection. The next campaign—not V7—uses the precommitted policy of at most +15 seconds and +20% median paired overhead with no automatic p95 regression. All non-latency gates remain unchanged.
