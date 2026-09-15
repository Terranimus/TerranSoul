#!/usr/bin/env bash
# run-dg.sh carried two assumptions that are correct for ONE sequential runner
# and destructive for N parallel workers. Both were found on 2026-08-06 after
# 40 k=2 trials died with `NonZeroAgentExitCodeError (exit 137)` inside
# harbor's _setup_agent — a signature that reads exactly like an out-of-memory
# kill and is not one.
#
#  1. CONTAINER REAP. `docker ps -a | grep env-main | xargs docker rm -f` ran at
#     the start of every task, so worker B force-removed worker A's LIVE
#     container. Evidence it was never memory: victims died 5-38s into setup,
#     `dmesg` had zero OOM records, and live containers sat at 40-94 MiB against
#     a 2 GiB cap.
#  2. MCP CONFIG PATH. All workers rendered their proxy port into ONE shared
#     file, so a container could be pointed at another worker's proxy — which
#     mis-attributes brain calls and rips out brain access when that worker's
#     task ends.
#
# ⛔ THIS FILE USED TO RUN AGAINST THE REAL DOCKER ENGINE, and its case 5 ran
# run-dg.sh's whole-suite branch -- `docker ps -a | grep env-main | xargs docker
# rm -f`, every trial container on the host, live ones included. Run beside a
# sweep, that is the 2026-09-15 18:45 incident: a test's real `docker rm -f`
# SIGKILLed two live trials (pytorch-model-cli, 16,125 output tokens;
# winning-avg-corewars, 11,402). The docker here is hermetic-shims.sh's logging
# shim, answering from a fixture file whose rows carry an explicit status, and
# the guard ABORTS unless docker/netstat/ss/taskkill resolve inside this test's
# temp dir. The reap functions still come from run-dg.sh's own bytes, CR-
# stripped first so case 6's end-anchored range closes whatever an awk does with
# CRLF, and a probe longer than 250 lines is refused instead of being run.
#
# WHY THIS TEST CAN FAIL (rules/tests-must-be-able-to-fail.md): cases 1-2 run
# the REAL reap function scoped to a task this invocation owns, over one
# container it owns and one it does not; the pre-2026-08-06 blanket reap removes
# both, so case 2 goes red. Case 2b FAILS ON af23a5a4: the task name went into
# the grep -E alternation raw, so `ptest.dot` also reaped `ptestxdot__...`.
# Case 5b FAILS ON af23a5a4: the whole-suite branch removed containers in every
# state, so the RUNNING `ptest-live` and the `created` `ptest-starting` were
# destroyed. Case 4 greps for the per-port config path, absent before
# 2026-08-06. Case 5 asserts the whole-suite fallback still reaps EXITED trial
# containers, so a "fix" that simply deletes the reap also fails.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DG="${TB_RUN_DG:-$HERE/run-dg.sh}"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "parallel-isolation:"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
. "$HERE/hermetic-shims.sh" || { echo "ABORT: hermetic-shims.sh not found next to this test"; exit 2; }
hermetic_shims "$TMP" || { echo "ABORT: could not create the hermetic shims"; exit 2; }
hermetic_guard "$TMP" || exit 2
export HERMETIC_DOCKER_PS="$TMP/containers.txt" HERMETIC_DOCKER_NETWORKS="$TMP/networks.txt"
: > "$HERMETIC_DOCKER_PS"; : > "$HERMETIC_DOCKER_NETWORKS"

DG_LF="$TMP/run-dg.lf.sh"
tr -d '\r' < "$DG" > "$DG_LF"

has() { awk -v n="$1" '$2==n{f=1} END{exit !f}' "$HERMETIC_DOCKER_PS"; }
reap_src="$(awk '/^_reap_stale_containers\(\) \{/,/^\}/' "$DG_LF")"
if [ -z "$reap_src" ]; then
  # Pre-2026-08-06 tree: no function exists, the reap is a bare blanket pipeline.
  reap_src='_reap_stale_containers() { docker ps -a --format "{{.Names}}" | grep -E "env-main" | xargs -r docker rm -f >/dev/null 2>&1 || true; }'
fi
reap() { # <TB_TASKS value>
  ( TB_TASKS="$1"; TASK=""; eval "$reap_src"; _reap_stale_containers ) >/dev/null 2>&1
}

MINE="ptest-mine__aaa111__env-main-1"
THEIRS="ptest-theirs__bbb222__env-main-1"
printf 'c0001 %s exited\nc0002 %s exited\n' "$MINE" "$THEIRS" > "$HERMETIC_DOCKER_PS"
reap "ptest-mine"

# ── 1. it must reap its OWN stale container ─────────────────────────────────
if has "$MINE"; then bad "did NOT reap its own container - leftovers will collide"
else ok "reaped its own stale container"; fi

# ── 2. it must NOT touch another worker's container (THE BUG) ───────────────
if has "$THEIRS"; then ok "left another worker's container ALIVE (no cross-worker sabotage)"
else bad "DESTROYED another worker's container - this is the exit-137 sabotage bug"; fi

# ── 2b. the task name is a FIXED STRING, not a regex ────────────────────────
printf 'c0003 ptest.dot__ccc333__env-main-1 exited\nc0004 ptestxdot__ddd444__env-main-1 running\n' > "$HERMETIC_DOCKER_PS"
reap "ptest.dot"
if has "ptest.dot__ccc333__env-main-1"; then bad "did NOT reap the own container of a task whose name holds a '.'"
else ok "reaped the own container of a task whose name holds a '.'"; fi
if has "ptestxdot__ddd444__env-main-1"; then ok "a '.' in the task name is literal: ptestxdot's live container survived"
else bad "DESTROYED ptestxdot's live container - the task name was matched as a regex"; fi

# ── 3. the reap must be a scoped function, not a blanket pipeline ───────────
if grep -qE '^_reap_stale_containers\(\) \{' "$DG_LF" && \
   ! grep -qE "^docker ps -a --format '\{\{\.Names\}\}' \| grep -E 'env-main' \| xargs -r docker rm -f" "$DG_LF"; then
  ok "reap is scoped by task name, no top-level blanket rm -f"
else
  bad "a top-level blanket 'rm -f all env-main' still exists in run-dg.sh"
fi

# ── 4. MCP config path must be per-proxy-port ───────────────────────────────
if grep -qE 'MCP_CONFIG="\$REPO/mcp-data/\.tb-mcp-\$PROXY_PORT\.json"' "$DG_LF"; then
  ok "MCP config path is per-proxy-port"
else
  bad "MCP config path is shared across workers - ports will race"
fi

# ── 4b. proxy CALL LOG must be per-proxy-port ───────────────────────────────
# This one is the worst of the shared-path family: the file is truncated at the
# start of every task AND is the input to check-terransoul-used.sh's witness 3,
# which the playbook calls DECISIVE. Shared, it makes a worker count other
# workers' brain calls and lose its own — so "TerranSoul was genuinely used"
# becomes unfalsifiable.
if grep -qE 'PROXY_LOG="\$REPO/mcp-data/\.tb-proxy-calls-\$PROXY_PORT\.jsonl"' "$DG_LF"; then
  ok "proxy call log is per-proxy-port (witness 3 cannot cross-contaminate)"
else
  bad "proxy call log is SHARED and truncated per task - witness 3 is corrupted"
fi

# ── 5. whole-suite runs (no -i) must still reap EXITED trial containers ─────
printf 'c0005 %s exited\nc0006 ptest-live__eee555__env-main-1 running\nc0007 ptest-starting__fff666__env-main-1 created\nc0008 tl-mariadb-test exited\n' \
  "$THEIRS" > "$HERMETIC_DOCKER_PS"
reap ""
if has "$THEIRS"; then bad "whole-suite fallback no longer reaps exited containers - stale containers will accumulate"
else ok "whole-suite run still reaps EXITED trial containers (fallback intact)"; fi

# ── 5b. ... and never a container that has not exited ───────────────────────
if has "ptest-live__eee555__env-main-1"; then ok "whole-suite reap left a RUNNING trial container alive"
else bad "whole-suite reap DESTROYED a RUNNING container - the 2026-09-15 18:45 shape"; fi
if has "ptest-starting__fff666__env-main-1"; then ok "whole-suite reap left a container compose up is still creating"
else bad "whole-suite reap DESTROYED a container in state 'created'"; fi
if has "tl-mariadb-test"; then ok "the owner's own container survives the whole-suite reap"
else bad "the whole-suite reap DESTROYED the owner's container"; fi

# ── 6. the reap must SURVIVE `set -euo pipefail` when nothing matches ───────
# This is the normal path — a clean host has no leftovers — and it regressed
# the moment network reaping was added: `grep` exits 1 on no match, pipefail
# propagates it, and `set -e` killed run-dg between "MCP auth proxy up" and
# "job=" with NO error message. The sweep then reported three tasks in a row as
# "FAILED before producing a result (preflight/infra)". A reap that only works
# when there is something to reap is worse than none.
probe="$TMP/reap_under_set_e.sh"
{ echo 'set -euo pipefail'
  awk '/^_reap_stale_containers\(\) \{/,/^_reap_stale_containers$/' "$DG_LF"
  echo 'echo REACHED_END'
} > "$probe"
: > "$HERMETIC_DOCKER_PS"
# The extracted range is two functions and one call. Anything much longer means
# the range did not close and the probe holds the rest of run-dg.sh -- never
# run that.
probe_lines="$(wc -l < "$probe" | tr -d ' ')"
if [ "$probe_lines" -gt 250 ]; then
  bad "the reap extraction did not close ($probe_lines lines) - refusing to run it"
else
  for scope in "scoped" "whole-suite"; do
    if [ "$scope" = "scoped" ]; then env_tasks="ptest-nonexistent-task"; else env_tasks=""; fi
    out="$(TB_TASKS="$env_tasks" TASK="" bash "$probe" 2>/dev/null)"; rc=$?
    if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q REACHED_END; then
      ok "reap survives set -euo pipefail with no matches ($scope)"
    else
      bad "reap ABORTS under set -e when nothing matches ($scope, rc=$rc) - run-dg will die silently"
    fi
  done
fi

echo "  ---- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
