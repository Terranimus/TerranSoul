#!/usr/bin/env bash
# D-G: Claude Code inside the task container, TerranSoul attached as an MCP
# brain on the host. See rules/tbench-playbook.md — this script IS that
# playbook's "The run" section, with the credential read from a file so the
# token never lands in a shell history, a process listing or a transcript.
#
# Usage:
#   ./run-dg.sh                 # one task (fix-git), the integration proof
#   ./run-dg.sh '' 5            # first 5 tasks, for the cost probe
#   ./run-dg.sh some-task-id    # a specific task
set -euo pipefail

# Harbor renders its tables with U+2713 / U+2717. Without these the Windows
# console codepage raises UnicodeEncodeError and the command dies BEFORE
# running anything — a crash that looks like a harness bug and is purely
# encoding.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

# ⛔ PREFER THE CALLER'S DIRECTORY, because this script may be running from a
# SNAPSHOT. redo-task.sh copies this file to a mktemp path and executes the copy
# so that editing the repo file mid-run cannot corrupt a live trial (bash reads
# by byte offset — it cost two trials on 2026-09-02). But `dirname
# "${BASH_SOURCE[0]}"` then resolves to /tmp, which breaks all 17 "$HERE/..."
# references — measured immediately: MODULE_NOT_FOUND on the purity checker,
# which then refused the run. So the caller passes the real location through.
HERE="${TB_DRIVER_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO="$(cd "$HERE/../.." && pwd)"
# `${1-fix-git}` NOT `${1:-fix-git}`. The colon form substitutes the default for
# an EMPTY argument too, so the documented `./run-dg.sh '' 5` silently became
# `-i fix-git -l 5` and ran ONE task while reporting itself as a 5-task probe
# (job dg-20260804-174333). Without the colon, an explicitly-empty first arg
# stays empty and means "all tasks".
TASK="${1-fix-git}"
LIMIT="${2:-}"

# The three staged runs the playbook authorises, expressed as env knobs rather
# than three near-duplicate scripts:
#
#   proof   ./run-dg.sh                                  # fix-git, 1 attempt
#   probe   ./run-dg.sh '' 5                              # 5 tasks, 1 attempt
#   sweep   TB_ATTEMPTS=5 TB_CONCURRENCY=4 ./run-dg.sh '' # all 89 x 5
#
# CONCURRENCY is trials in flight inside ONE harbor job — it is not extra bench
# terminals, so it does not conflict with the <=5 concurrent-bench cap in
# rules/bench-resource-discipline.md. Keep it modest anyway: every trial is a
# container, and this machine's D: drive is already the measured bottleneck
# (see scripts/check-cargo-contention.mjs).
ATTEMPTS="${TB_ATTEMPTS:-1}"
CONCURRENCY="${TB_CONCURRENCY:-1}"

# EXPORTED, not just assigned. A plain assignment is invisible to child
# processes, and the mcp-auth-proxy child reads the tasks dir from the
# environment to build its purity term list -- an unset value silently
# disarmed that gate for a whole sweep on 2026-08-23.
export TB21_DIR="${TB21_DIR:-/d/Git/terminal-bench-2-1}"
# REQUIRED ONLY WHEN IT IS THE DATASET. With `TB_DATASET` set the tasks come
# from the pinned registry and this clone is never read, so demanding it turned
# a 2.1-era convenience into a hard block on running any other Terminal-Bench
# release through this driver — and the driver is 777 lines of container
# reaping, network-leak cleanup, proxy lifecycle and credential refresh that a
# fork would have to duplicate and then drift from
# (`rules/one-path-three-surfaces.md`).
if [ -z "${TB_DATASET:-}" ]; then
  [ -d "$TB21_DIR/tasks" ] || { echo "TB21_DIR=$TB21_DIR has no tasks/ subdir" >&2; exit 2; }
fi

# ── The TerranSoul agent must not run with its enforcement silently off ─────
#
# ⛔ MEASURED 2026-09-04 AND IT COST A WHOLE CAMPAIGN. The Stop hook and the
# PreToolUse wall-clock guards are OPT-IN here (`${TB_STOP_HOOK:-0}` below).
# `redo-task.sh:324` opts in (`${TB_STOP_HOOK:-1}`), so anything routed through
# it is fine. A launcher that calls THIS script directly is not, and nothing
# said so.
#
# Counted with the marker that actually records the decision — `config.json` ->
# agents[0].kwargs.config, written only inside the TB_STOP_HOOK block — 57 of
# 335 jobs registered the hooks, every one of them a redo*. All 66 tasks of the
# k=1 campaign ran carrying the `terransoul-hook` identity with enforcement
# OFF: memories were served and lessons authored, but no stop gate and no
# wall-clock guard ever ran. caffe-cifar-10 then spent 45 of its 60 minutes
# inside `sleep` and died on AgentTimeoutError with its deliverable already
# correct on disk.
#
# The existing check below refuses TB_STOP_HOOK=1 without the TerranSoul agent.
# THIS is the converse, and it is the direction that bit: claiming the identity
# while disabling the enforcement is the incoherent combination, and it was
# silent.
#
# REFUSES ONLY WHEN UNSET. An explicit TB_STOP_HOOK=0 is a legitimate control
# arm — measuring the memory half without the verification half is a real
# experiment. An unset variable is an accident. `${VAR+x}` tells those apart;
# `${VAR:-0}` cannot, which is exactly why this was invisible.
case "${TB_AGENT:-}" in
  *TerranSoulHook*)
    if [ -z "${TB_STOP_HOOK+x}" ]; then
      echo "[run-dg] REFUSING: TB_AGENT is the TerranSoul agent but its enforcement is OFF." >&2
      echo "[run-dg] TB_STOP_HOOK is UNSET, so the Stop hook and the PreToolUse wall-clock" >&2
      echo "[run-dg] guards will not be registered — the run would measure TerranSoul's memory" >&2
      echo "[run-dg] with its verification half missing, while still reporting the TerranSoul" >&2
      echo "[run-dg] identity in result.json. That is what 66 k=1 trials silently did." >&2
      echo "[run-dg]   TB_STOP_HOOK=1  to enforce (what you almost certainly want)" >&2
      echo "[run-dg]   TB_STOP_HOOK=0  to opt out DELIBERATELY, as a control arm" >&2
      exit 2
    fi
    ;;
esac

# `harbor` is a `uv` tool and is NOT on PATH in backgrounded shells — this
# silently produced exit 127 twice. Resolve it once, explicitly.
HARBOR="$(command -v harbor || echo "$HOME/.local/bin/harbor")"
"$HARBOR" --version >/dev/null || { echo "harbor did not resolve" >&2; exit 2; }

# TB_PROXY_MODE=learn routes the bench at an ISOLATED brain (default :7424,
# mcp-data-tbench/) rather than the production one on :7423. Cross-trial
# learning means the benchmark WRITES, and a benchmark must never mutate the
# brain the product actually uses — so learn mode changes the UPSTREAM, not
# merely the permission.
BRAIN_PORT="${TB_BRAIN_PORT:-7423}"
BRAIN_DATA="${TB_BRAIN_DATA:-$REPO/mcp-data}"
if [ "${TB_PROXY_MODE:-}" = "learn" ]; then
  BRAIN_PORT="${TB_BRAIN_PORT:-7424}"
  # mcp-data-tbench-clean, NOT mcp-data-tbench. The latter was this default and
  # is the OLD 2.1 campaign store: measured 2026-08-23 it holds 12 rows naming 8
  # Terminal-Bench 2.1 tasks, so the default handed a fresh submittable sweep the
  # previous sweep post-mortems. The purity preflight below now refuses either
  # store if it is dirty, but a default that is wrong-by-design is the root
  # cause; a downstream guard is not a licence to ship a footgun upstream of it.
  BRAIN_DATA="${TB_BRAIN_DATA:-$REPO/mcp-data-tbench-clean}"
  echo "[run-dg] LEARN MODE — isolated brain :$BRAIN_PORT ($BRAIN_DATA); production brain untouched"
fi

# The brain must answer before the container tries to reach it through the
# proxy, or every brain_* tool call fails inside the trial and the run silently
# measures plain Claude Code.
health_body="$(curl -s -m 5 -w '\n%{http_code}' "http://127.0.0.1:$BRAIN_PORT/health" || true)"
code="$(printf '%s' "$health_body" | tail -n1)"
# ⛔ NAME THE ENV VARS, OR THIS MESSAGE IS A CONTAMINATION PATH.
#
# It used to say only "run: node scripts/copilot-start-mcp.mjs". Followed
# verbatim, that script defaults to TERRANSOUL_MCP_PORT=7423 and the PRODUCTION
# data dir — so in learn mode you get a healthy brain on the right port serving
# the WRONG store, and learn mode WRITES (cross-trial learning is the whole
# point). Measured 2026-08-31: a brain started that way reported the same
# `memory_total` as production, and the only thing that stopped a bench from
# mutating the product's brain was an unrelated 401 token guard firing further
# down. A repair instruction that silently produces the exact state the
# surrounding code exists to prevent is a defect in the instruction.
#
# `TERRANSOUL_MCP_DATA_DIR` is the correct variable (see lib.rs's own note:
# "the isolated bench brain runs with TERRANSOUL_MCP_DATA_DIR=mcp-data-tbench").
# `TERRANSOUL_HEADLESS_DATA_DIR` is a DIFFERENT binary's variable and is
# silently ignored by `--mcp-tray`.
#
# ⛔ AND `node scripts/copilot-start-mcp.mjs` IS NOT THE REPAIR, EVEN WITH BOTH
# VARIABLES SET. That script probes for an EXISTING server first
# (`findExistingMcpServer`), finds the production tray healthy on :7423, prints
# "reusing it" and exits 0 — having bound nothing on :$BRAIN_PORT. So the
# instruction this message used to give succeeds, reports success, and leaves
# the bench brain exactly as missing as it was; the next task then refuses here
# again, in seconds, for as long as the sweep has tasks left. The repair has to
# be a script that starts THIS port and waits for it to be ready and isolated.
if [ "$code" != "200" ]; then
  echo "brain not healthy on :$BRAIN_PORT (got '$code')" >&2
  echo "  start it with:" >&2
  echo "    bash ${TB_DRIVER_HOME:-$HERE}/start-bench-brain.sh" >&2
  echo "  which launches the MCP binary with TERRANSOUL_MCP_PORT=$BRAIN_PORT," >&2
  echo "  TERRANSOUL_MCP_DATA_DIR=$BRAIN_DATA and TERRANSOUL_MCP_IDLE_TIMEOUT=0" >&2
  echo "  (the 300 s default shuts the brain down MID-TRIAL), then waits until" >&2
  echo "  /health is 200, llm_provider_state is ready, and memory_total DIFFERS" >&2
  echo "  from the production brain's on :7423." >&2
  echo "  Do NOT use 'node scripts/copilot-start-mcp.mjs' for this: it reuses the" >&2
  echo "  production tray on :7423 and exits 0 without starting :$BRAIN_PORT." >&2
  exit 2
fi

# ── LLM WARMTH PREFLIGHT (TBENCH-COLD-BRAIN-1) ──────────────────────────────
# A 200 from /health is NOT readiness. The endpoint answers as soon as the HTTP
# server is up, while its own body reports `llm_provider_state` separately --
# and on a freshly (re)started brain that field reads "degraded" with the detail
# "model '<id>' not in /api/ps (cold start)" until Ollama has actually loaded
# the model.
#
# MEASURED 2026-08-30. The brain was restarted at 01:48 and a three-task run
# launched at 01:49 on a 200 from /health. The witnesses: mteb-retrieve made
# ZERO MCP calls, filter-js-from-html made 2 (it had made 11 on the same task
# 40 min earlier), and only extract-elf -- starting 25 min in, by which point
# the model had loaded -- made a normal 9 and produced a full ledger trace. Two
# of the three trials therefore measured plain Claude Code with TerranSoul
# connected but never called, which is exactly the "connecting is not using"
# failure the witness block downstream exists to report AFTER the fact. This
# gate is that same check moved BEFORE the run, where it costs a wait instead
# of a wasted trial.
# ── CONTAINER NETWORK PREFLIGHT (TBENCH-CONTAINER-TLS-1) ────────────────────
#
# MEASURED 2026-09-07 02:42-03:13. Nine consecutive trials errored in
# `_install_stock_with_retry` with
#   curl: (60) SSL certificate problem: unable to get local issuer certificate
# fetching downloads.claude.ai. The agent never ran in any of them, ~40 minutes
# went to setup that could not succeed, and the wall of identical errors read
# like an adapter regression -- the first instinct was to audit recent commits.
#
# IT WAS NOT THE HARNESS, and one probe with a clean image proved it in seconds:
# from a container, downloads.claude.ai, registry.npmjs.org AND pypi.org all
# fail TLS; from the HOST the same URL returns 200. A TLS-intercepting middlebox
# (corporate proxy, AV, VPN, or Docker Desktop networking) presents a cert whose
# root is in the Windows trust store and absent from the containers' CA bundle.
#
# ⛔ WHY THIS REFUSES RATHER THAN WARNS. The damage is not limited to installing
# the agent: the same interception breaks apt-get, pip and npm INSIDE TASK
# CONTAINERS. A sweep run in this state does not merely lose trials to setup, it
# systematically depresses every task that installs anything -- so the result
# looks like a capability number and is not one. A misleading 89-task figure is
# far more expensive than a refused start.
#
# Unlike the reasoning gates this campaign has measured and rejected (judge 11%,
# missing-deliverable 0/3, self-scan 12-16%, fork-declaration 11%), this one is
# deterministic: a non-200 from a stock curl image IS a broken environment.
#
# FAILS OPEN on anything that is not a definite TLS/connect failure -- no docker,
# no image, a pull that cannot run: the probe cannot run, so it says nothing and
# the run proceeds exactly as before. A preflight that blocks because it could
# not check is worse than no preflight.
if [ "${TB_SKIP_NET_PREFLIGHT:-0}" != "1" ] && command -v docker >/dev/null 2>&1; then
  _net_img="${TB_NET_PREFLIGHT_IMAGE:-curlimages/curl:latest}"
  _net_url="${TB_NET_PREFLIGHT_URL:-https://registry.npmjs.org/}"
  _net_code="$(docker run --rm "$_net_img" -sS -o /dev/null -w '%{http_code}'                  --max-time "${TB_NET_PREFLIGHT_TIMEOUT_S:-20}" "$_net_url" 2>/dev/null || echo "")"
  case "$_net_code" in
    2??|3??)
      echo "[run-dg] container network preflight: $_net_code from $_net_url" ;;
    "")
      # Could not run the probe at all (no image, docker down). Say so and carry
      # on: this is the fail-open path, not a verdict about the network.
      echo "[run-dg] container network preflight: SKIPPED (probe could not run)" >&2 ;;
    *)
      echo "[run-dg] REFUSING: containers cannot reach $_net_url (got '$_net_code')." >&2
      echo "[run-dg] Host reachability is NOT enough — a TLS-intercepting proxy/AV/VPN can be" >&2
      echo "[run-dg] trusted by Windows and absent from the containers' CA bundle. This breaks" >&2
      echo "[run-dg] apt-get/pip/npm INSIDE task containers too, so a run now would depress every" >&2
      echo "[run-dg] task that installs anything and produce a misleading number, not just lost" >&2
      echo "[run-dg] trials. Measured 2026-09-07: 9 consecutive trials errored before the agent ran." >&2
      echo "[run-dg] Fix: install the intercepting root CA into the image/CA bundle, or exempt" >&2
      echo "[run-dg] Docker's network. Verify with:" >&2
      echo "[run-dg]   docker run --rm $_net_img -sS -o /dev/null -w '%{http_code}' $_net_url" >&2
      echo "[run-dg] Override with TB_SKIP_NET_PREFLIGHT=1 only for a run you will NOT publish." >&2
      exit 2 ;;
  esac
fi

# ── HOST HEADROOM PREFLIGHT (TBENCH-HOST-HEADROOM-1) ────────────────────────
#
# MEASURED 2026-09-08. Ollama was holding 14.39 GiB of Docker's 39.17 GiB budget
# for `gemma4:12b-it-qat`, whose keep-alive had EXPIRED AT 03:25 — ten hours
# earlier. Unloading it with `keep_alive: 0` returned 14.39 -> 7.48 GiB, ~6.9 GiB
# recovered without restarting a service anything else was using. `.wslconfig`
# documents the arithmetic this depends on — "a 12B sits in the SAME budget as
# the task containers" — and until now nothing checked it at run time.
#
# WHY IT MATTERS BEYOND WASTE, and this is what makes it a preflight rather than
# a chore. Host memory pressure is what produces `0xC0000142`
# (STATUS_DLL_INIT_FAILED) when the host tries to start `docker`: 14 trials in
# this campaign died that way, in PAIRS at the same minute across both workers.
# TBENCH-HOST-SPAWN-RETRY-1 in terransoul_hook.py survives those; this removes
# the pressure that causes them. Retry and headroom are the two halves.
#
# ⛔ REPORTS AND REMEDIATES, DOES NOT REFUSE. Unlike the TLS preflight above, a
# headroom threshold is a judgement call, not a deterministic verdict about a
# broken environment — and this campaign has measured what happens when a gate
# that cannot discriminate is allowed to block (judge 11%, missing-deliverable
# 0/3, self-scan 12-16%). Two actions here are unambiguous and are the only ones
# taken: evicting a model Ollama itself has already expired, and removing
# containers that have already EXITED. Both are provably not in use.
#
# ⛔ EXITED ONLY, NEVER `Up`. With two workers the other worker's trial is live
# while this one preflights, and an `Up` container is indistinguishable from
# its container. On 2026-09-07 a blunt `docker rm -f` killed two live trials for
# exactly that reason. `--filter status=exited` cannot: a stopped container is
# nobody's running work.
#
# FAILS OPEN throughout — no python, no docker, no Ollama, a probe that errors:
# say so and continue. A preflight that blocks because it could not check is
# worse than no preflight.
if [ "${TB_SKIP_HEADROOM:-0}" != "1" ]; then
  _ollama_host="${OLLAMA_HOST:-http://127.0.0.1:11434}"
  _ps_json="$(curl -s -m 10 "$_ollama_host/api/ps" 2>/dev/null || echo "")"
  if [ -n "$_ps_json" ] && command -v python >/dev/null 2>&1; then
    # Ollama reports `expires_at` per resident model. A timestamp in the PAST
    # with the model still resident is the exact 2026-09-08 signature: the
    # keep-alive lapsed and the weights were never released.
    _expired="$(printf '%s' "$_ps_json" | python -c '
import json, sys, datetime
try:
    models = json.load(sys.stdin).get("models") or []
except Exception:
    sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc)
for m in models:
    raw = (m.get("expires_at") or "").replace("Z", "+00:00")
    try:
        exp = datetime.datetime.fromisoformat(raw)
    except Exception:
        continue
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=datetime.timezone.utc)
    if exp < now:
        gib = (m.get("size_vram") or m.get("size") or 0) / 1073741824
        print("%s %.2f" % (m.get("name", "?"), gib))
' 2>/dev/null || echo "")"
    if [ -n "$_expired" ]; then
      printf '%s\n' "$_expired" | while read -r _m _gib; do
        [ -n "$_m" ] || continue
        echo "[run-dg] host headroom: '$_m' is resident with an EXPIRED keep-alive (${_gib} GiB); unloading"
        curl -s -m 60 "$_ollama_host/api/generate" -H 'content-type: application/json' \
          -d "{\"model\":\"$_m\",\"keep_alive\":0}" >/dev/null 2>&1 || true
      done
    else
      echo "[run-dg] host headroom: no expired Ollama models resident"
    fi
  else
    echo "[run-dg] host headroom: Ollama resident-set check SKIPPED (no /api/ps or no python)" >&2
  fi

  if command -v docker >/dev/null 2>&1; then
    # Leaked containers from trials that died in teardown. terransoul_hook.py
    # reaps its own at the moment of failure (TBENCH-TEARDOWN-REAP-1); this
    # clears anything older, including runs that predate that fix.
    #
    # ⛔ THE `__` IS THE SAFETY PROPERTY, NOT A CONVENIENCE. This machine also
    # runs the owner's own containers (`tl-mariadb-test`,
    # `richardle-mariadb-local`, `shopee-crawler-mariadb-local`), which sit
    # EXITED for weeks and must never be touched. Every harbor trial container
    # carries the trial session id, which always contains a DOUBLE underscore
    # (`caffe-cifar-10__vziewm8__env-main-1`,
    # `mvcc-lsm-compaction__ch8ddwr__verifier__trial-main-1`); none of the
    # owner's containers contain one. A bare `status=exited` sweep, or a loose
    # `name=-main-` filter, would delete the owner's data containers.
    #
    # The names are printed before removal, so the action is auditable in the
    # run log instead of silent.
    _dead="$(docker ps -a --filter status=exited --format '{{.ID}} {{.Names}}' 2>/dev/null | grep '__' || true)"
    if [ -n "$_dead" ]; then
      _n="$(printf '%s\n' "$_dead" | wc -l | tr -d ' ')"
      echo "[run-dg] host headroom: removing $_n exited trial container(s):"
      printf '%s\n' "$_dead" | sed 's/^/[run-dg]   /'
      # shellcheck disable=SC2046
      docker rm -f $(printf '%s\n' "$_dead" | awk '{print $1}') >/dev/null 2>&1 || true
    else
      echo "[run-dg] host headroom: no exited trial containers to remove"
    fi
  fi

  # ── FREE DISK: THE ONE FIGURE HERE THAT REFUSES ────────────────────────────
  #
  # ⛔ NOTHING CHECKED IT. This block weighs VRAM and leaked containers and then
  # starts a run that pulls harbor images, writes container layers and files a
  # job directory per trial — all onto the repo drive. A sweep launched with a
  # few GB left cannot finish, and the way it fails is expensive and confusing:
  # image pulls and apt/pip installs inside containers die with unrelated-looking
  # errors, one task at a time, for hours.
  #
  # ⛔ AND IT REFUSES RATHER THAN REPORTS, WHICH THE REST OF THIS BLOCK DOES NOT.
  # The distinction is the one the TLS preflight above already draws: evicting an
  # expired model or removing an exited container are actions, and a threshold on
  # them would be a judgement call this campaign has measured the cost of
  # (judge 11%, missing-deliverable 0/3, self-scan 12-16%). Free disk is neither
  # — there is no safe automatic action that frees space on the owner's drive,
  # and "under 30 GB" is a deterministic fact about a broken environment, not an
  # inference about a trial. Same exit code (2) as every other preflight refusal
  # here, so run-two-workers.sh reads it as a refusal and halts after two.
  #
  # FAILS OPEN when df gives nothing parseable: a preflight that blocks because
  # it could not check is worse than no preflight.
  _min_free_gb="${TB_MIN_FREE_GB:-30}"
  _avail_kb="$(df -k "${REPO:-.}" 2>/dev/null | tail -1 | awk '{print $4}')"
  case "$_avail_kb" in
    ''|*[!0-9]*)
      echo "[run-dg] host headroom: free-space check SKIPPED (df gave no usable figure)" >&2 ;;
    *)
      _avail_gb=$(( _avail_kb / 1048576 ))
      if [ "$_avail_gb" -lt "$_min_free_gb" ]; then
        echo "[run-dg] REFUSING: only ${_avail_gb} GB free on the repo drive (floor ${_min_free_gb} GB)." >&2
        echo "[run-dg] harbor images, container layers and per-trial job artefacts all land here." >&2
        echo "[run-dg] A sweep started now fails one task at a time, for hours, with errors that" >&2
        echo "[run-dg] look like anything but a full disk. Free space, or lower the floor" >&2
        echo "[run-dg] deliberately with TB_MIN_FREE_GB." >&2
        exit 2
      fi
      echo "[run-dg] host headroom: ${_avail_gb} GB free on the repo drive (floor ${_min_free_gb} GB)" ;;
  esac
fi

if [ "${TB_SKIP_WARMTH:-0}" != "1" ]; then
  _warm_deadline=$(( $(date +%s) + ${TB_WARMTH_MAX_S:-300} ))
  _warm_state=""
  while :; do
    _warm_state="$(printf '%s' "$health_body" | sed -n '1p' \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(String(j.llm_provider_state||"unknown"))}catch(e){console.log("unparsed")}})' 2>/dev/null || echo unparsed)"
    case "$_warm_state" in
      ready|ok|healthy) echo "[run-dg] brain LLM provider: $_warm_state"; break ;;
    esac
    # ── TBENCH-TEACHER-REVIEW-1: a CLI-backed brain has no Ollama probe ──────
    # MEASURED 2026-09-11 20:48 on the first teacher-student launch: with the
    # bench brain in claude_cli mode, /health answers 200 with
    # llm_provider_state=null (the tray only probes Ollama), so this loop read
    # 'unknown' every 15 s and would have refused a brain that had just
    # answered a real judge call. The gate exists to prove the brain SERVES
    # tool calls; for this provider, ask exactly that: one real `verify` call
    # through /mcp with the bench token, accepted on a boolean verdict. The
    # reply wraps the judge JSON as an escaped string, hence the \" patterns.
    if [ "$_warm_state" = "unknown" ] || [ "$_warm_state" = "null" ]; then
      _warm_provider="$(printf '%s' "$health_body" | sed -n '1p' \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(String(j.brain_provider||""))}catch(e){console.log("")}})' 2>/dev/null || echo '')"
      if [ "$_warm_provider" = "claude_cli" ]; then
        _warm_tok="$(tr -d '\r\n' < "$BRAIN_DATA/mcp-token.txt" 2>/dev/null || true)"
        _warm_probe="$(curl -s -m 170 -X POST "http://127.0.0.1:$BRAIN_PORT/mcp" \
          -H "Authorization: Bearer $_warm_tok" -H 'Content-Type: application/json' \
          -H 'Accept: application/json, text/event-stream' \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"brain_verify_completion","arguments":{"op":"verify","goal":"Write the word hello into /tmp/probe.txt and confirm its contents.","session_id":"run-dg-warmth","root":"/tmp","actions_snapshot":"$ printf hello > /tmp/probe.txt\n$ cat /tmp/probe.txt\nhello"}}}' \
          2>/dev/null || true)"
        case "$_warm_probe" in
          *'method\":\"llm_judge'*'verified\":true'*|*'method\":\"llm_judge'*'verified\":false'*)
            echo "[run-dg] brain LLM provider: claude_cli answered a real judge call (TBENCH-TEACHER-REVIEW-1 warmth)"
            _warm_state=healthy; break ;;
          *) echo "[run-dg] claude_cli brain returned no judge verdict yet: $(printf '%s' "$_warm_probe" | tr -d '\n' | cut -c1-160)" ;;
        esac
      fi
    fi
    if [ "$(date +%s)" -ge "$_warm_deadline" ]; then
      echo "[run-dg] STOPPING: brain LLM provider still '$_warm_state' after ${TB_WARMTH_MAX_S:-300}s." >&2
      echo "[run-dg] A cold brain answers /health 200 and then serves ZERO tool calls, which" >&2
      echo "[run-dg] silently measures plain Claude Code. Not starting a trial on it." >&2
      exit 2
    fi
    echo "[run-dg] brain LLM provider '$_warm_state' — warming (cold start), re-checking in 15s"
    # THE POKE MUST CAUSE A LOAD, NOT MERELY OBSERVE ONE. An earlier revision
    # re-fetched /health here, which reaches Ollama's /api/tags -- a listing
    # call that answers instantly and loads nothing. MEASURED 2026-08-30 on the
    # gate's first real firing: it spun through four cycles reporting
    # "warming" while /api/ps stayed empty, and would have run out its budget
    # and refused a run it was supposed to rescue. A gate that detects the
    # problem but cannot clear it just converts a wasted trial into a blocked
    # run. Only an inference request loads the weights, so send one.
    _warm_model="$(printf '%s' "$health_body" | sed -n '1p'       | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(String(j.brain_model||""))}catch(e){console.log("")}})' 2>/dev/null || echo '')"
    if [ -n "$_warm_model" ]; then
      curl -s -m 180 "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/generate"         -H 'content-type: application/json'         -d "{\"model\":\"$_warm_model\",\"prompt\":\"ok\",\"stream\":false,\"keep_alive\":\"30m\"}"         >/dev/null 2>&1 || true
    fi
    sleep 15
    health_body="$(curl -s -m 10 -w '\n%{http_code}' "http://127.0.0.1:$BRAIN_PORT/health" || true)"
  done
fi

# ── STORE PURITY PREFLIGHT (TBENCH-WRITE-PURITY-1) ──────────────────────────
# A healthy brain is not a CLEAN brain. Measured 2026-08-23: the learn-mode
# DEFAULT store (mcp-data-tbench) held 12 rows naming 8 Terminal-Bench 2.1
# tasks, and mcp-data-tbench-clean held one -- which the retrieval audit then
# returned at RANK 1 for a real task name. The leaderboard judge classes
# prior-run post-mortems as harness_level_cheating, a verdict that renders the
# whole submission invalid, so this fails CLOSED.
#
# It scans every row rather than searching: a semantic probe answers "what is
# most similar", not "does any row contain this string", and it fails OPEN --
# see the brain PURITY-AUDIT-1 lesson. Cheap enough to run per trial, which is
# what catches a store that drifts mid-sweep.
# TB_SUBMITTABLE=1 is the profile for a run intended for the public
# leaderboard. It exists so submission safety is ONE switch rather than five
# things to remember, and so the submission notes can cite what was enforced.
if [ "${TB_SUBMITTABLE:-0}" = "1" ]; then
  if [ "${TB_SKIP_PURITY_CHECK:-0}" = "1" ]; then
    echo "[run-dg] REFUSING: TB_SUBMITTABLE=1 and TB_SKIP_PURITY_CHECK=1 are contradictory." >&2
    exit 2
  fi
  if [ "${TB_PROXY_ALLOW_WRITES:-0}" = "1" ]; then
    echo "[run-dg] REFUSING: TB_PROXY_ALLOW_WRITES=1 bypasses the task-identity write purity gate," >&2
    echo "[run-dg] so lessons naming a task could enter the store mid-sweep. Not publishable." >&2
    exit 2
  fi
  # TB_SUBMITTABLE requires registry provenance, or the submission is EMPTY.
  #
  # Without TB_DATASET this driver runs `-p <local path>`, which stamps every
  # trial `source: "tasks"`. The leaderboard CI selects trials by
  # `t["source"] == "terminal-bench/terminal-bench-2-1"`
  # (leaderboard/core/hub.py) and enforces per-trial task digests against
  # DATASET@DATASET_REF, so a local run contributes ZERO trials -- the filter
  # drops all of them and the submission comes back EMPTY RATHER THAN WRONG,
  # which is the failure mode least likely to be noticed.
  #
  # MEASURED 2026-08-23: a 5-task smoke launched with TB_SUBMITTABLE=1 and no
  # TB_DATASET produced perfectly good trials, all stamped `source: "tasks"`.
  # A flag whose whole purpose is submission safety must not let that through,
  # or it manufactures the confidence that skips the check.
  if [ -z "${TB_DATASET:-}" ]; then
    echo "[run-dg] REFUSING: TB_SUBMITTABLE=1 but TB_DATASET is unset, so this would run from a" >&2
    echo "[run-dg] local path and every trial would be stamped source=\"tasks\" and dropped by the" >&2
    echo "[run-dg] leaderboard filter. Set the pinned registry id, e.g.:" >&2
    echo "[run-dg]   TB_DATASET=terminal-bench/terminal-bench-2-1@sha256:<ref-from-leaderboard/core/hub.py>" >&2
    exit 2
  fi
  echo "[run-dg] TB_SUBMITTABLE=1 — purity preflight mandatory, write gate active, prior-attempt outcomes suppressed"
fi
# ── TBENCH-ROSTER-COVERS-RUN-1: the gate can only protect tasks it knows ─────
# The purity roster (both the preflight scan and the proxy's write gate) is
# built from $TB21_DIR/tasks. The DATASET being run comes from TB_DATASET and is
# resolved by harbor from its own registry cache -- the two are separate sources
# and nothing made them agree. Run any release whose task set differs from this
# clone and the roster silently omits those names: lessons naming them pass the
# write gate and the store scan alike, and every check still reports CLEAN.
#
# Deriving the roster from harbor's cache is not the fix -- that cache POOLS
# tasks across datasets (162 entries for terminal-bench, spanning 2.1 and 3.0),
# so it is neither this dataset's roster nor a stable one.
#
# What can be asserted exactly is the property that actually matters: every task
# THIS JOB will run must appear in the roster. A task the roster does not know
# is a task the gate cannot protect, so it is a refusal rather than a warning.
if [ -n "${TB_TASKS:-}" ] && [ -d "$TB21_DIR/tasks" ]; then
  _missing=""
  for _t in $TB_TASKS; do
    _bare="${_t#*/}"
    [ -d "$TB21_DIR/tasks/$_bare" ] || _missing="$_missing $_bare"
  done
  if [ -n "$_missing" ]; then
    echo "[run-dg] REFUSING: these tasks are not in the purity roster ($TB21_DIR/tasks):$_missing" >&2
    echo "[run-dg] The write gate and the store scan both build their term list from that directory," >&2
    echo "[run-dg] so a lesson naming one of these tasks would NOT be caught. Point TB21_DIR at the" >&2
    echo "[run-dg] clone matching TB_DATASET before running." >&2
    exit 2
  fi
fi
if [ "${TB_SKIP_PURITY_CHECK:-0}" != "1" ] && [ -d "$TB21_DIR/tasks" ]; then
  if ! node "$HERE/store-purity-check.mjs" --data-dir "$BRAIN_DATA" --tasks "$TB21_DIR/tasks"; then
    echo "[run-dg] REFUSING: the bench store is not task-naive. Set TB_SKIP_PURITY_CHECK=1 only for a run you will NOT publish." >&2
    exit 2
  fi
fi

# ── TRIAL CONTAMINATION PREFLIGHT (TBENCH-ORACLE-FETCH-1) ────────────────────
#
# The store purity check above guards what the BRAIN knows and
# `write-purity.test.sh` guards what a trial WRITES BACK. Neither looks at what
# a trial READ FROM THE NETWORK, so oracle access was an unguarded class.
#
# MEASURED 2026-08-28: `mteb-retrieve__nXLVpLp` (jobs-hooksweep) fetched
#   .../harbor-framework/terminal-bench-2/main/tasks/mteb-retrieve/tests/test_outputs.py -> 200
# plus that task's solution.sh and task.yaml, read the expected string, said
# "Confirmed by the official test file", and only then wrote the matching
# answer. It scored 1.0 and was counted as a pass. The leaderboard judge classes
# oracle access as harness_level_cheating, which invalidates a submission — so a
# submittable run must not be built on a corpus that already contains one.
#
# Scoped to the SUBMITTABLE arm on purpose. A local iteration run may legitimately
# sit on a jobs dir with historical contamination; what must never happen is
# publishing it. Advisory (never fatal) otherwise, so the operator still sees it.
if [ -d "${TB_JOBS_DIR:-$HERE/jobs}" ]; then
  if [ "${TB_SUBMITTABLE:-0}" = "1" ]; then
    if ! node "$HERE/trial-contamination-check.mjs" --jobs "${TB_JOBS_DIR:-$HERE/jobs}" --quiet; then
      echo "[run-dg] REFUSING: TB_SUBMITTABLE=1 and this jobs dir contains a trial that read the" >&2
      echo "[run-dg] benchmark's own repo (oracle access). Re-run trial-contamination-check.mjs" >&2
      echo "[run-dg] without --quiet to see which, and exclude it before submitting." >&2
      exit 2
    fi
  else
    node "$HERE/trial-contamination-check.mjs" --jobs "${TB_JOBS_DIR:-$HERE/jobs}" --quiet --advisory || true
  fi
fi

# The body was previously fetched and thrown away. Keep `memory_total` from it:
# it is the cheapest BRAIN-SIDE witness that a learning run actually stored
# something, and it costs nothing extra — this request already happens.
brain_memory_total() {
  curl -s -m 8 "http://127.0.0.1:$BRAIN_PORT/health" 2>/dev/null \
    | python -c "import json,sys
try: print(json.load(sys.stdin).get('memory_total',''))
except Exception: print('')" 2>/dev/null || true
}

brain_pending_embed() {
  curl -s -m 8 "http://127.0.0.1:$BRAIN_PORT/health" 2>/dev/null \
    | python -c "import json,sys
try: print(json.load(sys.stdin).get('rag_quality',{}).get('pending_embedding_count',''))
except Exception: print('')" 2>/dev/null || true
}

# A LESSON THAT IS NOT EMBEDDED YET IS NOT RETRIEVABLE. Measured 2026-08-04 on
# the bench brain, same store and same queries, only time differing:
#
#   15 s after the write (pending>0) : the lesson missed even a query containing
#                                      its OWN literal phrase
#   after the backfill  (pending==0) : rank 1, on both that phrase AND a
#                                      paraphrase
#
# That is the whole cross-task-learning claim. With TB_DEFER_WRITES the lessons
# land at job END and run-sweep starts the next job seconds later, so without
# this wait task N+1 queries a brain that cannot yet see what task N learned —
# and the run would report "N lessons flushed" while the learning was inert.
# Same failure family as the instrumentation bugs: a step that reports success
# before the effect exists.
wait_for_embeddings() {  # $1 = label, $2 = max seconds
  local label="$1" max="${2:-900}" waited=0 pending
  pending="$(brain_pending_embed)"
  [ -z "$pending" ] && { echo "[run-dg] $label: embed backlog unknown (health unreadable) — continuing"; return 0; }
  [ "$pending" = "0" ] && { echo "[run-dg] $label: brain fully embedded (0 pending)"; return 0; }
  echo "[run-dg] $label: waiting for $pending pending embedding(s) — retrieval is degraded until this is 0"
  while [ "${pending:-0}" != "0" ] && [ "$waited" -lt "$max" ]; do
    sleep 10; waited=$((waited + 10))
    pending="$(brain_pending_embed)"
    [ $((waited % 60)) -eq 0 ] && echo "[run-dg]   ${waited}s: $pending still pending"
  done
  if [ "${pending:-0}" = "0" ]; then
    echo "[run-dg] $label: embedded after ${waited}s"
  else
    echo "[run-dg] $label: *** STILL $pending PENDING after ${max}s — retrieval is degraded, say so in the report. ***"
  fi
}
MEM_BEFORE="$(printf '%s' "$health_body" | head -n-1 | python -c "import json,sys
try: print(json.load(sys.stdin).get('memory_total',''))
except Exception: print('')" 2>/dev/null || true)"
echo "[run-dg] brain memory_total before the run: ${MEM_BEFORE:-<unavailable>}"
# A freshly reseeded store starts at rag 0% with every row queued. Starting a
# trial there measures keyword-only retrieval and calls it TerranSoul — the
# same shape as the LONGMEM_EMBED=1 regression, where a "retrieval regression"
# was really the dense channel being switched off.
wait_for_embeddings "preflight" "${TB_EMBED_WAIT_S:-1800}"

# RENDER the agent instruction against the rung ACTUALLY configured.
#
# Measured cost of getting this wrong, 2026-08-04: the file was written while
# `max` was the plan and said "expect a search to take minutes, not
# milliseconds". The sweep then moved to `think` (~0.5 s), and the first task
# wrote two lessons and ran ZERO searches — the instruction was describing a
# 100x cost that did not exist and discouraging the exact behaviour the bench
# exists to measure. A static file describing a configurable setting drifts the
# moment the setting changes, so it is templated and rendered per run instead.
INSTRUCTION_FILE="$(mktemp -t tb-instruction-XXXXXX.md)"
# `chat`, matching the proxy default (mcp-auth-proxy.mjs). THIS DEFAULT MUST
# TRACK THE PROXY'S: the value here only selects the sentence describing search
# COST to the agent, so a mismatch tells the agent it is getting a rung the
# proxy is not sending. Guarded by thinking-mode-layers.test.sh.
# Owner 2026-08-05: "use TerranSoul thinking mode set to think, not max" — max
# costs ~374 s per search versus ~1 s, and on a wall-clock-bounded benchmark a
# timeout scores 0 regardless of retrieval quality. That ruling is untouched:
# chat and think cost the SAME, so moving think -> chat on 2026-09-06 (for
# ranking — tools.rs: think "CAN AND DOES DROP RESULTS THE PLAIN PASS FOUND",
# NDCG@10 0.939 vs 0.510) keeps the latency criterion intact.
_rung="${TB_THINKING_MODE:-chat}"
case "$_rung" in
  chat)     _cost="Searches are fast (sub-second). Consult memory whenever it might help." ;;
  think)    _cost="Searches are fast — well under a second, plus a knowledge-graph bridge hop over the candidates. Consult memory whenever it might help; the cost is not a reason to skip it." ;;
  research) _cost="**A search takes several seconds** — it runs sub-queries and a completeness critic. Worth it when the answer matters; do not poll it." ;;
  max)      _cost="**A search can take minutes, not milliseconds** — it adds claim-level verification on top of deep recall. That is the setting, not a hang. Search when memory would genuinely help; do not poll it." ;;
  *)        _cost="Searches run at the server default. Consult memory when it might help." ;;
esac
# ── WALL-CLOCK BUDGET: the timeout root cause ───────────────────────────────
# Measured across this campaign: 9 of 89 tasks score 0 purely on wall clock,
# and the trajectories show WHY. `train-fasttext` burned five ~600 s blocks —
# ~48 of its 56 minutes — discovering the per-call tool timeout by HITTING it,
# and said so in its own words after the first: "Tool timeout capped at 10min;
# running the sweep detached instead." It then did it four more times.
#
# The agent already knows the PER-CALL cap — Claude Code's Bash tool states
# max 600000 ms in its own schema. What it has never been told is the TASK
# budget, and without that the two facts cannot be combined: a 10-minute
# blocking wait is cheap inside a 3600 s task and catastrophic inside a 900 s
# one, and 48 of 89 tasks here are 900 s. This is `budget as an observable`
# from docs/terminal-bench-submission-plan.md (TB-4a).
#
# PURITY: `timeout_sec` is a property of the RUNNER, not of the problem. It
# carries no task name, no hint, no domain vocabulary and nothing about how to
# solve anything — the same class of fact as the OS or the CPU count. Telling
# an agent how long it has is what any real product does;
# rules/bench-agi-purity.md forbids seeding ANSWERS, not describing the
# environment.
_budget=""
_budget_sec=""
# ⛔ AN EMPTY TASK LIST MUST FAIL LOUDLY. It has cost two runs in one
# session, from two different causes: a snapshot block that severed the env
# prefix so TB_TASKS never reached this script, and a caller whose task list
# came from a file Windows Python and Git Bash resolve to DIFFERENT paths.
#
# Both times the symptom was the same and gave nothing away: this line yielded
# an empty string, the task path below resolved to "tasks//task.toml", and the
# script exited 2 with NO message right after the brain preflight. Worse, an
# unrelated but LOUD "[contamination] ... REFUSING" line sat directly above it
# in the log, so the visible message was not the cause -- three runs were spent
# investigating innocent components.
#
# One line of validation turns that into a sentence.
if [ -z "${TB_TASKS:-${TASK:-}}" ]; then
  echo "[run-dg] NO TASKS: TB_TASKS and TASK are both empty — refusing to run." >&2
  echo "[run-dg]   Nothing downstream can work without a task id, and the failure" >&2
  echo "[run-dg]   further on is silent. Check the caller actually exported TB_TASKS:" >&2
  echo "[run-dg]   a severed backslash-continuation or a cross-shell temp path will" >&2
  echo "[run-dg]   drop it without any error of its own." >&2
  exit 2
fi
_first_task="$(echo "${TB_TASKS:-${TASK:-}}" | awk '{print $1}')"
# WHERE THE TASK DECLARES ITS OWN TIMEOUT depends on how the task got here. A
# local clone keeps `tasks/<name>/task.toml`; a registry dataset is unpacked
# into Harbor's cache under an extra content-hash directory. Without the second
# lookup a registry run silently loses the wall-clock budget line — and that
# line is not decoration: 9 of 89 tasks in the 2.1 campaign scored 0 purely on
# wall clock, one of them burning ~48 of its 56 minutes discovering the
# per-call cap by hitting it five times.
_first_task="${_first_task#*/}"   # registry ids arrive namespaced: `org/name`
_task_toml="$TB21_DIR/tasks/$_first_task/task.toml"
if [ ! -f "$_task_toml" ]; then
  _task_toml="$(ls -1 "$HOME/.cache/harbor/tasks/packages"/*/"$_first_task"/*/task.toml 2>/dev/null | head -1)"
fi
if [ -n "$_first_task" ] && [ -n "$_task_toml" ] && [ -f "$_task_toml" ]; then
  # SECTION-AWARE, because a bare `grep -m1 timeout_sec` reads the WRONG one.
  # A 3.0 task.toml declares `[verifier] timeout_sec` BEFORE `[agent]
  # timeout_sec`, so the first match on memcached-backdoor is 120.0 while the
  # agent actually has 7200.0. Telling an agent it has two minutes when it has
  # two hours is worse than telling it nothing: it would abandon exactly the
  # long-running work the budget line exists to let it plan for.
  _sec="$(awk '
    /^[[:space:]]*\[/ { section = $0 }
    section ~ /\[agent\]/ && /timeout_sec/ {
      if (match($0, /[0-9]+(\.[0-9]+)?/)) { print substr($0, RSTART, RLENGTH); exit }
    }' "$_task_toml" 2>/dev/null)"
  # Fall back to the old behaviour only when there is no [agent] section at all,
  # which is the 2.1 layout this driver was written against.
  [ -n "$_sec" ] || _sec="$(grep -m1 -oE 'timeout_sec[[:space:]]*=[[:space:]]*[0-9.]+' \
          "$_task_toml" 2>/dev/null | grep -oE '[0-9.]+' | head -1)"
  _sec="${_sec%%.*}"
  if [ -n "$_sec" ] && [ "$_sec" -gt 0 ] 2>/dev/null; then
    # Kept as a NUMBER as well as prose. The prose below tells the agent its
    # budget and has been in place for the whole campaign; run-dg.sh's own note
    # records 9 of 89 tasks scoring 0 purely on wall clock anyway, and
    # `extract-moves-from-video` timed out again on 2026-08-29 having never
    # written its deliverable. Telling is not enforcing, so the number is
    # exported to the PreToolUse hook, which can refuse a command that declares
    # more time than the task has left (TBENCH-WALLCLOCK-1).
    _budget_sec="$_sec"
    # ── THE CREDENTIAL MUST OUTLIVE THE TRIAL TOO (TBENCH-TOKEN-CEILING-1) ──
    # The same number is the token-headroom REQUIREMENT, and until 2026-09-13
    # nothing connected them: the credential gate was a flat 40 minutes, so a
    # 47-minute token was admitted to a 7200 s task at 07:34 and died at 08:16
    # with 98 model turns already produced (sam-cell-seg__EXhTsdQ). This script
    # is the only place that knows the ceiling, so it is the place that has to
    # publish it; token-refresh.sh turns it into max(40, ceiling + 30 min), and
    # TB_TOKEN_MIN_MINUTES still overrides. Exported rather than passed because
    # the credential block below SOURCES token-refresh.sh.
    export TB_TRIAL_CEILING_S="$_budget_sec"
    _budget="You have about **$(( _sec / 60 )) minutes of wall-clock** for this task. Overrunning it does not score your work as-is: the trial ERRORS and scores 0 even when what is on disk is correct, so your closing message must land before the wall — keep the last few percent of the budget for it. One blocking tool call can eat 10 minutes of that, so before running something slow, decide whether you can afford to wait; if not, background it and poll."
  fi
fi
[ -n "$_budget" ] || _budget="Work efficiently: overrunning the wall-clock ERRORS the trial and scores 0 even when the work on disk is correct, so finish with time left to report."

# ── THE BRAIN MUST OUTLIVE THE TRIAL (TBENCH-BRAIN-IDLE-1) ───────────────────
#
# ⛔ A HEALTHY BRAIN IS NOT A BRAIN THAT WILL STILL BE THERE AT THE END.
#
# MEASURED 2026-09-01, filter-js-from-html, ceiling 1800s: the brain was started
# on the MCP server's 300s default idle timeout. The agent called brain_search /
# brain_get_entry in its first three minutes, then worked locally — editing and
# running code in its container, which sends the MCP server NOTHING — and the
# idle watchdog shut the server down MID-TRIAL. When the Stop hook then filed
# `brain_verify_completion op=record`, the proxy answered
# `upstream unreachable`.
#
# The consequence is precisely the failure this campaign keeps chasing: the
# agent's self-reported "18/18 benign files byte-identical; 24 XSS vectors
# blocked" was never challenged, because the thing that challenges it had
# EXITED. The real grader then failed both halves (5 of 12 clean files modified,
# XSS still firing). The trial read as a capability failure; it was an
# infrastructure one, and $3.16 bought a result that could not mean anything.
#
# The server's own liveness clock cannot fix this. It already counts every
# authenticated request, not just tool calls — but a coding agent mid-task sends
# NO requests at all, so silence is indistinguishable from abandonment from the
# inside. The server cannot know the task's ceiling. This script does.
#
# So it is checked here, the same way /health is: fail CLOSED, before the trial
# spends money. `mcp_idle_timeout_secs` is published by /health for exactly
# this. A brain from an older build omits the field — that reads as unknown and
# warns rather than refusing, because a missing field must not block a run the
# operator may have configured correctly by hand.
if [ -n "${_budget_sec:-}" ] && [ "${_budget_sec:-0}" -gt 0 ] 2>/dev/null; then
  _idle="$(curl -s -m 10 "http://127.0.0.1:$BRAIN_PORT/health" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d).mcp_idle_timeout_secs;console.log(v===undefined||v===null?"":String(v))}catch{console.log("")}})' 2>/dev/null || echo '')"
  if [ -z "$_idle" ]; then
    echo "[run-dg] WARNING: brain on :$BRAIN_PORT does not report mcp_idle_timeout_secs" >&2
    echo "         (pre-2026-09-01 build). Cannot verify it will outlive a ${_budget_sec}s" >&2
    echo "         trial. If it idles out mid-run the Stop hook's verify call dies and the" >&2
    echo "         trial scores 0 for infrastructure reasons. Set TERRANSOUL_MCP_IDLE_TIMEOUT=0." >&2
  elif [ "$_idle" -gt 0 ] 2>/dev/null && [ "$_idle" -lt "$_budget_sec" ] 2>/dev/null; then
    echo "REFUSING: the brain will idle out BEFORE this trial ends." >&2
    echo "  brain idle timeout : ${_idle}s  (:$BRAIN_PORT)" >&2
    echo "  task ceiling       : ${_budget_sec}s" >&2
    echo "  An agent that works locally for ${_idle}s without a tool call loses the brain" >&2
    echo "  mid-run; the Stop hook's brain_verify_completion then fails 'upstream" >&2
    echo "  unreachable' and its self-reported success goes unchallenged." >&2
    echo "  Restart the brain with TERRANSOUL_MCP_IDLE_TIMEOUT=0 (or > ${_budget_sec})." >&2
    exit 6
  else
    echo "[run-dg] brain idle timeout: ${_idle}s vs ${_budget_sec}s ceiling — outlives the trial"
  fi
fi

# The deferral note MUST match the actual setting. It was hardcoded to the
# defer=1 wording — "writes are held until the task finishes, so they return no
# id and are not searchable yet" — which is FALSE under defer=0, where writes
# land immediately and DO return ids. Telling an agent it has no id is a
# plausible reason it then calls brain_append without one, and both rejected
# memory calls in this campaign were exactly that error.
if [ "${TB_DEFER_WRITES:-0}" = "1" ]; then
  _defer_note="**One real constraint, so you don't waste a call on it:** writes you make during this task are held until the task finishes, so they return no id and are not searchable yet. You can therefore append to and link entries from *previous* tasks, but not to something you wrote a moment ago in this one. That is deliberate — it stops one attempt at a task from feeding another."
else
  _defer_note="**Writes land immediately:** each one returns the new entry's id and is searchable straight away, so you can append to, link, or re-find something you wrote earlier in this same task."
fi

# ── OUTCOME FEEDBACK: the missing half of the self-improvement loop ─────────
#
# THE DEFECT THIS CLOSES. The agent never learned whether it succeeded. The
# verifier runs AFTER the trial ends, so every attempt finished believing it had
# solved the task, and wrote its lesson in that voice.
#
# Measured on `dna-insert`, 5 attempts, all scoring 0.0:
#   att1..att5  search=1  ingest=1  append=0  — five NEAR-DUPLICATE lessons,
#   every one of them about environment setup ("oligotm is not preinstalled but
#   `apt-get install -y primer3` works"), and NOT ONE recording that the attempt
#   failed or why. Attempt 2 inherited the easy knowledge — which it would have
#   rediscovered in a single command — and repeated the substantive mistake.
#   Five times. Web use DECLINED across the attempts (1,1,1,0,0) instead of
#   escalating, because nothing told the agent it was getting anything wrong.
#
# It also made "consult external sources when you are stuck" unimplementable:
# an agent in a fresh container cannot know it is attempt 3 of a failing task.
#
# So the harness now tells it. `TB_PRIOR_OUTCOMES` carries the previous
# attempts' verifier scores for THIS task, produced by run-sweep.par.sh between
# single-attempt jobs.
#
# PURITY: this reports the RUNNER's own verdict on prior attempts — a score and
# whether one occurred. It carries no task name, no hint, no walkthrough and
# nothing about how to solve anything. It is the same class of fact as the
# wall-clock budget above: describing the environment, not seeding an answer.
# A product that never tells an agent whether its work was accepted is the
# anomaly here; rules/bench-agi-purity.md forbids seeding ANSWERS.
# ⛔ SUBMITTABLE RUNS DO NOT GET THIS. The comment above argues, correctly,
# that a prior attempt SCORE seeds no ANSWER and so satisfies
# rules/bench-agi-purity.md. But the Terminal-Bench leaderboard judge applies a
# BROADER test than ours: harness_level_cheating is "harness gave privileged
# info the agent should not have", and it names PRIOR-RUN POST-MORTEMS
# explicitly (leaderboard/src/leaderboard/ci/analysis-task-template/
# instruction.md). Telling attempt 3 that attempts 1-2 scored 0 is information
# no independent trial has, and the instruction file pairs it with "search
# memory for what the last attempt tried" -- which is a post-mortem pipeline,
# not a status line. A positive verdict RENDERS THE SUBMISSION INVALID.
#
# Self-improvement is NOT switched off by this: lessons written during attempt
# 1 remain retrievable by later attempts through brain_search. What is removed
# is the HARNESS handing over trial outcomes. The purity gate in
# mcp-auth-proxy.mjs is what keeps those lessons generic, so what crosses the
# boundary is transferable technique rather than this task history.
_prior="${TB_PRIOR_OUTCOMES:-}"
if [ "${TB_SUBMITTABLE:-0}" = "1" ] && [ -n "$_prior" ]; then
  echo "[run-dg] TB_SUBMITTABLE=1 — discarding TB_PRIOR_OUTCOMES (prior-attempt outcomes are privileged info to the leaderboard judge)" >&2
  _prior=""
fi
if [ -z "$_prior" ]; then
  _prior="This is your **first attempt** at this task. No earlier attempt has been scored."
fi

sed -e "s/{{THINKING_MODE}}/$_rung/g" -e "s|{{THINKING_MODE_COST}}|$_cost|g" \
    -e "s|{{TASK_BUDGET}}|$_budget|g" -e "s|{{DEFERRAL_NOTE}}|$_defer_note|g" \
    -e "s|{{PRIOR_ATTEMPTS}}|$_prior|g" \
  "$HERE/extra-instruction.md" > "$INSTRUCTION_FILE"
# Fail CLOSED: an unrendered placeholder reaching the agent is a silent
# instruction bug, which is how the previous one survived a whole task.
if grep -q '{{' "$INSTRUCTION_FILE"; then
  echo "[run-dg] unrendered placeholder in the agent instruction — refusing to run" >&2
  grep -n '{{' "$INSTRUCTION_FILE" >&2
  exit 2
fi
# ── INSTRUCTION SIZE CEILING (Windows CreateProcess) ────────────────────────
# MEASURED 2026-09-02, and this cost a trial before it was caught. harbor ships
# the task prompt + this file to the container as an ENV VAR on the
# `docker compose exec` command line, and Windows caps a command line at 32767
# characters. Cross it and CreateProcess raises
#
#     FileNotFoundError: [WinError 206] The filename or extension is too long
#
# which harbor reports as a TRIAL ERROR: no reward.txt, no verifier output, and
# under leaderboard rules an errored trial scores 0. So this file silently
# ZEROES tasks once it grows past the limit -- the worst possible failure shape,
# because the cause is in the guidance rather than anything the agent did.
#
# Observed either side of the boundary on filter-js-from-html:
#     28500 bytes -> ran and graded
#     29358 bytes -> WinError 206, ungraded
#
# ⛔ THE CEILING IS NOT A CONSTANT, AND MY FIRST VERSION GOT THIS WRONG.
#
# The first cut reserved a flat 6000 bytes (ceiling 26500), a number picked by
# guessing rather than derived. Re-checked 2026-09-02 against the measurement:
#
#   overhead  = 32767 - instruction - prompt, bracketed by the two observations
#               above with filter-js's ~1258-byte prompt  ->  2151 .. 3009
#   longest task prompt in the suite = 4443
#               (llm-inference-batching-scheduler/instruction.md)
#   worst case = 32767 - 4443 - 3009 = 25315
#
# So 26500 sat 1185 bytes ABOVE the real limit: the guard would have cheerfully
# allowed a file that silently zeroes every trial on the longest-prompt task
# while passing on short-prompt ones. A guard whose constant is guessed is the
# same defect it exists to prevent, one level up.
#
# Derive it instead. The prompt is charged to the same 32767, so the reserve is
# the LONGEST prompt among the tasks THIS RUN will launch -- measured from the
# dataset, not assumed -- plus the observed worst-case overhead and a margin.
# A single-task redo of a short-prompt task therefore gets a genuinely higher
# ceiling than a full sweep, which is correct rather than merely lenient.
_instr_bytes="$(wc -c < "$INSTRUCTION_FILE" | tr -d '[:space:]')"
_tasks_dir="${TB_TASKS_DIR:-$TB21_DIR/tasks}"
_longest_prompt=0
if [ -d "$_tasks_dir" ]; then
  # Tasks in this run, or every task in the dataset when the run is unscoped.
  _scan_tasks="${TB_TASKS:-${TASK:-}}"
  if [ -z "$_scan_tasks" ]; then
    _scan_tasks="$(ls "$_tasks_dir" 2>/dev/null)"
  fi
  for _st in $_scan_tasks; do
    for _pf in "$_tasks_dir/$_st/instruction.md" "$_tasks_dir/$_st/README.md"; do
      [ -f "$_pf" ] || continue
      _pb="$(wc -c < "$_pf" | tr -d '[:space:]')"
      if [ "${_pb:-0}" -gt "$_longest_prompt" ]; then _longest_prompt="$_pb"; fi
    done
  done
fi
# Fall back to the largest prompt ever measured ONLY when the scan found
# nothing (unreadable dataset) -- never to a smaller reserve, which would
# reintroduce the silent failure. Applying this floor unconditionally, as the
# first draft did, throws away the per-run derivation entirely.
if [ "$_longest_prompt" -eq 0 ]; then _longest_prompt=4443; fi
# ⛔ UNITS MATTER, AND I GOT THEM WRONG TWICE.
# The overhead bracket must be derived in the SAME units the guard measures:
# the RENDERED instruction. The first derivation used the SOURCE sizes of the
# two boundary observations (28500 ran / 29358 failed) and filter-js's prompt
# taken from an unrelated comment (1258, actually 1938), overstating overhead
# by ~1380. Redone in rendered terms -- placeholders expand ~700 bytes, so
# those runs shipped ~29200 and ~30058:
#     overhead <= 32767 - 29200 - 1938 = 1629   (the run that WORKED)
#     overhead >  32767 - 30058 - 1938 =  771   (the run that FAILED)
# Take the high end, 1629, plus a 500 margin.
_instr_ceiling="${TB_INSTRUCTION_CEILING:-$((32767 - _longest_prompt - 1629 - 500))}"
if [ "$_instr_bytes" -gt "$_instr_ceiling" ]; then
  echo "[run-dg] agent instruction is ${_instr_bytes} bytes, over the ${_instr_ceiling}-byte ceiling — refusing to run" >&2
  echo "[run-dg]   Windows caps a command line at 32767 chars; harbor puts this file on it." >&2
  echo "[run-dg]   Over the limit every trial ERRORS ungraded (reward 0), it does not fail loudly." >&2
  echo "[run-dg]   Fix by trimming extra-instruction.md, not by raising TB_INSTRUCTION_CEILING." >&2
  exit 2
fi
echo "[run-dg] agent instruction rendered for thinking_mode='$_rung' (${_instr_bytes}/${_instr_ceiling} bytes)"

# Credential FIRST, before anything is started or written. OWNER DECISION
# 2026-08-04: subscription OAuth token rather than a metered API key; the
# accepted risk is recorded in the playbook. Minted by the owner with
# `claude setup-token` — an interactive browser flow, so no agent can produce
# it. Checked up here so a missing token cannot leave a listening proxy behind.
TOKEN_FILE="${TB_TOKEN_FILE:-$REPO/mcp-data/.tb-token.env}"

# REFRESH BEFORE READ. 2026-08-29: a single-task redo burned 14m35s of
# container setup and then died 2.3s into the agent on "401 OAuth access token
# has been revoked" -- 0 input tokens, 0 cost, 0 MCP calls: a run that never
# happened, recorded as a task failure. token-refresh.sh already existed and
# its own header claimed "Every entry point now sources this ONE file", but
# this driver -- which EVERY single-task path funnels through -- only ever READ
# $TOKEN_FILE. Measured at the moment of the failure: the file was written at
# 16:14 and no longer matched the host credential, which had since rotated and
# held 418 min of headroom. The container was handed a token the host had
# already replaced. Fixed HERE rather than in each caller, because this same
# file's header records the copy-into-every-driver approach failing once before.
if [ "${TB_SKIP_TOKEN_REFRESH:-0}" != "1" ] && [ -r "$HERE/token-refresh.sh" ]; then
  # shellcheck disable=SC1091
  . "$HERE/token-refresh.sh"
  if ! refresh_token; then
    echo "[run-dg] STOPPING: no usable credential. A run that never happened is" >&2
    echo "[run-dg] not a task failure -- do NOT record this as a result." >&2
    exit 2
  fi
  # refresh_token wrote the live token to $TOKEN_FILE, so the FILE is now
  # authoritative. A pre-set env var can only be staler -- that is exactly how
  # the dead 16:14 token propagated -- so drop it and re-read below.
  unset CLAUDE_CODE_OAUTH_TOKEN
fi

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  :
elif [ -s "$TOKEN_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$TOKEN_FILE"; set +a
else
  echo "no credential: set CLAUDE_CODE_OAUTH_TOKEN or write $TOKEN_FILE" >&2
  exit 2
fi
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "$TOKEN_FILE did not define CLAUDE_CODE_OAUTH_TOKEN" >&2; exit 2; }

# EXPIRY IS NOT VALIDITY. refresh_token gates on the host credential's
# expiresAt, which cannot see a REVOKED token: the 401 above arrived while the
# credential reported hours of headroom. So probe the real auth path once,
# cheaply, before committing to a container. ~5 s here replaces ~15 min of
# setup spent discovering the same thing the hard way.
if [ "${TB_SKIP_TOKEN_PROBE:-0}" != "1" ] && command -v claude >/dev/null 2>&1; then
  _probe_out="$(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" ANTHROPIC_API_KEY= timeout 90 claude -p "ok" 2>&1 | head -c 400 || true)"
  case "$_probe_out" in
    *"has been revoked"*|*"Failed to authenticate"*|*"authentication_failed"*|*"API Error: 401"*)
      echo "[run-dg] STOPPING: credential present but REJECTED by the API." >&2
      echo "[run-dg] probe said: $(printf '%s' "$_probe_out" | tr '\n' ' ' | head -c 200)" >&2
      echo "[run-dg] Re-authenticate on the host, or mint a long-lived token via" >&2
      echo "[run-dg] 'claude setup-token' + TB_TOKEN_STATIC=1. Not recording a result." >&2
      exit 2 ;;
    *) echo "[run-dg] credential probe: accepted by the API" ;;
  esac
fi
# Stop here on request. The credential work above is the only part of a launch
# that can fail in under a minute, so exposing it as its own exit lets an
# operator -- and the regression test -- confirm a token is live in ~5 s rather
# than discover it 15 min into container setup, which is what the 2026-08-29
# 401 cost. Nothing has been started or written at this point.
if [ "${TB_PREFLIGHT_ONLY:-0}" = "1" ]; then
  echo "[run-dg] preflight-only: credential is live; exiting before any container starts"
  exit 0
fi

# --- MCP auth: the gate that stops a silent zero-brain run --------------------
#
# /health is OPEN but /mcp is NOT. Measured 2026-08-04: an unauthenticated
# POST to /mcp returns
#     {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"unauthorized"}}
# with HTTP 401, while the same POST carrying `Authorization: Bearer <token>`
# returns 200 and the full tools list.
#
# The committed terransoul.mcp.json used to carry NO auth header at all. That
# does not fail the run — Claude Code simply comes up without the brain tools,
# solves the task on its own, and the trial produces a perfectly plausible
# score. It is precisely the failure rules/tbench-playbook.md warns about:
# "A pass with zero MCP calls is Claude Code's score with TerranSoul as
# decoration." Checking /health alone would never have caught it, because
# /health answers 200 for everyone.
#
# So: render the config with the real token (no reliance on the container
# expanding ${...}), and PROVE the token works before spending anything.
MCP_TOKEN_FILE="${TERRANSOUL_MCP_TOKEN_FILE:-$BRAIN_DATA/mcp-token.txt}"
[ -s "$MCP_TOKEN_FILE" ] || { echo "no MCP token at $MCP_TOKEN_FILE; start the brain with: bash ${TB_DRIVER_HOME:-$HERE}/start-bench-brain.sh (NOT copilot-start-mcp.mjs, which reuses the production tray on :7423 and never binds :$BRAIN_PORT)" >&2; exit 2; }
TERRANSOUL_MCP_TOKEN="$(tr -d '\r\n' < "$MCP_TOKEN_FILE")"

mcp_code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:$BRAIN_PORT/mcp" \
  -H "Authorization: Bearer $TERRANSOUL_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' || true)"
[ "$mcp_code" = "200" ] || { echo "MCP tools/list returned $mcp_code with the token from $MCP_TOKEN_FILE — refusing to run, the trial would score plain Claude Code" >&2; exit 2; }

# --- the header-injecting proxy -----------------------------------------------
#
# Harbor CANNOT deliver an auth header to the container: its
# claude_code.py::_build_register_mcp_servers_command emits exactly
# {"type", "url"} for http servers and silently drops `headers` (and carries no
# `env` for stdio). TerranSoul's router accepts ONLY a bearer header. So the
# container talks to this proxy instead, and the proxy adds the header on the
# host side — the real token never enters the container.
#
# The proxy blocks write tools by default (TB-3: "0 brain writes during a
# 5-task run"). TB_PROXY_ALLOW_WRITES=1 lifts that, and then the run is NOT a
# clean measurement.
PROXY_PORT="${TB_PROXY_PORT:-7425}"
# ⛔ PER-WORKER PATH. This was ONE shared file for every worker, TRUNCATED at
# the start of every task (`: > "$PROXY_LOG"`), and it silently corrupted the
# campaign's decisive attribution evidence.
#
# With N parallel workers: worker A truncates the log while worker B is
# mid-task; both proxies then append to the same file; and at task end each
# worker runs check-terransoul-used.sh against it and copies it into ITS OWN
# job dir as terransoul-proxy-calls.jsonl. So witness 3 — the one the playbook
# calls DECISIVE, and the only evidence that the brain was genuinely used —
# counted other workers' calls and lost its own to truncation.
#
# MEASURED 2026-08-06, and it disagreed with the raw logs in BOTH directions:
#   worker 0 witness "6 accepted, 1 refused"  <- its own log had 0 refusals
#   worker 2 witnesses "0 refused" (x3)       <- its own log HAD the refusal
# It also produced a false finding — a task appeared to make ZERO brain calls,
# which reads exactly like "the agent ignored memory" (the failure mode the
# playbook warns about as "TerranSoul as decoration") when it was really
# another worker truncating the file mid-task.
#
# The proxy port is already unique per worker, so it is the natural
# discriminator — same fix as MCP_CONFIG above, same root assumption.
PROXY_LOG="$REPO/mcp-data/.tb-proxy-calls-$PROXY_PORT.jsonl"
: > "$PROXY_LOG"

TERRANSOUL_MCP_TOKEN="$TERRANSOUL_MCP_TOKEN" \
TB_PROXY_PORT="$PROXY_PORT" \
TB_PROXY_LOG="$PROXY_LOG" \
TB_PROXY_MODE="${TB_PROXY_MODE:-}" \
TB_DEFER_WRITES="${TB_DEFER_WRITES:-}" \
TB_PROXY_UPSTREAM_PORT="$BRAIN_PORT" \
  TB_TASKS_DIR="${TB_TASKS_DIR:-$TB21_DIR/tasks}" \
  TB_TRIAL_SCOPE="${TB_TRIAL_SCOPE:-tb-$PROXY_PORT-$(date +%s)}" \
  node "$HERE/mcp-auth-proxy.mjs" &
PROXY_PID=$!

# ⛔ THE PORT ANSWERING IS NOT THE SAME AS OUR CHILD ANSWERING.
# The readiness check below POSTs to $PROXY_PORT and accepts any 200. If a
# leftover proxy from an earlier run still holds the port, the child we just
# spawned dies instantly on EADDRINUSE (the proxy registers no 'error' handler
# on its server) and the gate passes anyway -- reporting "proxy up (pid N)" for
# a pid that is already dead. The trial then runs against the STALE process's
# upstream port, learn-mode flag, allow-writes flag and task-identity term list,
# which may predate every fix in this file. Measured 2026-08-24: exactly this
# left worker 0 dead for three hours while the run looked healthy.
# `kill -0` below closes it by asking about the child, not the socket.

# FLUSH BEFORE KILLING THE PROXY, ON EVERY EXIT PATH.
#
# THE BUG THIS FIXES, measured 2026-08-05 over this campaign's own log: 98
# flushes across 119 task runs — 21 runs (18%) never flushed at all, and every
# lesson they had written was lost.
#
# Mechanism: this script runs `set -euo pipefail` (line 11), and the explicit
# flush sits AFTER the harbor invocation. When harbor exits non-zero, `set -e`
# terminates the script before reaching it, and the old trap only killed the
# proxy. Deferred writes live in the proxy until `__flush`, so killing it
# unflushed discards them silently — the run still reports its trial result, so
# nothing looks wrong.
#
# WHY IT IS THE WORST POSSIBLE 18%: harbor exits non-zero on errored and
# timed-out tasks, which are precisely the runs whose lessons are worth most.
# `train-fasttext` burned 5 blocks of ~600s rediscovering that the tool timeout
# is capped at 10 minutes, called brain_ingest_lesson once, and the lesson died
# with the script — so the NEXT task rediscovered the same cap from scratch.
# The self-improvement loop was losing exactly the failures it exists to learn
# from, which is why a headline "100% of tasks wrote a lesson" was measuring
# CALLS ISSUED (intent) rather than WRITES PERSISTED (effect).
#
# The trap is the safety net; the explicit post-harbor flush stays because it
# also waits for embeddings (a lesson that exists but is not embedded is not yet
# retrievable). Flushing twice is harmless — the second returns flushed:0.
_flush_deferred_on_exit() {
  local rc=$?
  # DISARM FIRST. Without this the handler re-enters itself: it ends in
  # `return $rc`, and a non-zero return from an EXIT trap under `set -e`
  # re-triggers EXIT. Caught by flush-on-failure.test.sh, which observed one
  # `rc=1` followed by an unbounded run of `rc=0` rescues — in production that
  # is a log flood and a hang on a curl-per-iteration.
  trap - EXIT INT TERM
  if [ "${TB_DEFER_WRITES:-}" = "1" ] && [ -n "${PROXY_PORT:-}" ]; then
    local out
    out="$(curl -s -m 60 -X POST "http://127.0.0.1:$PROXY_PORT/__flush" 2>/dev/null || true)"
    # Only announce when something was actually rescued, so the success path
    # (already flushed) stays quiet instead of printing a misleading second line.
    case "$out" in
      *'"flushed":0'*|'') : ;;
      *) echo "[run-dg] LATE FLUSH on exit rc=$rc — rescued deferred lessons: $out" >&2 ;;
    esac
  fi
  kill "${PROXY_PID:-0}" 2>/dev/null || true
  # The rendered instruction file is a per-task mktemp and nothing reaped it:
  # 93 `tb-instruction-*.md` were found in /tmp after ~180 trials. Individually
  # ~0.8 MB total, so this is hygiene rather than a disk risk — but it is the
  # kind of leak that is invisible until a long sweep makes it large, and the
  # EXIT trap is the only path that runs on BOTH the success and the harbor-
  # non-zero exit (see the flush rationale above). Deleted last so a failure
  # here can never cost a deferred lesson.
  rm -f "${INSTRUCTION_FILE:-}" 2>/dev/null || true
  return $rc
}
trap _flush_deferred_on_exit EXIT INT TERM

# Do not race the run against a proxy that has not bound yet.
for _ in $(seq 1 20); do
  if curl -s -m 2 -o /dev/null -X POST "http://127.0.0.1:$PROXY_PORT/mcp" \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; then
    break
  fi
  sleep 0.5
done
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "[run-dg] REFUSING: the proxy we spawned (pid $PROXY_PID) is not running. If :$PROXY_PORT still" >&2
  echo "[run-dg] answers, a STALE proxy from an earlier run owns it and this trial would silently use" >&2
  echo "[run-dg] its settings. Stop it:  npx --yes kill-port $PROXY_PORT   (or kill the listener by pid)" >&2
  exit 2
fi
proxy_code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' || true)"
[ "$proxy_code" = "200" ] || { echo "proxy on :$PROXY_PORT returned $proxy_code — refusing to run" >&2; exit 2; }
echo "[run-dg] MCP auth proxy up on :$PROXY_PORT (pid $PROXY_PID)"

# The template already points at the proxy port and carries no headers, since
# harbor would drop them. Copied rather than rendered — nothing secret in it.
# PER-PORT PATH, NOT A SHARED ONE. This was `$REPO/mcp-data/.tb-mcp.json` for
# every worker, and the file's whole purpose is to carry THIS worker's proxy
# port — so N workers raced to overwrite one file with N different ports. The
# damage is quiet and it corrupts the measurement rather than crashing: a
# container can be handed another worker's port, so its brain calls land in the
# wrong proxy log (mis-attributing the `check-terransoul-used` witnesses), and
# when that other worker's task ends it tears down the proxy the first
# container is still using — brain access disappears mid-task. The proxy port
# is already unique per worker (7425+w), so it is the natural discriminator.
MCP_CONFIG="$REPO/mcp-data/.tb-mcp-$PROXY_PORT.json"
sed "s|host.docker.internal:7425|host.docker.internal:$PROXY_PORT|" "$HERE/terransoul.mcp.json" > "$MCP_CONFIG"


# Reap leftover containers from a previous run — but ONLY for the tasks THIS
# invocation is about to run.
#
# ⛔ THE UNSCOPED VERSION SABOTAGED EVERY PARALLEL SWEEP. It was
#     docker ps -a --format '{{.Names}}' | grep -E 'env-main' | xargs -r docker rm -f
# which is correct for ONE sequential runner and catastrophic for N workers:
# every worker runs this at the start of every task, so worker B force-removed
# worker A's LIVE container. The victim died with SIGKILL, which harbor reports
# as `NonZeroAgentExitCodeError: Command failed (exit 137)` from inside
# _setup_agent — indistinguishable, in the result.json, from the container
# running out of memory.
#
# MEASURED 2026-08-06, and it cost a whole diagnosis before the cause was found:
#   * 40 k=2 trials died this way; errors tracked WORKER COUNT, not any one
#     worker (15/9/8/8 across four) because each worker kills the others;
#   * the victims died 5s, 7s and 38s into setup — far too fast for either a
#     timeout or gradual growth into the 2 GiB cap;
#   * `dmesg` in the docker-desktop distro showed ZERO OOM records, and
#     `docker stats` showed live containers at 40-94 MiB against their 2 GiB
#     limit. Nothing was ever out of memory.
# The 2048 MB cap is declared per task in `task.toml [environment] memory_mb`
# and is part of the benchmark spec — it is NOT ours to raise
# (rules/bench-agi-purity.md), and it was never the problem.
#
# Scoping by task name is safe because a container is named
# `<task>__<trialid>__env-main-1`: a worker only ever reaps the tasks it owns,
# and shards never overlap.
_reap_stale_containers() {
  local wanted="${TB_TASKS:-${TASK:-}}"
  if [ -z "$wanted" ]; then
    # Whole-suite run (no -i): there is by definition no other worker to
    # damage, so the original blanket reap is correct here.
    docker ps -a --format '{{.Names}}' | grep -E 'env-main' \
      | xargs -r docker rm -f >/dev/null 2>&1 || true
    return
  fi
  local pat="" t
  for t in $wanted; do pat="${pat:+$pat|}^${t}__"; done
  docker ps -a --format '{{.Names}}' | grep -E 'env-main' | grep -E "$pat" \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  _reap_stale_networks "$pat"
}

# ⛔ NETWORKS LEAK TOO, AND THE FAILURE IS A HARD STOP FOR THE WHOLE HOST.
# Every trial creates a bridge network `<task>__<trialid>__env_default` and
# nothing removed them. Docker's DEFAULT pool is base 172.17.0.0/12 at size 16,
# i.e. only ~16 networks, so a sweep exhausts it and then EVERY task dies at
# `docker compose up` with:
#     failed to create network ...: all predefined address pools have been
#     fully subnetted
# Measured 2026-08-06: 28 of the host's 32 networks were orphaned `__env`
# leftovers, and the sweep could not start a single task. This is worse than
# the container leak — a stale container wastes disk, an exhausted address pool
# stops all Docker work on the machine, including other projects.
#
# Two independent guards, because either alone is fragile: this reap (scoped by
# task name, exactly like the container reap above, so parallel workers never
# touch each other's live networks), plus a widened pool in the daemon config
# (~/.docker/daemon.json default-address-pools 172.17.0.0/12 at size 24 = 4096
# networks) so a burst cannot exhaust it between reaps.
_reap_stale_networks() {
  local pat="$1"
  [ -n "$pat" ] || return 0
  # `docker network rm` refuses a network that is still attached to a running
  # container, so this cannot disturb a live trial even if the pattern were
  # ever widened. Failures are ignored for exactly that reason.
  # ⚠️ THE TRAILING `|| true` IS LOAD-BEARING, not defensive noise. `grep` exits
  # 1 when it matches NOTHING, and this script runs `set -euo pipefail`, so on
  # the normal path — no leftover networks — the pipeline returns 1 and takes
  # the whole run down. It fails SILENTLY: run-dg dies between "MCP auth proxy
  # up" and "job=", printing nothing, and the sweep reports the task as
  # "FAILED before producing a result (preflight/infra)". Measured on three
  # tasks in a row before the cause was found. This is the same trap
  # check-terransoul-used.sh already documents for `grep -c`.
  docker network ls --format '{{.Name}}' 2>/dev/null | grep -E '__env' \
    | grep -E "$pat" | while read -r n; do
      docker network rm "$n" >/dev/null 2>&1 || true
    done || true
  # A GLOBAL orphan sweep is deliberately NOT done here. It would race exactly
  # like the container reap did: between `compose up` creating a network and
  # attaching its container there is a window in which the network has zero
  # containers and looks like an orphan to a sibling worker. Scoped reap plus
  # the widened pool is the race-free combination.
  #
  # Make the remaining headroom VISIBLE instead, so exhaustion can never again
  # present as an unexplained wall of task failures (it cost a full diagnosis
  # once). Report only when it actually matters.
  local n_net
  n_net="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -c '__env' || true)"
  if [ "${n_net:-0}" -gt 200 ]; then
    echo "[run-dg] WARNING: $n_net leftover '__env' networks. Docker's pool is" >&2
    echo "[run-dg]          finite; if 'all predefined address pools have been" >&2
    echo "[run-dg]          fully subnetted' appears, clear them with:" >&2
    echo "[run-dg]            docker network ls --format '{{.Name}}' | grep __env | xargs -r -n1 docker network rm" >&2
  fi
}
_reap_stale_containers

# TB_JOB_PREFIX lets a sweep tag every job it creates so merge-sweep.sh can
# select exactly that run. jobs/ accumulates probes and aborted runs, and a
# Windows file lock made moving the directory aside impossible — filtering by
# name is more robust than relocating files.
JOB="${TB_JOB_PREFIX:-dg}-$(date +%Y%m%d-%H%M%S)"

# -p must point at the tasks/ SUBDIRECTORY. Resolving by dataset name instead
# pulls `terminal-bench-core`, a DIFFERENT and partly contaminated benchmark
# that runs cleanly and scores plausibly.
# -m claude-opus-5 is Opus 5. `claude-opus-4-5` is Opus 4.5 and was passed by
# mistake once; it is a different model.
# ── DATASET PROVENANCE, and why `-p` is not submittable ─────────────────────
# `-p <path>` runs the tasks but stamps each trial with
#     task: { type: "local", source: "tasks", path: "D:\\...\\tasks\\<task>" }
# The leaderboard's CI selects trials with `t["source"] == DATASET`, where
# DATASET is the registry name `terminal-bench/terminal-bench-2-1`
# (leaderboard/src/leaderboard/core/hub.py). A local run therefore contributes
# ZERO trials to a submission — the filter drops every one, and the submission
# is empty rather than wrong, which is the failure mode least likely to be
# noticed.
#
# Verified 2026-08-06 before switching: the pinned ref resolves to exactly the
# same 89 tasks, and all 89 task.toml files are byte-identical to this repo's
# local clone once CRLF is normalised (the clone has CRLF, the registry LF).
# So the measurements taken via `-p` were on the right content; only their
# provenance was untaggable.
#
# The playbook's warning about `-d` stands but is narrower than it reads: a
# BARE dataset name resolves to `terminal-bench-core`, a different and partly
# contaminated benchmark. A pinned `org/name@sha256:...` does not.
#   TB_DATASET unset -> -p <local path>   (fast local iteration, NOT submittable)
#   TB_DATASET set   -> -d <name@ref>     (registry provenance, submittable)
if [ -n "${TB_DATASET:-}" ]; then
  DATASET_ARGS=(-d "$TB_DATASET")
  echo "[run-dg] dataset: REGISTRY $TB_DATASET (submittable provenance)"
else
  DATASET_ARGS=(-p "$TB21_DIR/tasks")
  echo "[run-dg] dataset: local path (fast iteration; NOT submittable)"
fi

# ── AGENT IDENTITY ───────────────────────────────────────────────────────────
# Harbor records the trial's agent from the literal `-a` string (it lands in
# config.agents[].name and lock.json verbatim; overriding BaseAgent.name() does
# NOT change it — verified by probe). The leaderboard builds a row's identity
# from that string, so a run launched as `claude-code` becomes a Claude Code row.
#
# A custom agent is loaded by IMPORT PATH, and harbor runs from its own uv-tool
# venv which has no idea this repo exists. Without $HERE on PYTHONPATH the run
# dies at agent construction with a bare ModuleNotFoundError, which the sweep
# reports only as "FAILED before producing a result (preflight/infra)" — the
# same opaque symptom the namespaced-task-name bug produced.
if [ -n "${TB_AGENT:-}" ] && [ "${TB_AGENT}" != "claude-code" ]; then
  export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
fi
#
# TB_AGENT unset -> claude-code                (local iteration; matches upstream)
# TB_AGENT set   -> a custom import path, e.g. "terransoul:TerranSoul"
#                   (owner decision 2026-08-06 — see terransoul.py, which also
#                    records the playbook rule this overrides). The raw key is
#                    mapped to a readable name via the leaderboard's
#                    display-names.json, which SUBMIT.md is explicit is the
#                    place to do that.
# ⛔ THE MODEL IS THE PROVENANCE OF THE NUMBER. It was hardcoded here, so
# switching models required editing this file — which cannot be done while a
# sweep runs (bash reads scripts lazily), and which leaves no record in the run
# of what was actually used. `TB_MODEL` makes it a launch parameter that the
# `.tb-parN.launch` record carries, so a relaunched worker cannot silently
# change models mid-campaign.
#
# The default stays `claude-opus-5` deliberately: every trial in `jobs-submit/`
# was produced by it, and a default that drifted would make an existing corpus
# ambiguous about its own provenance.
#
# ⚠️ NEVER MIX MODELS IN ONE JOBS DIR. `merge-sweep.sh` takes the best trial per
# task, so a directory holding both models yields a score attributable to
# neither — and one that flatters whichever model happened to win each task.
# Give each model its own TB_JOBS_DIR (e.g. jobs-submit/ for Opus 5,
# jobs-sonnet5/ for Sonnet 5) and publish them as separate entries.
#
# Model ids are exact: `claude-opus-5`, `claude-sonnet-5`. `claude-opus-4-5` is
# Opus 4.5 and was passed by mistake once; it is a different model.
args=(
  run
  -a "${TB_AGENT:-claude-code}"
  -m "${TB_MODEL:-claude-opus-5}"
  "${DATASET_ARGS[@]}"
  --env docker
  --mcp-config "$MCP_CONFIG"
  -o "${TB_JOBS_DIR:-$HERE/jobs}" --job-name "$JOB"
  -k "$ATTEMPTS" -n "$CONCURRENCY" -y
  # ── TBENCH-SETUP-RETRY-1: retry ONLY failures that precede the agent ───────
  #
  # MEASURED 2026-08-24. The agent install step downloads a 297 MB Claude Code
  # binary INSIDE EVERY TRIAL:
  #     curl -fsSL .../claude-code-releases/bootstrap.sh | bash -s --
  # On an idle machine that is 28 s at 11 MB/s. With two workers pulling it at
  # once, plus any other disk or network load, it crosses the 360 s agent-setup
  # budget and the trial dies before the agent ever starts. Between 02:06 and
  # 02:39 EVERY started trial failed this way -- 8 tasks lost, none of them a
  # capability result. At k=1 this sweep pulls ~26 GB; a k=5 sweep would pull
  # ~132 GB of the identical file.
  #
  # WHY RETRYING THIS IS HONEST, and why the retry list is exactly one entry.
  # `AgentSetupTimeoutError` is raised BEFORE the agent runs, so a retry does
  # not hand the task a second attempt at solving anything -- it re-attempts the
  # INSTALL. That is the same reasoning the campaign already applies to an
  # environment that fails to build ("re-run as its own job, which is honest
  # because the agent never ran").
  #
  # ⛔ DO NOT WIDEN THIS LIST. `AgentTimeoutError` means the agent ran and spent
  # its whole budget -- retrying that buys a second attempt and is cheating.
  # A bare `--max-retries` with no `--retry-include` retries EVERYTHING, which
  # is precisely the footgun the playbook warns about: it would also retry a
  # RuntimeError raised AFTER the agent ran. One named exception, deliberately.
  #
  # This is NOT a timeout override: the 360 s budget is untouched, so the
  # leaderboard CI's "No agent timeout overrides" check still passes. Any
  # submission built on this run must nonetheless DISCLOSE that setup-timeout
  # retries were enabled and say how many trials used one.
  --max-retries "${TB_SETUP_RETRIES:-2}"
  --retry-include AgentSetupTimeoutError
  # ── TBENCH-API-RETRY-1: transient upstream API failures ────────────────────
  #
  # MEASURED 2026-08-24 on jobs-final-k1. At 38 of 89 tasks, SEVEN trials had
  # errored and SIX were server-side:
  #     API Error: 529 Overloaded ... "This is a server-side issue, usually
  #     temporary - try again in a moment."
  # plus one 500. Others absorbed 529s mid-run without dying. That is a ~16%
  # infrastructure failure rate, and it moved the headline from 93.5% (excluding
  # them) to 76.3% (counting them as zeros) -- neither of which measures the
  # agent.
  #
  # SAME PRINCIPLE AS THE SETUP RETRY ABOVE, and it is the only principle that
  # makes any of this honest: a 529 is returned BEFORE the model produces a
  # turn, so a retry re-attempts THE API CALL, not the task. The agent gets no
  # extra thinking, no extra attempt, and no knowledge it did not have.
  #
  # ⛔ STILL DO NOT ADD AgentTimeoutError. That one means the agent RAN and spent
  # its entire budget; retrying it buys a second attempt and is cheating. The
  # list stays limited to failures that precede the agent's work.
  #
  # A run using this MUST disclose it and state how many trials consumed a
  # retry -- an upstream outage during the measurement window is part of the
  # provenance of the number.
  #
  # ⛔ "BEFORE THE MODEL PRODUCES A TURN" IS TRUE OF THE FIRST CALL AND FALSE OF
  # EVERY LATER ONE, AND HARBOR MATCHES ON THE NAME ALONE. Measured 2026-09-09
  # (sam-cell-seg__c9CHYJ2): the Stop hook's judge had answered verified:true,
  # the note that rides the block forced one more turn, THAT call failed with
  # `API Error`, and harbor's `_execute_trial_with_retries` deleted 45 minutes
  # of graded work and re-ran the task from scratch -- the second attempt this
  # comment says the list must never buy. The list below is therefore
  # NECESSARY, NOT SUFFICIENT: terransoul_hook.py (TBENCH-LATE-API-RETRY-1)
  # refuses the retry once the failed attempt has produced agent work (output
  # tokens, a model turn in the host-side capture, or an agent step in the
  # trajectory), keeps the graded result with the exception as provenance, and
  # moves a genuinely never-ran attempt to retried-attempts/ instead of
  # deleting it. Adding a name here still cannot hand a finished task a second
  # attempt; that is now enforced in code rather than by this paragraph.
  --retry-include ApiInternalServerError
  --retry-include UnknownApiError
  # ── TBENCH-API-RETRY-2: rate limits, the class that actually dominates ─────
  #
  # The principle above is right and this entry follows it exactly: a 429 is
  # returned BEFORE the model produces a turn, identically to the 529 the
  # comment already justifies retrying. The agent gets no second attempt at the
  # task, no extra thinking, and no knowledge it did not have.
  #
  # MEASURED 2026-08-28 across every trial in `jobs-*` (113 errored of 1,155):
  #
  #     ApiRateLimitError          28   <-- largest class, was NOT retried
  #     AgentSetupTimeoutError     23       retried
  #     AgentTimeoutError          21       correctly refused (the agent RAN)
  #     NonZeroAgentExitCodeError  20       ambiguous, deliberately not added
  #     UnknownApiError            14       retried
  #     ApiInternalServerError      1       retried
  #
  # TBENCH-API-RETRY-1 was written to rescue "six 529 Overloaded" trials and
  # added ApiInternalServerError, which has fired ONCE in the entire corpus —
  # harbor maps `API Error: Overloaded` to a SEPARATE `ApiOverloadedError`, and
  # the measured string `API Error: 529 Overloaded` matches neither pattern, so
  # those 529s were actually caught by UnknownApiError. The fix worked by
  # accident while the dominant transient class went unretried: 28 trials banked
  # as hard zeros, concentrated in the long, API-heavy tasks
  # (extract-moves-from-video 10, filter-js-from-html 7, fix-ocaml-gc 4,
  # gpt2-codegolf 4). The leaderboard counts an errored trial as reward 0 and
  # does not exclude it, so each one is a lost task — roughly 1-4 pp per sweep.
  #
  # It is also the single example harbor's own docstring gives for this flag
  # (agents/installed/base.py:33):
  #     ``harbor run --max-retries 3 --retry-include ApiRateLimitError``
  #
  # ⛔ AgentTimeoutError STILL DOES NOT BELONG HERE, for the reason above: the
  # agent ran and spent its whole budget, and retrying that buys it a second
  # attempt. Guarded by `retry-include-coverage.test.sh`, which also refuses
  # ApiUsageLimitError and checks every name against harbor's real exception
  # classes — harbor does not validate these strings (cli/jobs.py:1228 is a bare
  # `set(...)`), so a typo is accepted and then silently never fires.
  #
  # Disclosure obligation is unchanged and now covers this entry too: a
  # submission built on this run must state that rate-limit retries were enabled
  # and how many trials consumed one.
  --retry-include ApiRateLimitError
  # ── Harbor Hub upload ──────────────────────────────────────────────────────
  # A submission requires the job AND EVERY TRIAL to be publicly readable on
  # Harbor Hub, so the reward-hacking judge can audit them. That makes upload a
  # hard requirement for the submittable arm — and a PERMANENT, INDEXED action
  # for everything else, which is why the default is OFF and `--public` needs a
  # second, differently-spelled opt-in (R1 in the submission plan: "never
  # --upload --public before TB-11").
  #
  # ATIF is NOT built here and never was: harbor's own claude-code adapter sets
  # SUPPORTS_ATIF = True (agents/installed/claude_code.py:33) and every trial we
  # have already run carries agent/trajectory.json at schema_version ATIF-v1.7
  # (126 files, 0 unparseable, 0 zero-step, verified 2026-08-05). Do not write an
  # emitter; verify the files instead.
  #
  #   TB_UPLOAD unset / 0  -> no upload            (default; local only)
  #   TB_UPLOAD=1          -> --upload --private   (exercise the flow, nothing indexed)
  #   TB_UPLOAD=public     -> --upload --public    (the submission itself)
)
case "${TB_UPLOAD:-0}" in
  0|"")   : ;;
  1)      args+=(--upload --private)
          echo "[run-dg] Harbor Hub: uploading PRIVATE (flow exercise, not indexed)" ;;
  public) args+=(--upload --public)
          echo "[run-dg] ⚠ Harbor Hub: uploading PUBLIC — permanent and indexed, incl. every trajectory" ;;
  *)      echo "[run-dg] TB_UPLOAD='$TB_UPLOAD' is not one of 0|1|public — refusing to guess" >&2
          exit 2 ;;
esac

# ── Claude Code reasoning effort ────────────────────────────────────────────
# UNSET FOR THE ENTIRE k=1 CAMPAIGN (89 tasks, $174.54) — harbor's claude-code
# adapter exposes `reasoning_effort` as `--effort` with choices
# low|medium|high|xhigh|max|ultracode (agents/installed/claude_code.py:49), and
# we passed neither it nor its CLAUDE_CODE_EFFORT_LEVEL fallback, so every trial
# ran at the CLI default. Owner decision 2026-08-05: run the k=2..5 campaign at
# `ultracode`.
#
# ⚠️ EFFORT MUST BE CONSTANT ACROSS ATTEMPTS WITHIN A RUN. The attribution
# design makes attempt 1 the control and attempts 2..k the treatment, with
# MEMORY as the only difference. Setting effort per-attempt would confound the
# two and the run would measure "memory + effort" while reporting it as memory.
# This is a per-RUN setting for exactly that reason.
#
# Consequence to state in any report: the k=1 number (0.8315, default effort) and
# the k>=2 numbers are NOT directly comparable. Within the k>=2 run the paired
# attempt-1-vs-attempt-2+ comparison stays valid, because effort is held fixed.
case "${TB_EFFORT:-}" in
  "")  : ;;   # default: pass nothing, reproducing the k=1 configuration
  low|medium|high|xhigh|max|ultracode)
       args+=(--ak "reasoning_effort=$TB_EFFORT")
       echo "[run-dg] reasoning effort: $TB_EFFORT (k=1 ran at the CLI default — not comparable)" ;;
  *)   echo "[run-dg] TB_EFFORT='$TB_EFFORT' is not one of low|medium|high|xhigh|max|ultracode — refusing to guess" >&2
       exit 2 ;;
esac


# ── TB_STOP_HOOK=1: register Claude Code's Stop hook ────────────────────────
#
# MEASURED over 60 trials of a clean sweep: 2.1 wired NO Stop hook, so
# `build_stop_decision` was never consulted at stop time and agents called
# `op:"status"` themselves in 12% of trials. Every other channel is mistimed —
# the server instructions arrive before the work exists, and the `record`
# response arrives after it (agents make a median of ONE tool call after their
# first record). A Stop hook is the only shape that is both timely and
# universal: the HOOK calls status on every stop attempt.
#
# OFF BY DEFAULT and paired with TB_AGENT=terransoul_hook:TerranSoulHook, whose
# install() puts the `terransoul` binary in the container. Registering the hook
# without that adapter yields a hook command that does not exist — and a
# missing hook does not error, it silently never fires, which is exactly the
# failure that already cost this campaign one mechanism. So refuse the
# combination rather than run a run that only looks instrumented.
if [ "${TB_STOP_HOOK:-0}" = "1" ]; then
  _hook_settings="${TB_STOP_HOOK_SETTINGS:-$HERE/claude-settings-verifyhook.json}"
  [ -f "$_hook_settings" ] || {
    echo "[run-dg] REFUSING: TB_STOP_HOOK=1 but no settings file at $_hook_settings" >&2
    exit 2
  }
  case "${TB_AGENT:-}" in
    *TerranSoulHook*) : ;;
    *)
      echo "[run-dg] REFUSING: TB_STOP_HOOK=1 needs TB_AGENT=terransoul_hook:TerranSoulHook," >&2
      echo "[run-dg]   which installs the \`terransoul\` binary the hook invokes. Without it the" >&2
      echo "[run-dg]   hook silently never fires and the run only LOOKS instrumented." >&2
      exit 2 ;;
  esac
  args+=(--ak "config=$_hook_settings")
  # The hook resolves its MCP client from ENV (`mcpFromEnv`), not from Claude
  # Code's --mcp-config, and returns null when TERRANSOUL_MCP_URL is unset —
  # which makes it allow every stop silently. Point it at the same host-side
  # proxy the agent uses.
  #
  # DELIBERATELY NO TOKEN. The proxy injects Authorization host-side precisely
  # so the bearer never enters a container; passing TERRANSOUL_MCP_TOKEN here
  # would undo that for no gain, since the proxy does not require the caller to
  # present one.
  args+=(--ae "TERRANSOUL_MCP_URL=http://host.docker.internal:$PROXY_PORT/mcp")
  # ── TBENCH-UNSOURCED-ESCALATION-1: OFF unless asked for ───────────────────
  #
  # The Stop hook runs INSIDE the container as a bare `terransoul stop-hook`,
  # so it sees only the container's env — the flag has to be injected here or
  # the hook reads it as unset and stays inert. That is precisely how a 66-task
  # campaign once ran with the identity wired but the gate silently off, so the
  # flag is forwarded explicitly and the run log says which arm it is.
  #
  # ⛔ NOT A DEFAULT. Measured over 94 graded trials, 88 of 90 passes and all 5
  # failures made zero external lookups — so this fires on ~98% of trials and
  # is not discriminating. Switching it on perturbs 85 passing tasks to reach 4
  # failing ones, against a 95.5% never-regress floor. It exists to be A/B'd.
  if [ "${TB_ESCALATE_UNSOURCED:-0}" = "1" ]; then
    args+=(--ae "TB_ESCALATE_UNSOURCED=1")
    echo "[run-dg] TBENCH-UNSOURCED-ESCALATION-1 is ON (experimental arm; not the default)"
  fi
  # ── PreToolUse: interrupt ONE irreversible command per session ─────────────
  #
  # These patterns are CONFIGURATION, not a decision baked into source
  # (rules/brain-driven-self-improvement.md forbids verb lists in code). They
  # describe a STRUCTURAL property — an operation whose effect cannot be undone
  # from inside the workspace — and name no task, domain or solution. With this
  # env unset the hook is completely inert.
  #
  # MEASURED, and the reason this exists at all: `sanitize-git-repo` did the
  # requested edits correctly and then ran `filter-branch` ten times plus
  # `prune=now`, destroying the commit its grader anchors on — with a
  # "change the least that satisfies the requirement" clause in its server
  # instructions AND a stop-hook block already in its context. Five separate
  # text mechanisms were verified to reach agents this campaign and were read
  # and overridden; the only intervention that changed behaviour was one that
  # interrupted control flow.
  args+=(--ae "TERRANSOUL_IRREVERSIBLE_PATTERNS=$(printf '%s\n'     'filter-branch'     'filter-repo'     'reflog +expire'     'prune=now'     'push +(-f|--force)'     'rm +-[a-z]*[rR][a-z]* +/(?!tmp|var/tmp)' | sed 's/$//')")
  # The task budget as a NUMBER, for the PreToolUse wall-clock guard. The prose
  # form already reaches the agent via {{TASK_BUDGET}}; this is what lets the
  # hook do arithmetic and REFUSE a command that declares more time than
  # remains, rather than telling the agent again (TBENCH-WALLCLOCK-1).
  [ -n "$_budget_sec" ] && args+=(--ae "TERRANSOUL_TASK_BUDGET_S=$_budget_sec")
  # ── TBENCH-TEACHER-REVIEW-1 (teacher-student arm): OFF unless asked for ──
  # Owner directive 2026-09-11: "Fable 5.1 as teacher, Opus 5 as student on the
  # failed task; if it works, the harness should be teacher-student on the hard
  # task." The student is unchanged; the TEACHER is the isolated bench brain
  # running in claude_cli mode (mcp-data-tbench-clean/brain_config.json), which
  # makes brain_verify_completion's judge and its `review` op a stronger model.
  # TB_TEACHER_REVIEW=1 turns on the Stop hook's review channel
  # (packages/terransoul-cli/src/stop-hook.mjs); TERRANSOUL_MAX_STOP_BLOCKS
  # raises the block budget (hook default 1, hard cap 3) so the teacher can push
  # more than once. Both are forwarded ONLY when set, so the plain arm is
  # byte-identical to before. A run using either MUST be labelled teacher-student
  # in any report -- rows are not comparable to the plain Opus arm.
  [ -n "${TB_TEACHER_REVIEW:-}" ] && args+=(--ae "TB_TEACHER_REVIEW=$TB_TEACHER_REVIEW") \
    && echo "[run-dg] TBENCH-TEACHER-REVIEW-1 is ON (teacher-student arm; label the run)"
  [ -n "${TERRANSOUL_MAX_STOP_BLOCKS:-}" ] && args+=(--ae "TERRANSOUL_MAX_STOP_BLOCKS=$TERRANSOUL_MAX_STOP_BLOCKS") \
    && echo "[run-dg] stop-block budget overridden: TERRANSOUL_MAX_STOP_BLOCKS=$TERRANSOUL_MAX_STOP_BLOCKS"
  # ── The two Stop-hook KILL SWITCHES must reach the container, or the
  #    control arm does not exist.
  #
  # `stop-hook.mjs` reads TB_JUDGE_ANCHOR (the anchoring check) and
  # TB_UNSEEN_INSTANCE (the unseen-instance note) INSIDE the container, both ON
  # unless set to 0. The hook's environment is composed HERE, so a host-side
  # `TB_JUDGE_ANCHOR=0` that is not forwarded never reaches the process that
  # reads it: the feature stays on and the run is labelled as a control arm it
  # is not. That is the TB_STOP_HOOK shape again — a setting whose effect
  # silently disagreed with its label for a whole 66-task campaign. Forwarded
  # ONLY when set, so the default arm stays byte-identical.
  [ -n "${TB_JUDGE_ANCHOR:-}" ] && args+=(--ae "TB_JUDGE_ANCHOR=$TB_JUDGE_ANCHOR") \
    && echo "[run-dg] judge-anchoring check: TB_JUDGE_ANCHOR=$TB_JUDGE_ANCHOR (label the run)"
  [ -n "${TB_UNSEEN_INSTANCE:-}" ] && args+=(--ae "TB_UNSEEN_INSTANCE=$TB_UNSEEN_INSTANCE") \
    && echo "[run-dg] unseen-instance note: TB_UNSEEN_INSTANCE=$TB_UNSEEN_INSTANCE (label the run)"
  # ── The deadline stop must be TUNABLE, or it cannot be measured ────────────
  #
  # `pre-tool-hook`'s guard 1b interrupts once at 90% of the budget and tells
  # the agent to finalise. That default is a judgement, and a guard whose only
  # setting is its default cannot be A/B'd against the runs it is supposed to
  # help — which is exactly the position this harness was in on 2026-09-02,
  # when extract-moves-from-video failed at 28.7 min of 30 with the guard
  # firing, and its historical PASSES ranged 16.3 to 29.6 min. A pass at 29.6
  # min is past the 27-minute interruption, so "did the stop cut it short?" is
  # a real question and there was no way to ask it.
  #
  # Passing it through does NOT change the default (0.9 stands). It makes the
  # fraction an experiment variable, so the guard can be raised toward 1.0 to
  # approximate "off" for a control run.
  [ -n "${TERRANSOUL_DEADLINE_STOP_FRACTION:-}" ] \
    && args+=(--ae "TERRANSOUL_DEADLINE_STOP_FRACTION=$TERRANSOUL_DEADLINE_STOP_FRACTION")
  # The three deadline-awareness knobs added 2026-09-14 (repeatable deadline
  # deny, hard finalisation past 0.99, budget notices past 0.7) are
  # env-overridable in the CLI package but only reach the container when
  # forwarded here; unset means the in-package default applies.
  for _knob in TERRANSOUL_DEADLINE_FINAL_FRACTION TERRANSOUL_BUDGET_NOTICE_FRACTION TERRANSOUL_BUDGET_NOTICE_STEP; do
    [ -n "${!_knob:-}" ] && args+=(--ae "$_knob=${!_knob}")
  done
  # ── Judge prefill trim (TBENCH-JUDGE-PREFILL-1) ──────────────────────────
  # The first user message the Stop hook reads is the TASK instruction with
  # this harness's own extra-instruction appended. MEASURED 2026-08-29: the
  # goal is 20,584 chars of which the task is 1,258 (6.1%) -- so 93.9% of what
  # the completion judge reads is us talking to ourselves, and prefill over the
  # resulting ~26 KB prompt cannot finish inside Claude Code's 240 s hook kill
  # (a timed 8 KB call on gemma4:12b-it-qat took 195.1 s).
  #
  # The marker is DERIVED from the first non-empty line of the file actually
  # appended, so it cannot drift from that file and encodes no task knowledge.
  # The hook fails open when it is unset or absent from the text.
  _trim_marker="$(grep -m1 -E "^[^[:space:]]" "$HERE/extra-instruction.md" 2>/dev/null | head -c 60)"
  [ -n "$_trim_marker" ] && args+=(--ae "TERRANSOUL_GOAL_TRIM_MARKER=$_trim_marker")
  echo "[run-dg] STOP HOOK registered via $_hook_settings (agent=${TB_AGENT})"
  echo "[run-dg] STOP HOOK mcp url: http://host.docker.internal:$PROXY_PORT/mcp (token stays host-side)"
fi
args+=(
  # Without this the agent never calls the brain: job dg-20260804-160416 passed
  # fix-git with reward 1.0 and ZERO brain calls, because nothing in a
  # Terminal-Bench instruction points at memory. Task-agnostic by construction —
  # see the design note inside the file and rules/bench-agi-purity.md.
  --extra-instruction-path "$INSTRUCTION_FILE"
  --ae "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
  # MEASURED 2026-08-04, and the reason these are not left at their defaults:
  # a `brain_search` at thinking_mode=max took 374 s against the tray
  # (thinking_mode=think took 0.5 s). Claude Code's default MCP tool timeout is
  # well under that, so with max pinned (TB_THINKING_MODE, see the proxy) every
  # brain call would abort client-side and the run would look like a brain
  # failure rather than a latency cost.
  --ae "MCP_TIMEOUT=${TB_MCP_TIMEOUT:-120000}"
  --ae "MCP_TOOL_TIMEOUT=${TB_MCP_TOOL_TIMEOUT:-900000}"
)
# NOTE: the MCP token is deliberately NOT passed into the container. The proxy
# adds it host-side, so the brain credential never enters an environment that
# runs untrusted benchmark code. That is the whole point of the proxy.
# TB_TASKS: space-separated task ids, one -i each. Used by run-sweep.sh to run
# the benchmark in batches that each fit inside the OAuth token's lifetime.
# ⚠️ REGISTRY TASK NAMES ARE NAMESPACED, LOCAL ONES ARE NOT. A local `-p` run
# lists task DIRECTORIES, so the filter is a bare `fix-git`. The registry names
# the same task `terminal-bench/fix-git`, and an unprefixed filter matches
# nothing:
#     ValueError: No tasks matched the filter(s) ['fix-git'].
#                 There are 89 tasks available in this dataset.
# Harbor raises that inside Job.create, which the sweep reports only as
# "FAILED before producing a result (preflight/infra)" — so every task fails
# identically and the real message is buried in a stack trace. Caught on the
# first probe of the submittable arm; without the probe it would have been 445
# trials of nothing.
_task_filter() {
  if [ -n "${TB_DATASET:-}" ]; then
    # org prefix from the dataset spec: "terminal-bench/terminal-bench-2-1@..."
    printf '%s/%s' "${TB_DATASET%%/*}" "$1"
  else
    printf '%s' "$1"
  fi
}
if [ -n "${TB_TASKS:-}" ]; then
  for t in $TB_TASKS; do args+=(-i "$(_task_filter "$t")"); done
elif [ -n "$TASK" ]; then
  args+=(-i "$(_task_filter "$TASK")")
fi
[ -n "$LIMIT" ] && args+=(-l "$LIMIT")

echo "[run-dg] job=$JOB tasks=${TB_TASKS:-${TASK:-<all>}} attempts=$ATTEMPTS concurrency=$CONCURRENCY defer=${TB_DEFER_WRITES:-0}"
echo "[run-dg] credential: CLAUDE_CODE_OAUTH_TOKEN (${#CLAUDE_CODE_OAUTH_TOKEN} chars, not echoed)"
# ⛔ CAPTURE THE EXIT CODE; DO NOT LET `set -e` END THE SCRIPT HERE.
#
# This file runs under `set -euo pipefail`, so a non-zero harbor exit used to
# terminate the driver ON THIS LINE — skipping the deferred-lesson flush, the
# result triage, the credit step, the refutation watch and the forensics block,
# every one of which is what turns a finished trial into something the brain and
# the campaign can learn from. And harbor exits non-zero for reasons that are
# not "no result": a trial that errored, a teardown warning, a signal. The
# driver's own headline rule is that the exit code is not the verdict ("READ
# result.json, NEVER THE EXIT CODE. harbor exits 0 on a FAILED trial"), and
# acting on it by aborting was the inverse of that rule.
#
# The code is kept because the post-processing below is allowed to see it: a
# non-zero harbor with no result.json is a different event from a non-zero
# harbor with one, and the reporting says which.
harbor_rc=0
"$HARBOR" "${args[@]}" || harbor_rc=$?
[ "$harbor_rc" -eq 0 ] || echo "[run-dg] harbor exited $harbor_rc — continuing to triage/credit/forensics; the verdict is result.json, not this code." >&2

# Flush deferred lessons NOW, while the proxy is still up and we can see the
# result. The EXIT trap only kills it, and on Windows that hard-terminates node
# without running any handler — the first version lost every deferred lesson
# that way (deferred-writes.test.sh pins it).
if [ "${TB_DEFER_WRITES:-}" = "1" ]; then
  flushed="$(curl -s -m 120 -X POST "http://127.0.0.1:$PROXY_PORT/__flush" || true)"
  echo "[run-dg] deferred lessons flushed: ${flushed:-<no response>}"
  # The flush only makes the lesson EXIST. It becomes RETRIEVABLE when it is
  # embedded — see wait_for_embeddings. The next task in the sweep starts
  # seconds from here, so this wait is what turns "wrote a lesson" into
  # "the next task can actually find it".
  wait_for_embeddings "post-flush" "${TB_EMBED_WAIT_S:-1800}"
fi

# Must honour TB_JOBS_DIR exactly as the -o flag above does. It did not, and the
# result was a run that SUCCEEDED being reported as "NO result.json — the run did
# not get far enough to produce one": the reporting looked in $HERE/jobs while
# harbor had written to $TB_JOBS_DIR. A false failure report on a passing trial
# is worse than a crash, because the natural next step is to debug the run rather
# than the reporter.
JOB_DIR="${TB_JOBS_DIR:-$HERE/jobs}/$JOB"

echo
echo "[run-dg] ── question 1: did the task pass? ──────────────────────────────"
echo "[run-dg] READ result.json, NEVER THE EXIT CODE. harbor exits 0 on a FAILED"
echo "[run-dg] trial, because a failed trial is a valid result. Reading exit 0 as"
echo "[run-dg] success once reported a 1h48m timeout as a pass."
if [ -f "$JOB_DIR/result.json" ]; then
  # ⚠️ AN ERRORED TRIAL STILL CONTRIBUTES TO `mean`. Measured on job
  # dg-20260804-161447: the agent died with UnknownApiError (expired token)
  # and the SAME trial reported metrics [{'mean': 1.0}] with
  # exception_stats {'UnknownApiError': [...]}. The verifier ran regardless and
  # wrote reward 1. So `mean` alone is NOT the score — across 445 trials a few
  # transient API errors are near-certain, and reading the headline number
  # without n_errors silently inflates it. This is the same family as
  # "harbor exits 0 on a FAILED trial", one level deeper.
  python -c "
import json,sys
d=json.load(open(sys.argv[1])); s=d.get('stats',{})
comp,err = s.get('n_completed_trials'), s.get('n_errored_trials')
print('[run-dg]   trials completed:',comp,' errored:',err)
print('[run-dg]   evals:',json.dumps(s.get('evals',{}),indent=2)[:1200])
print('[run-dg]   cost_usd:',s.get('cost_usd'))
if err:
    print('[run-dg]')
    print('[run-dg]   *** %s TRIAL(S) ERRORED — THE MEAN ABOVE INCLUDES THEM. ***' % err)
    print('[run-dg]   An errored trial still contributes its reward (measured: an')
    print('[run-dg]   UnknownApiError trial reported mean 1.0). Do NOT publish this')
    print('[run-dg]   number until the errored trials are re-run or excluded, and')
    print('[run-dg]   say which you did.')
" "$JOB_DIR/result.json" 2>/dev/null \
    || echo "[run-dg]   (could not parse; read $JOB_DIR/result.json by hand)"
else
  echo "[run-dg]   NO result.json at $JOB_DIR — the run did not get far enough to produce one."
fi

echo
# ── question 1b: WHERE DO I LOOK? (TBENCH-TRIAGE-1) ─────────────────────────
#
# Question 1 says whether the task passed. It does not say what to do about a
# failure, and `reward=0` covers four situations needing four different
# responses: the trial errored and the agent never ran (infrastructure); every
# check failed (wrong approach); SOME checks passed (a half-solution, and the
# failing check names which half); or the checks failed while the agent's OWN
# checks passed (its acceptance criterion disagrees with the grader's).
#
# That last case is the expensive one — from inside the trial it is
# indistinguishable from success — and separating it by hand took ~15 commands
# on 2026-09-01 before diagnosis could begin. Printing it HERE is the point: a
# discovery loop asked to decide where to fix cannot run on the score alone,
# and the deliverable the grader judged is not kept in the trial directory.
#
# Advisory only. It never gates, never writes to the brain, and a failure to
# run it must not affect the trial's result — so it is fully guarded and its
# exit code is discarded.
triage_failed_trials() {
  local _job_dir="$1" _here="$2" _t _reward
  [ "${TB_SKIP_TRIAGE:-0}" = "1" ] && return 0
  [ -d "$_job_dir" ] || return 0
  for _t in "$_job_dir"/*/; do
    [ -d "$_t" ] || continue
    # Only failures and errors: a pass needs no triage, and the noise would
    # bury the witness block below. A MISSING reward.txt is an errored trial
    # and DOES get triaged — that is the case most often misread as a
    # capability failure.
    if [ -f "$_t/verifier/reward.txt" ]; then
      _reward="$(tr -d '[:space:]' < "$_t/verifier/reward.txt")"
      case "$_reward" in
        ''|0|0.0|0.00) ;;
        *) continue ;;
      esac
    fi
    echo "[run-dg] ── question 1b: where do I look? ─────────────────────────────"
    node "$_here/triage-trial.mjs" "$_t" 2>&1 | sed 's/^/[triage] /' || true
  done
  return 0
}

triage_failed_trials "$JOB_DIR" "$HERE"

echo "[run-dg] ── question 2: did TerranSoul actually get used? ───────────────"
# Taken AFTER the deferred flush above, so a deferred-write run is measured on
# lessons that actually landed rather than on lessons that were merely buffered.
MEM_AFTER="$(brain_memory_total)"
bash "$HERE/check-terransoul-used.sh" "$JOB_DIR" "$PROXY_LOG" "$MEM_BEFORE" "$MEM_AFTER" || true

cp "$PROXY_LOG" "$JOB_DIR/terransoul-proxy-calls.jsonl" 2>/dev/null || true

# ── TEACH THE BRAIN WHAT THE GRADER SAID (TBENCH-OUTCOME-LINK-1) ─────────────
#
# ⛔ THE NEGATIVE SIGNAL HAD NO PATH INTO MEMORY AT ALL.
#
# `store.rs::confidence_buckets` promotes a memory with `success_count >= 1` and
# `failure_count == 0` into a ranking bucket ABOVE untested rows — its own doc
# comment cites a `filter-js-from-html` redo as the reason it exists. The only
# writer of those counters during a run is `brain_observe_outcome`, and BOTH of
# its inputs are the agent's: `outcome` and `used_memory_ids` are read straight
# off the caller's arguments (mcp/tools.rs:4093-4107).
#
# So the loop closed on self-assessment. An agent that passed tests it wrote
# itself reported success and named its own sources, and those sources were
# promoted — while the grader's verdict reached the brain through no path.
#
# MEASURED 2026-09-01: memory 26531 advises "do NOT build a tree ... never emit
# the parser's serialisation". That is the DIRECT CAUSE of this task's failure,
# because the grader's equality target is `str(BeautifulSoup(...))` — a
# reconstruction of the agent's filter changed ZERO bytes across all 12 clean
# samples and still failed 5 of them. The memory carries success_count=2,
# failure_count=0 after 54 consecutive graded failures, holds the top bucket on
# two self-reports, and is served at rank 1 to every new attempt. The
# self-improve loop was not failing to learn; it was teaching each attempt the
# one approach that cannot pass.
#
# Runs per trial and NEVER blocks one: a bookkeeping write must not be able to
# fail a measured run.
# `$TERRANSOUL_MCP_TOKEN` and `$BRAIN_PORT` are the ones this script already
# resolved and PROVED above (the tools/list probe refuses to run the trial
# otherwise), so this reuses a credential known to work rather than inventing a
# second source of truth for it.
#
# ── AND THE ONLINE REFUTATION WATCH RIDES ON THE SAME INVOCATION ────────────
#
# `--refute-watch` (gated by TB_REFUTE_WATCH, default on) runs at the END of
# credit-trial-outcome.mjs's own main, AFTER this trial's verdict has been
# credited and stamped. That ordering is load-bearing: the cohort the alarm
# reads has to include the trial that just finished, or the window is short by
# one and the alarm fires a trial late.
#
# NO SECOND LOOP AND NO SECOND SCAN, deliberately. A separate pass here would
# re-walk the corpus for nothing and open a second transport to the same brain.
# It reaches only $BRAIN_PORT — the isolated bench brain this script already
# proved with its tools/list probe — so a bookkeeping write can neither fail a
# measured trial nor touch the production tray.
if [ "${TB_CREDIT_OUTCOME:-1}" = "1" ] && [ -n "${TERRANSOUL_MCP_TOKEN:-}" ]; then
  # ── THE WATCH'S OWN KILL SWITCH, WITH THREE STATES ────────────────────────
  #
  #   TB_REFUTE_WATCH=1        (default) detect AND recount through MCP
  #   TB_REFUTE_WATCH=observe  detect and record the alert row, write NOTHING
  #   TB_REFUTE_WATCH=0        off entirely
  #
  # A `case`, not `[ ... ] && _refute_flag=...`, because the switch now has three
  # states rather than two. (The `&&` form would have been SAFE here: under
  # `set -e` bash exempts a failing command inside an AND-OR list except the
  # final one, which is why the pre-existing TB_TEACHER_REVIEW lines above have
  # never killed a sweep — measured, because the earlier comment here claimed the
  # opposite and a false mechanism written beside working code is read as a rule
  # next time.)
  _refute_flag=""
  case "${TB_REFUTE_WATCH:-1}" in
    1) _refute_flag="--refute-watch" ;;
    observe) _refute_flag="--refute-watch --refute-observe" ;;
  esac
  # ⛔ NON-INDEPENDENCE IS DISCLOSED IN THE RUN LOG, NOT ONLY IN A DESIGN DOC.
  # A recount that lands mid-sweep changes what LATER trials of the same task are
  # served, so the trials in a watched sweep are not independent draws. That is
  # intentional here (within-task self-improvement is this campaign's default)
  # but a number published from a watched sweep MUST say so, and the only place a
  # reader of the artifacts can learn it is this line.
  if [ -n "$_refute_flag" ]; then
    echo "[run-dg] ONLINE REFUTATION WATCH is ON (TB_REFUTE_WATCH=${TB_REFUTE_WATCH:-1}) -- trials in this sweep are NOT independent: a recount applied after one trial changes what later trials of the same task are served. Label any published number. Use TB_REFUTE_WATCH=observe to record without writing, or 0 to disable."
  fi
  for _trial in "$JOB_DIR"/*/; do
    [ -f "$_trial/verifier/reward.txt" ] || continue
    TERRANSOUL_MCP_URL="http://127.0.0.1:$BRAIN_PORT/mcp" \
    TERRANSOUL_MCP_TOKEN="$TERRANSOUL_MCP_TOKEN" \
      node "$HERE/credit-trial-outcome.mjs" "$_trial" "$PROXY_LOG" --apply $_refute_flag \
      || echo "[run-dg] outcome credit skipped for $(basename "$_trial") (non-fatal)"
  done
fi

# ── question 1c: FREEZE THE DIAGNOSIS WHILE THE ARTIFACTS ARE STILL HERE ─────
#
# ⛔ THE GAP: `triage_failed_trials` above PRINTS a diagnosis and then loses it.
#
# Its answer lives in this run's stdout and nowhere else, so every later
# question — "did this task fail the same way last time?", "is this a
# regression?", "which failures share a signature?" — restarts from the seven
# raw files, by hand, in a different order each time. That re-derivation has
# been the opening move of nearly every diagnosis in this campaign.
#
# This runs AFTER the credit loop on purpose: the record names the memories the
# trial may be credited for, and reading them before the credit step would
# describe a state that no longer exists by the time anyone reads the record.
#
# It writes `forensics.json` + `forensics.md` into each trial directory and one
# line into the jobs root's `forensics-index.jsonl`, which
# `forensics-side-by-side.mjs` reads back as a single table.
#
# Advisory, exactly like the triage step: fully guarded, exit code discarded,
# never gates, never writes to the brain, never opens a socket. A bookkeeping
# step must not be able to fail a measured run.
forensics_for_trials() {
  local _job_dir="$1" _here="$2" _t
  [ "${TB_SKIP_FORENSICS:-0}" = "1" ] && return 0
  [ -d "$_job_dir" ] || return 0
  for _t in "$_job_dir"/*/; do
    [ -d "$_t" ] || continue
    node "$_here/post-trial-forensics.mjs" "$_t" --base "$(dirname "$_job_dir")" 2>&1 \
      | sed 's/^/[forensics] /' || true
  done
  return 0
}

forensics_for_trials "$JOB_DIR" "$HERE"

# ⛔ LAST LINE ON PURPOSE — ADD NEW POST-PROCESSING STEPS ABOVE IT, NOT BELOW.
#
# harbor's exit code is now CAPTURED rather than allowed to end the script at
# the harbor line (see the comment there), so every step above this one runs
# whatever harbor did. But the code must still reach the caller: run-two-workers
# prints it when it classifies a run that produced no job directory, and
# redo-task.sh echoes it. Silently exiting 0 after a harbor failure would make a
# driver that refused look exactly like one that finished.
#
# It remains NOT the verdict — result.json is, as this file says at length. It
# is the signal for "did the driver get to run at all".
exit "$harbor_rc"
