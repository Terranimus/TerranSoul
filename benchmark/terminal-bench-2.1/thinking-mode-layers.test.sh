#!/usr/bin/env bash
# EVERY LAYER THAT NAMES A DEFAULT THINKING MODE MUST NAME THE SAME ONE.
#
# ⛔ THE DEFECT THIS PINS, and it has already happened twice in this repo.
#
# 1. mcp-auth-proxy.mjs's own comment records the first occurrence: "This
#    default previously read `max` while run-sweep.sh exported `think`, so the
#    sweep was correct and anyone invoking run-dg.sh DIRECTLY silently got max.
#    Two layers disagreeing about the same setting is how a `think` run gets
#    published as a `max` one."
#
# 2. 2026-09-06, changing the proxy default think -> chat: three run-sweep*.sh
#    scripts EXPORT the mode explicitly, so the proxy default is dead code on
#    every path that goes through them. A change made only in the proxy would
#    have been a change that CANNOT FIRE on a real sweep — and would have read,
#    in the log, exactly like one that took effect.
#
# There is a third layer that is not an env var at all: run-dg.sh picks the
# sentence describing search COST to the agent from the same variable. If that
# disagrees, the instruction promises the agent a rung the proxy is not sending.
#
# WHY IT FAILS ON THE PRE-CHANGE TREE: run-sweep*.sh exported `think` while the
# proxy defaulted to `chat`, so `layers_agree` reports proxy=chat sweep=think.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected [$2] got [$3]"; fails=$((fails+1)); fi; }

proxy="$(sed -n "s/^const THINKING_MODE = (process.env.TB_THINKING_MODE || '\([a-z]*\)').*/\1/p" "$HERE/mcp-auth-proxy.mjs")"
rung="$(sed -n 's/^_rung="\${TB_THINKING_MODE:-\([a-z]*\)}"/\1/p' "$HERE/run-dg.sh")"

echo "== the proxy names a default at all =="
case "$proxy" in
  chat|think|research|max) check "proxy default parsed" "yes" "yes" ;;
  *) check "proxy default parsed" "yes" "no (got [$proxy])" ;;
esac

echo "== run-dg.sh's instruction rung matches the proxy =="
check "run-dg.sh _rung == proxy default" "$proxy" "$rung"

echo "== every run-sweep* export matches the proxy =="
for f in "$HERE"/run-sweep.sh "$HERE"/run-sweep.next.sh "$HERE"/run-sweep.par.sh; do
  [ -f "$f" ] || continue
  got="$(sed -n 's/^export TB_THINKING_MODE="\${TB_THINKING_MODE:-\([a-z]*\)}".*/\1/p' "$f")"
  check "$(basename "$f") export == proxy default" "$proxy" "$got"
done

echo
if [ "$fails" -eq 0 ]; then echo "thinking-mode-layers.test.sh: ALL PASS"; else echo "thinking-mode-layers.test.sh: $fails FAILURE(S)"; fi
exit "$fails"
