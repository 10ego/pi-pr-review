# Direct and compacted specialist forks

**Use direct forks by default.** They finished first in every completed pair. Both arms detected six of ten reference-defect opportunities across the five pairs. One additional checkpoint was too small for Pi to compact at its stock retention setting.

## Results

| Recent tokens retained | Paired trials | Direct wall time | Compact wall time | Direct estimated cost | Compact estimated cost | Reference defects detected, direct / compact |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 20,000 (Pi default) | 1 | 54.1 s | 68.9 s | $0.216 | $0.203 | 2 of 2 / 2 of 2 |
| 512 | 4 | 212.4 s | 310.1 s | $0.807 | $0.943 | 4 of 8 / 4 of 8 |

Times and costs are sums over paired trials. With stock retention, PR #88 cost about 6% less to compact and took 15 seconds longer. Pi declined compaction on PR #92. Its direct run took 47.0 seconds, cost an estimated $0.258 and found one of two reference defects. That unpaired result is excluded from the table.

With 512 recent tokens retained, compaction added 46% wall time and 17% estimated cost across the four trials. Direct specialists reported a cache read on four of eight first requests. Compacted specialists reported a cache read on two of eight. Across all turns, direct arms recorded 951,552 cache-read tokens and compact arms recorded 701,952. Both recorded zero cache-write tokens. With stock retention, neither arm reported a first-request hit on the completed pair. Pi native forks establish shared history; the provider decides how much of each request it can serve from cache.

At 512 tokens, direct specialists issued 24 reads of files already read during general review, versus 22 after compaction. On the stock-retention pair the counts were seven and eight. The most informative quality difference was on PR #92. One compacted run found the JSON repair regression while overlooking the duplicate declaration caught by both direct runs. Each reported finding in the five completed pairs mapped to a confirmed defect. The data covers two PRs and one model. It leaves open whether compaction pays off for much larger histories or larger specialist groups.

An earlier two-PR development run used a replacement system prompt. The measurements above use the plugin's appended system instructions.

## Method

Each paired trial starts from a public historical PR head archived without Git history. The general reviewer receives the parent-to-head diff, traces relevant code, then completes a second general-review turn in the same Pi session. Both arms use that exact saved checkpoint. In the direct arm two specialists fork it immediately. In the compact arm Pi first compacts a private copy, then the same specialists fork that copy. The specialist instructions are appended as the next user message. One specialist reviews lifecycle and ordering, the other reviews API and integration contracts.

The pilot used Pi 1.5.2 with `openai-codex/gpt-6-sol`, low thinking, and the built-in read, grep, find and ls tools. Each arm runs its specialists concurrently. The order switches between PRs. Automatic compaction and retries were disabled so a direct arm could not compact itself. The pilot covers the shared review and specialist batch. GitHub discovery, the light overview, final synthesis and publication are outside these measurements.

Wall time charges both arms for the same general review and includes manual compaction in the compact arm. Costs are Pi's estimates from provider-reported usage. Cache reads include the general review and subsequent tool turns. The first specialist request is recorded separately because it measures reuse before a specialist can warm its own history. A file reread means a specialist issued a read for a path the general reviewer had already read. The line ranges can differ.

## Quality rubric

The reviewers only received code from the historical head and its diff. Four independently confirmed major defects serve as reference findings. Each arm receives credit once per defect per PR even when both specialist reports mention it.

| Historical PR | Reference findings | Subsequent fixes |
| --- | --- | --- |
| #88 | The batch schema omitted the deep-review output contract. Cache restoration lost that contract. | [PR #90](https://github.com/10ego/pi-pr-review/pull/90) |
| #92 | A duplicate function implementation prevented extension loading. The new Markdown completion rule rejected valid JSON output repair. | [PR #94](https://github.com/10ego/pi-pr-review/pull/94), [PR #96](https://github.com/10ego/pi-pr-review/pull/96) |

## Reproducing the comparison

From the repository root, point `PI_CODING_AGENT_DIR` at an isolated Pi configuration with access to the selected provider. Use `compaction.enabled: false` and `retry.enabled: false` for these manual comparisons. Set `compaction.keepRecentTokens` to 512 for the aggressive setting, or leave it at Pi's default of 20,000. The runner makes real model calls and creates a new evidence directory for each run.

```sh
bun tests/tooling/review-fork-pilot.ts "$(command -v pi)" openai-codex/gpt-6-sol /tmp/review-fork-ab AB
bun tests/tooling/review-fork-pilot.ts "$(command -v pi)" openai-codex/gpt-6-sol /tmp/review-fork-ba BA
```

Each raw run includes the shared-checkpoint checksum, assistant outputs, tool reads, per-call usage and wall time. The runner verifies each specialist received a distinct Pi session ID and inherited its source checkpoint entries before appending its own turn. If Pi considers a session too short to compact, the runner records a skipped compact arm. The plugin resumes from the full checkpoint in that case. The [recorded pilot data](../tests/benchmarks/fork-pilot.json) retains the totals and specialist reports for this comparison.
