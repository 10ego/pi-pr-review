#!/bin/bash
set -euo pipefail

mode=${REVIEW_BENCH_MODE:-plugin}
if [[ $mode != plugin && $mode != full && $mode != raw && $mode != major && $mode != balanced ]]; then
  echo "unknown REVIEW_BENCH_MODE: $mode" >&2
  exit 2
fi
if [[ $mode != plugin && ${REVIEW_BENCH_SUITE:-ordinary} == large ]]; then
  echo "$mode benchmark mode currently supports only the ordinary PR workload" >&2
  exit 2
fi
if [[ $mode == plugin && ${REVIEW_BENCH_SUITE:-ordinary} == large ]]; then
  exec "$(dirname "$0")/measure-large.sh"
fi

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
rm -f .auto/last-review-events.jsonl .auto/last-review.json
printf '%s\n' "$root" > .auto/last-bench-root
printf '%s\n' 1 > .auto/last-bench-pr
printf '%s\n' "$mode" > .auto/last-bench-mode

start_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
review_command="/pr-review 1 --include-closed --no-comment"
if [[ $mode == full ]]; then
  review_command+=" --full"
elif [[ $mode == major ]]; then
  review_command+=" --major-only"
elif [[ $mode == balanced ]]; then
  review_command+=" --balanced"
fi
if [[ $mode == raw ]]; then
  # This intentionally loads no project extension. The prompt's documented
  # inline fallback performs the lenses in one raw Pi/model session.
  pi \
    --mode json \
    --print \
    --no-session \
    --no-extensions \
    --no-skills \
    --no-prompt-templates \
    --prompt-template "$root/prompts/pr-review.md" \
    --tools read,bash \
    --thinking xhigh \
    "/pr-review 1 --include-closed --no-comment" \
    > .auto/last-review-events.jsonl
else
  pi \
    --mode json \
    --print \
    --no-session \
    --no-extensions \
    --extension "$root/extensions/pr-review-subagent.ts" \
    --extension "$root/extensions/review-table.ts" \
    --no-skills \
    --no-prompt-templates \
    --prompt-template "$root/prompts/pr-review.md" \
    --tools read,bash,pr_review_verify,review_subagent,review_subagents \
    --thinking xhigh \
    "$review_command" \
    > .auto/last-review-events.jsonl
fi
end_ns=$(python3 -c 'import time; print(time.monotonic_ns())')

if [[ $mode == raw ]]; then
  cp .auto/last-review-events.jsonl .auto/raw-last-review-events.jsonl
  REVIEW_EVENTS="$root/.auto/raw-last-review-events.jsonl" REVIEW_RESULT="$root/.auto/raw-last-review.json" \
    python3 .auto/validate-review.py --raw --metrics
elif [[ $mode == full ]]; then
  python3 .auto/validate-review.py --full --metrics
elif [[ $mode == major ]]; then
  python3 .auto/validate-review.py --major-only --metrics
elif [[ $mode == balanced ]]; then
  python3 .auto/validate-review.py --balanced --metrics
else
  python3 .auto/validate-review.py --metrics
fi
python3 - "$start_ns" "$end_ns" <<'PY'
import sys
print(f"METRIC review_wall_ms={(int(sys.argv[2]) - int(sys.argv[1])) / 1_000_000:.3f}")
PY
