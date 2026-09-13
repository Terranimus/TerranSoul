#!/usr/bin/env bash
# Re-run the tasks that failed or errored in jobs-gate, on the post-fix harness.
#
#   usage: run-redo.sh <worker-index> <task> [task...]
#
# Each worker needs its OWN proxy port, lock, state and job prefix — the same
# isolation run-parallel.sh documents. Two workers on one port is EADDRINUSE and
# both runs die; a shared prefix lets `newest_job_dir` classify a task from the
# other worker's result.json.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
W="${1:?worker index}"; shift
for t in "$@"; do
  echo "===== REDO[$W] $t  ($(date '+%H:%M:%S')) ====="
  TB_JOBS_DIR="$HERE/jobs-redo2" \
  TB_AGENT="terransoul_hook:TerranSoulHook" \
  TB_TASKS_DIR="C:/Users/DevStar/.cache/harbor/tasks/packages/terminal-bench" \
  TB_STOP_HOOK=1 TB_ATTEMPTS=1 TB_TARGET_ATTEMPTS=1 TB_CONCURRENCY=1 \
  TB_PROXY_MODE=learn TB_PROXY_PORT="$((7425+W))" \
  TB_JOB_PREFIX="redo${W}$(date +%m%d%H%M)" \
  TB_LOCK="$REPO/mcp-data/.tb-redo${W}.lock" \
  TB_STATE="$REPO/mcp-data/.tb-redo${W}-state.txt" \
  TB_MODEL=claude-opus-5 TB_RATE_LIMIT_PAUSE_S=600 \
  TB_BRAIN_PORT=7424 TB_BRAIN_DATA="$REPO/mcp-data-tbench-clean" \
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
  bash "$HERE/run-dg.sh" "$t"
  echo "===== done[$W] $t rc=$? ($(date '+%H:%M:%S')) ====="
done
echo "===== REDO[$W] COMPLETE ====="
