#!/usr/bin/env bash
# Terminal-Bench 3.0 — TerranSoul CLI + Fable 5.
#
#   bash run-terransoul.sh                      # full sweep, registry-pinned
#   TB_TASK=<task-id> bash run-terransoul.sh    # one task
#   TB_LOCAL=1 bash run-terransoul.sh           # local dataset, NOT submittable
#
# Deliberate non-features, each of which would invalidate the run:
#
#   * No timeout multiplier, no --agent-timeout, no cpu/memory override.
#     Leaderboard static analysis rejects a job whose config carries any of
#     `timeout_multiplier`, `*_override_timeout_sec`, `max_timeout_sec`, or
#     `override_cpus/gpus/memory_mb/storage_mb` — checked on the JOB config AND
#     on every per-trial config. Defaults only.
#   * No prior-outcome feedback between trials. The judge fails a submission for
#     `harness_level_cheating`, which it defines to include "prior-run
#     post-mortems".
#   * No production brain. The previous runner defaulted to :7423 and
#     $REPO/mcp-data unless an env var said otherwise, so a re-run written
#     without that variable wrote bench material into the live store. Here the
#     memory scope is passed explicitly on every invocation and defaults to the
#     scope that cannot reach a shared store at all.
set -euo pipefail
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# ── Credentials ─────────────────────────────────────────────────────────────
# Read from the Claude settings file unless already exported. Never echoed.
SETTINGS="${TB_SETTINGS_JSON:-$HOME/.claude/settings.Terranimus.json}"
if [ -f "$SETTINGS" ]; then
  eval "$(node -e '
    const j = require(process.argv[1]).env || {};
    const q = (s) => "\x27" + String(s ?? "").replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]) {
      if (j[k]) console.log(`: "${"$"}{${k}:=${"$"}(printf %s ${q(j[k])})}"`);
    }
  ' "$SETTINGS")"
fi
: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL not set and not found in $SETTINGS}"
: "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN not set and not found in $SETTINGS}"
: "${ANTHROPIC_MODEL:?ANTHROPIC_MODEL not set and not found in $SETTINGS}"
# TBENCH-CREDS-EXPORT-1 (found 2026-08-18 in run-terransoul-verifyhook.sh,
# fixed here too — identical block, identical bug): the `:` "${VAR:=…}"
# assignment above sets a plain SHELL variable, not an exported one. The
# preflight probe below spawns `node -e` as a CHILD PROCESS and forwards only
# `TB_PROBE_URL` to it explicitly — ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL were
# never exported anywhere in this script, so that child's
# `process.env.ANTHROPIC_AUTH_TOKEN` / `process.env.ANTHROPIC_MODEL` were
# always `undefined`. `fetch` stringifies the missing header to the literal
# text "undefined" and `JSON.stringify` drops the `model` key outright — a
# REAL, WORKING credential loaded from the settings file was therefore
# reported as "API key không hợp lệ hoặc đã bị thu hồi" (401, invalid/revoked)
# on every single invocation, 100% reproducible, regardless of whether the
# key actually worked. See test-credential-export.sh.
export ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL

# ── Preflight: the CLI must be packable, and the endpoint must actually work ─
#
# A run that never happened is not a failure — it is a measurement of nothing,
# and this repo has published one before (20 trials scored 0 with zero
# completion tokens after a token was revoked). Both checks below cost seconds
# and turn that class of outcome into a refusal to start.
CLI_DIR="$REPO/packages/terransoul-cli"
[ -f "$CLI_DIR/package.json" ] || { echo "no CLI package at $CLI_DIR" >&2; exit 2; }

# The preflight runs on the HOST; the agent runs in a container. When the
# endpoint is on this machine the container reaches it as `host.docker.internal`
# and the host cannot resolve that name at all — so probe the host-local alias
# of the SAME endpoint rather than skipping the check. Override with
# TB_PREFLIGHT_URL when the two differ in some other way.
PREFLIGHT_URL="${TB_PREFLIGHT_URL:-$(printf %s "$ANTHROPIC_BASE_URL" | sed 's|host\.docker\.internal|127.0.0.1|')}"

echo "[preflight] probing $PREFLIGHT_URL for $ANTHROPIC_MODEL ..."
TB_PROBE_URL="$PREFLIGHT_URL" node -e '
const [base, key, model] = [process.env.TB_PROBE_URL, process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_MODEL];
(async () => {
  const r = await fetch(base.replace(/\/$/, "") + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "reply with: ok" }] }),
  });
  const body = await r.text();
  if (!r.ok) { console.error(`  endpoint returned HTTP ${r.status}: ${body.slice(0, 200)}`); process.exit(1); }
  const parsed = JSON.parse(body);
  const text = (parsed.content || []).map((b) => b.text).join("").trim();
  if (!text) { console.error("  endpoint returned 200 with NO content — the model is not generating here"); process.exit(1); }
  console.log(`  ok: ${parsed.model} -> ${JSON.stringify(text.slice(0, 40))}`);
})().catch((e) => { console.error("  " + e.message); process.exit(1); });
' || { echo "[preflight] endpoint check failed — refusing to start a sweep that would score zeros" >&2; exit 2; }

# ── Harbor ──────────────────────────────────────────────────────────────────
HARBOR="$(command -v harbor || echo "$HOME/.local/bin/harbor")"
"$HARBOR" --version >/dev/null || { echo "harbor not found" >&2; exit 2; }

MEMORY_SCOPE="${TB_MEMORY_SCOPE:-session}"
case "$MEMORY_SCOPE" in
  session) ;;
  off) ;;
  persistent)
    [ -n "${TERRANSOUL_MCP_URL:-}" ] || {
      echo "TB_MEMORY_SCOPE=persistent needs TERRANSOUL_MCP_URL" >&2; exit 2; }
    cat >&2 <<'WARN'
[run] MEMORY SCOPE = persistent.
      This arm reads a store that survives across trials and across tasks.
      It is a RESEARCH arm measuring the self-improvement delta. It is NOT
      submittable unless the store provably holds only task-agnostic technique
      (rules/bench-agi-purity.md), because the leaderboard judge treats
      prior-run post-mortems as harness-level cheating.
WARN
    ;;
  *) echo "invalid TB_MEMORY_SCOPE '$MEMORY_SCOPE'" >&2; exit 2 ;;
esac

THINKING_MODE="${TB_THINKING_MODE:-think}"
case "$THINKING_MODE" in
  chat|think|research|max) ;;
  *) echo "invalid TB_THINKING_MODE '$THINKING_MODE' (chat|think|research|max)" >&2; exit 2 ;;
esac
MAX_ITERATIONS="${TB_MAX_ITERATIONS:-150}"

ATTEMPTS="${TB_ATTEMPTS:-5}"      # leaderboard minimum is 5 trials per task
CONCURRENCY="${TB_CONCURRENCY:-2}" # owner decision: two workers, never three
DATASET="${TB_DATASET:-terminal-bench/terminal-bench}"
# TBENCH-ORCH-1: a timestamp alone is a CWE-367-class TOCTOU risk if two
# invocations of this script ever launch within the same second (the exact
# race class that produced the 2026-08-10 v4 orchestration job-dir
# confabulation bug, memory_id 25958, on the predecessor script's
# minute-granularity version). Standing policy is one bench at a time, but
# that bug happened precisely because policy was violated once. $$ (this
# shell's own PID) is always distinct between two concurrently running
# invocations, with no external uuid/date dependency and no race window of
# its own -- append it so a same-second launch still gets a distinct job id.
JOB="${TB_JOB_PREFIX:-ts}-$(date +%Y%m%d-%H%M%S)-$$"
JOBS_DIR="${TB_JOBS_DIR:-$HERE/jobs-terransoul}"
mkdir -p "$JOBS_DIR"

export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"

args=(
  run
  -a "terransoul_cli_agent:TerranSoulCliAgent"
  -m "$ANTHROPIC_MODEL"
  --env docker
  -o "$JOBS_DIR" --job-name "$JOB"
  -k "$ATTEMPTS" -n "$CONCURRENCY" -y
  --ae "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  --ae "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"
  --ae "ANTHROPIC_MODEL=$ANTHROPIC_MODEL"
  --ae "TERRANSOUL_MEMORY_SCOPE=$MEMORY_SCOPE"
  # Reasoning rung and turn budget are declared here rather than left to the
  # adapter's defaults, so the job config records which rung was measured. This
  # repo has already published a bench number that silently measured a
  # different thinking mode than the one it named.
  --ae "TERRANSOUL_THINKING_MODE=$THINKING_MODE"
  --ae "TERRANSOUL_MAX_ITERATIONS=$MAX_ITERATIONS"
)

# ── The reviewer parent ─────────────────────────────────────────────────────
#
# OPTIONAL, and off unless asked for. TB_REVIEWER names a second model that
# reads the task and the run's own record when the agent declares itself done,
# and answers DONE or CONTINUE. It exists because nudging did not work: on two
# of three trials of ts-gemma4-20260815-210137 the verify gate fired, the agent
# answered it, and the run still scored 0. The agent cannot check itself — the
# grader runs tests it never sees.
#
# Recorded in the job config, like the thinking mode and the memory scope, so a
# run can never be compared against one that had a different arrangement.
if [ -n "${TB_REVIEWER:-}" ]; then
  args+=(--ae "TERRANSOUL_REVIEWER_MODEL=$TB_REVIEWER")
  echo "[run] reviewer parent: $TB_REVIEWER (asked when the agent declares completion)"
fi

if [ -n "${TB_LOCAL:-}" ]; then
  LOCAL_TASKS="${TB_LOCAL_TASKS:-$HERE/.dataset-probe/terminal-bench}"
  [ -d "$LOCAL_TASKS" ] || { echo "no local tasks at $LOCAL_TASKS" >&2; exit 2; }
  args+=(-p "$LOCAL_TASKS")
  echo "[run] dataset: LOCAL PATH — this run is NOT submittable"
else
  args+=(-d "$DATASET")
  echo "[run] dataset: REGISTRY $DATASET"
fi

if [ -n "${TERRANSOUL_MCP_URL:-}" ]; then
  args+=(--ae "TERRANSOUL_MCP_URL=$TERRANSOUL_MCP_URL")
  [ -n "${TERRANSOUL_MCP_TOKEN:-}" ] && args+=(--ae "TERRANSOUL_MCP_TOKEN=$TERRANSOUL_MCP_TOKEN")
fi

# TB_TASK takes one id or a comma-separated list. Harbor's `-i` is repeatable;
# a shakedown almost always wants a named handful rather than one task or all 74.
if [ -n "${TB_TASK:-}" ]; then
  IFS=',' read -ra _tasks <<< "$TB_TASK"
  for _t in "${_tasks[@]}"; do
    _t="$(printf %s "$_t" | tr -d '[:space:]')"
    [ -n "$_t" ] && args+=(-i "$_t")
  done
fi

# ── GPU tasks abort the WHOLE JOB, not just their own trial ─────────────────
#
# Measured 2026-08-15: a six-task run died with
#
#   RuntimeError: Task requires 1 GPU(s) but EnvironmentType.DOCKER environment
#   does not support GPU allocation.
#
# raised while BUILDING the environment, so Harbor tore down the job and the
# remaining trials never ran. On a 74-task sweep that means everything after
# the first GPU task is lost.
#
# The requirement is not visible in `get_task_configs()` — it appears only when
# the environment is constructed — but it IS declared in each task's own
# `task.toml`, which the dataset cache already holds. Four of the 74 declare it:
# exam-pdf-eval, fp8-rmsnorm-gemm, jax-speedrun-gpu, math-eval-grader.
#
# This REFUSES rather than silently dropping them. A sweep that quietly skips
# tasks and reports an accuracy over the remainder is exactly the silent cap
# `rules/bench-agi-purity.md` forbids; excluding them has to be a stated,
# deliberate act (TB_ALLOW_SKIP_GPU=1) that prints what it excluded.
TASK_CACHE="$HOME/.cache/harbor/tasks/packages/terminal-bench"

# THE GUARD BELOW IS ONLY AS GOOD AS THE CACHE IT READS, so say when it is not
# there. A missing cache made the whole `if` false and the run proceeded with no
# GPU check and no message — a silent loss of the protection, on exactly the
# machines most likely to need it (a fresh checkout, a cleared cache, a
# relocated HOME). Refusing outright would be wrong: the cache is populated by
# Harbor on first run, so a first run legitimately has none.
if [ ! -d "$TASK_CACHE" ]; then
  echo "[run] NOTE: no task cache at $TASK_CACHE — the GPU-only guard cannot run." >&2
  echo "[run] If this is a full sweep, expect the job to abort at the first GPU task." >&2
fi

# A TASK ID THAT MATCHES NOTHING IS A SILENT COVERAGE LOSS.
#
# Harbor treats an `-i` filter that matches no task as matching nothing and
# raises nothing, so one transposed letter in TB_TASK runs a SMALLER set and
# reports an accuracy over it. That is the silent cap `rules/bench-agi-purity.md`
# forbids, arriving through a typo instead of through a config.
if [ -n "${TB_TASK:-}" ] && [ -d "$TASK_CACHE" ]; then
  bad=""
  for _t in "${_tasks[@]}"; do
    _t="$(printf %s "$_t" | tr -d '[:space:]')"
    [ -n "$_t" ] || continue
    [ -d "$TASK_CACHE/${_t#terminal-bench/}" ] || bad="$bad $_t"
  done
  if [ -n "$bad" ]; then
    echo "[run] REFUSING: TB_TASK names task(s) that do not exist in the dataset:$bad" >&2
    echo "[run] Harbor would run the remainder and report an accuracy over it." >&2
    exit 2
  fi
fi

if [ -d "$TASK_CACHE" ]; then
  gpu_tasks=""
  for toml in "$TASK_CACHE"/*/*/task.toml; do
    [ -f "$toml" ] || continue
    # `|| true` is load-bearing: under `set -e` a grep that finds nothing exits
    # 1, and a failing command substitution in an assignment aborts the script.
    # Most task.toml files have no gpus line, so without this the guard killed
    # the run it was written to protect — silently, before printing anything.
    g="$(grep -m1 -E '^[[:space:]]*gpus[[:space:]]*=' "$toml" 2>/dev/null | tr -d '[:space:]' | cut -d= -f2 || true)"
    [ -n "$g" ] && [ "$g" != "0" ] || continue
    name="$(basename "$(dirname "$(dirname "$toml")")")"
    # Only complain about tasks this run would actually attempt.
    if [ -z "${TB_TASK:-}" ] || printf %s "$TB_TASK" | grep -q "$name"; then
      gpu_tasks="$gpu_tasks $name"
    fi
  done
  if [ -n "$gpu_tasks" ]; then
    if [ -n "${TB_ALLOW_SKIP_GPU:-}" ]; then
      echo "[run] EXCLUDING GPU-only task(s), by TB_ALLOW_SKIP_GPU:$gpu_tasks" >&2
      echo "[run] any accuracy from this job is over the REMAINING tasks and must say so" >&2
      # HARBOR'S OWN EXCLUDE FLAG, because the substitution that used to be here
      # was a no-op and this branch printed an exclusion it did not perform.
      #
      # `-i` is pushed as TWO array elements (`-i` then the id), so the pattern
      # `-i terminal-bench/$t` could never match a single element and every
      # element survived. Worse, the branch that matters most — a FULL sweep —
      # passes no `-i` at all, so there was nothing to substitute even in
      # principle: the task list comes from the dataset. The net effect was that
      # `TB_ALLOW_SKIP_GPU=1` printed "EXCLUDING" and then ran the GPU task
      # anyway, which aborts the whole job at environment build and loses every
      # trial after it. That made a 74-task sweep impossible by either route:
      # refuse without the flag, or claim-and-fail with it.
      #
      # `-x/--exclude-task-name` filters the dataset itself, so it works for a
      # full sweep and a `-i` selection alike.
      for t in $gpu_tasks; do
        args+=(-x "terminal-bench/$t")
      done
    else
      echo "[run] REFUSING: this selection includes GPU-only task(s):$gpu_tasks" >&2
      echo "[run] Docker without nvidia-docker aborts the WHOLE JOB on these, losing every" >&2
      echo "[run] trial after them. Provide a GPU environment, drop them from TB_TASK, or" >&2
      echo "[run] set TB_ALLOW_SKIP_GPU=1 to exclude them and have the exclusion printed." >&2
      exit 2
    fi
  fi
fi

echo "[run] job=$JOB model=$ANTHROPIC_MODEL k=$ATTEMPTS n=$CONCURRENCY memory=$MEMORY_SCOPE mode=$THINKING_MODE turns=$MAX_ITERATIONS"

# A SEAM SO THE ARGUMENT CONSTRUCTION CAN BE TESTED WITHOUT SPENDING A SWEEP.
#
# The GPU exclusion above shipped broken precisely because nothing could observe
# what this script hands Harbor: the only way to find out was to run 74 tasks
# and watch the job abort. One argv per line, so a test can grep it.
if [ -n "${TB_DRY_RUN:-}" ]; then
  printf '%s\n' "${args[@]}"
  exit 0
fi

"$HARBOR" "${args[@]}"

# ── Result ──────────────────────────────────────────────────────────────────
#
# Read result.json, never the exit code. Harbor exits 0 on a job whose trials
# all scored zero; the number lives in stats.evals[*].metrics[0].mean and it is
# PER-TRIAL, not per-task. "N/N tasks solved by at least one attempt" is a
# different statistic and is not an accuracy.
JOB_DIR="$JOBS_DIR/$JOB"
echo
if [ -f "$JOB_DIR/result.json" ]; then
  # `python3` on Windows resolves to the Microsoft Store alias stub, which
  # prints an install advert and exits non-zero — so the summary died AFTER a
  # completed job and took the script's exit code with it.
  # `command -v` is not enough: the stub IS on PATH and answers it. The only
  # honest test is whether the interpreter runs, so run it.
  PY_BIN=""
  for _py in python3 python py; do
    if "$_py" -c "import sys" >/dev/null 2>&1; then PY_BIN="$_py"; break; fi
  done
  [ -n "$PY_BIN" ] || { echo "  no working python on PATH — cannot summarise $JOB_DIR/result.json" >&2; exit 1; }
  "$PY_BIN" - "$JOB_DIR/result.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
stats = d.get("stats", {}) or {}
print(f"  trials: {d.get('n_total_trials')}  completed: {stats.get('n_completed_trials')}  errored: {stats.get('n_errored_trials')}")
print(f"  tokens: in={stats.get('n_input_tokens')} out={stats.get('n_output_tokens')}  cost_usd={stats.get('cost_usd')}")
if not stats.get("n_output_tokens"):
    print("  WARNING: zero output tokens across the whole job — this run never happened.")
for name, ev in (stats.get("evals") or {}).items():
    metrics = ev.get("metrics") or []
    mean = metrics[0].get("mean") if metrics else "?"
    print(f"  {name}: accuracy(per-trial)={mean}  n_trials={ev.get('n_trials')}  n_errors={ev.get('n_errors')}")
    for k, v in (ev.get("pass_at_k") or {}).items():
        print(f"    pass@{k}: {v}")
    for exc, trials in (ev.get("exception_stats") or {}).items():
        print(f"    {exc}: {len(trials)}")
PY
else
  echo "  no result.json — the job did not complete"
  exit 1
fi
