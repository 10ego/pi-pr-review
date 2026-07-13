#!/bin/bash
set -euo pipefail

harness=$(cd "$(dirname "$0")/.." && pwd)
workload=${LARGE_REVIEW_REPO:-/Users/10ego/projects/NERVous-system}
pr=${LARGE_REVIEW_PR:-4}
events="$harness/.auto/last-review-events.jsonl"
result="$harness/.auto/last-review.json"
rm -f "$events" "$result"
printf '%s\n' "$workload" > "$harness/.auto/last-bench-root"
printf '%s\n' "$pr" > "$harness/.auto/last-bench-pr"
printf '%s\n' plugin > "$harness/.auto/last-bench-mode"

start_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
cd "$workload"
pi \
  --mode json \
  --print \
  --no-session \
  --no-extensions \
  --extension "$harness/extensions/pr-review-subagent.ts" \
  --extension "$harness/extensions/review-table.ts" \
  --no-skills \
  --no-prompt-templates \
  --prompt-template "$harness/prompts/pr-review.md" \
  --tools read,bash,pr_review_verify,review_subagent,review_subagents \
  --thinking xhigh \
  "/pr-review $pr --include-closed --no-comment" \
  > "$events"
end_ns=$(python3 -c 'import time; print(time.monotonic_ns())')

cd "$harness"
REVIEW_BENCH_ROOT="$workload" REVIEW_BENCH_PR="$pr" REVIEW_EVENTS="$events" REVIEW_RESULT="$result" \
  python3 .auto/validate-review.py --metrics
python3 - "$start_ns" "$end_ns" <<'PY'
import sys
print(f"METRIC review_wall_ms={(int(sys.argv[2]) - int(sys.argv[1])) / 1_000_000:.3f}")
PY
