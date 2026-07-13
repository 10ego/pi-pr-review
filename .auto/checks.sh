#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test 2>&1 | tail -50
mode=plugin
if [[ -f .auto/last-bench-mode ]]; then
  mode=$(cat .auto/last-bench-mode)
fi
case "$mode" in
  plugin)
    REVIEW_BENCH_ROOT=$(cat .auto/last-bench-root) REVIEW_BENCH_PR=$(cat .auto/last-bench-pr) \
      python3 .auto/validate-review.py >/dev/null
    ;;
  full)
    REVIEW_BENCH_ROOT=$(cat .auto/last-bench-root) REVIEW_BENCH_PR=$(cat .auto/last-bench-pr) \
      python3 .auto/validate-review.py --full >/dev/null
    ;;
  raw)
    # Raw fallback cannot report extension-owned independent pass results.
    # Validate only its structured, diff-scoped final review and label it separately.
    REVIEW_BENCH_ROOT=$(cat .auto/last-bench-root) REVIEW_BENCH_PR=$(cat .auto/last-bench-pr) \
      REVIEW_EVENTS="$(pwd)/.auto/raw-last-review-events.jsonl" REVIEW_RESULT="$(pwd)/.auto/raw-last-review.json" \
      python3 .auto/validate-review.py --raw >/dev/null
    ;;
  major)
    REVIEW_BENCH_ROOT=$(cat .auto/last-bench-root) REVIEW_BENCH_PR=$(cat .auto/last-bench-pr) \
      python3 .auto/validate-review.py --major-only >/dev/null
    ;;
  balanced)
    REVIEW_BENCH_ROOT=$(cat .auto/last-bench-root) REVIEW_BENCH_PR=$(cat .auto/last-bench-pr) \
      python3 .auto/validate-review.py --balanced >/dev/null
    ;;
  *)
    echo "unknown review benchmark mode: $mode" >&2
    exit 2
    ;;
esac
