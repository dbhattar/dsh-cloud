#!/bin/sh
# Regression runner. Usage: tests/run.sh [unit|phase1|phase2|phase3|phase4|phase5|all]   (default: all)
# phase1-phase5 start Docker stacks on host port 443, so they run one after another.
set -eu
cd "$(dirname "$0")/.."
T="node --test --test-concurrency=1"
case "${1:-all}" in
  unit)   $T "tests/gateway/*.test.mjs" "tests/runner/*.test.mjs" "tests/llm-proxy/*.test.mjs" "tests/egress-proxy/*.test.mjs" "tests/sandbox/*.test.mjs" "tests/scripts/*.test.mjs" ;;
  phase1) $T "tests/phase1/*.test.mjs" ;;
  phase2) $T "tests/phase2/*.test.mjs" ;;
  phase3) $T "tests/phase3/*.test.mjs" ;;
  phase4) $T "tests/phase4/*.test.mjs" ;;
  phase5) $T "tests/phase5/*.test.mjs" ;;
  all)    $T "tests/gateway/*.test.mjs" "tests/runner/*.test.mjs" "tests/llm-proxy/*.test.mjs" "tests/egress-proxy/*.test.mjs" "tests/sandbox/*.test.mjs" "tests/scripts/*.test.mjs" "tests/phase1/*.test.mjs" "tests/phase2/*.test.mjs" "tests/phase3/*.test.mjs" "tests/phase4/*.test.mjs" "tests/phase5/*.test.mjs" ;;
  *) echo "usage: $0 [unit|phase1|phase2|phase3|phase4|phase5|all]" >&2; exit 2 ;;
esac
