#!/usr/bin/env bash
# The pre-launch checklist for a two-worker sweep. Exits non-zero on ANY failure.
#
#   usage: bash preflight-sweep.sh <tasks-file>
#
# WHY A CHECKLIST AND NOT A COMMENT IN RESUME.md. Every item below is a
# condition that has already cost this campaign measured trials, and each one
# fails in the same expensive shape: the sweep starts, looks healthy, and
# produces numbers that are not measurements.
#
#   bench brain missing / not isolated  every task refuses in seconds, or -- far
#                                       worse -- learn mode WRITES into the
#                                       product's brain (2026-08-31).
#   brain not READY                     /health 200 with llm_provider_state
#                                       "degraded" let 2 of 3 trials run against
#                                       a model that had not loaded (2026-08-30).
#   credential too short                a 47-minute token was admitted to a
#                                       7200 s task and died 42 minutes in with
#                                       98 model turns already produced
#                                       (2026-09-13, sam-cell-seg).
#   ports held                          an orphaned proxy from a sweep 12 hours
#                                       dead makes every launch exit 2
#                                       (2026-09-04/05).
#   sweep lock held                     two runs fight over 7425 and both die.
#   disk below 30 GB                    harbor images, container layers and job
#                                       artefacts fill the repo drive mid-sweep.
#   leftover __ containers              a failed teardown leaks its container and
#                                       feeds the pressure that causes the next
#                                       0xC0000142 spawn failure (2026-09-08).
#   container TLS intercepted           NINE consecutive trials errored before
#                                       the agent ran, ~40 minutes, and the wall
#                                       of identical errors read like an adapter
#                                       regression (2026-09-07).
#   expired resident Ollama model       14.39 GiB of Docker's budget held for a
#                                       model whose keep-alive lapsed ten hours
#                                       earlier; host memory pressure is what
#                                       produces the paired spawn failures.
#
# FAILS CLOSED ON WHAT IT CAN DECIDE, FAILS OPEN ON WHAT IT CANNOT. A probe that
# could not run (no docker, no Ollama, no python) says so and does not block:
# "a preflight that blocks because it could not check is worse than no
# preflight" is already this harness's rule, and it is kept here.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${TB_REPO_OVERRIDE:-$(cd "$HERE/../.." && pwd)}"

TASKS_FILE="${1:-}"
if [ -z "$TASKS_FILE" ] || [ ! -f "$TASKS_FILE" ]; then
  echo "usage: bash preflight-sweep.sh <tasks-file>" >&2
  exit 2
fi

PORT="${TB_BRAIN_PORT:-7424}"
PROD_PORT="${TB_PROD_BRAIN_PORT:-7423}"
BRAIN_DATA="${TB_BRAIN_DATA:-$REPO/mcp-data-tbench-clean}"
TASKS_DIR="${TB21_DIR:-/d/Git/terminal-bench-2-1}/tasks"
MIN_FREE_GB="${TB_MIN_FREE_GB:-30}"
LOCK="${TB_LOCK_FILE:-$REPO/mcp-data/.tb-sweep.lock}"

fails=0
PASS() { printf '  PASS  %-26s %s\n' "$1" "${2:-}"; }
FAIL() { printf '  FAIL  %-26s %s\n' "$1" "${2:-}" >&2; fails=$((fails+1)); }
SKIP() { printf '  skip  %-26s %s\n' "$1" "${2:-}"; }

echo "── sweep preflight @ $(date '+%Y-%m-%d %H:%M:%S') ─────────────────────────"

# ── 1+2. the bench brain: up, READY, ISOLATED, and answering tools/list ───────
# Delegated to start-bench-brain.sh in check-only mode so this checklist and the
# sweep's own start-up cannot disagree about what "usable" means. That script
# already proves isolation twice (the CLEAN store's token must authenticate
# :$PORT, and memory_total must differ from production's).
brain_out="$(TB_BENCH_BRAIN_CHECK_ONLY=1 TB_REPO_OVERRIDE="$REPO" TB_BRAIN_PORT="$PORT" \
             TB_PROD_BRAIN_PORT="$PROD_PORT" TB_BRAIN_DATA="$BRAIN_DATA" \
             bash "$HERE/start-bench-brain.sh" 2>&1)"
if [ $? -eq 0 ]; then
  PASS "bench brain :$PORT" "$(printf '%s' "$brain_out" | tail -1 | sed 's/^\[bench-brain\] //')"
else
  FAIL "bench brain :$PORT" "$(printf '%s' "$brain_out" | tail -1 | sed 's/^\[bench-brain\] //')"
  echo "        start it with: bash $HERE/start-bench-brain.sh" >&2
fi

# ── 3. the credential must outlive the LONGEST task in this list ─────────────
# TB_TRIAL_CEILING_S is the contract token-refresh.sh already reads (it turns it
# into max(40, ceiling + 30 min)); run-dg.sh publishes it per task. A sweep is
# launched once, so the gate here is the worst case across the whole list.
max_ceiling=0
longest=""
while read -r t; do
  [ -n "$t" ] || continue
  f="$TASKS_DIR/$t/task.toml"
  [ -f "$f" ] || continue
  sec="$(awk '
    /^[[:space:]]*\[/ { section = $0 }
    section ~ /\[agent\]/ && /timeout_sec/ {
      if (match($0, /[0-9]+(\.[0-9]+)?/)) { print substr($0, RSTART, RLENGTH); exit }
    }' "$f" 2>/dev/null)"
  [ -n "$sec" ] || sec="$(grep -m1 -oE 'timeout_sec[[:space:]]*=[[:space:]]*[0-9.]+' "$f" 2>/dev/null | grep -oE '[0-9.]+' | head -1)"
  sec="${sec%%.*}"
  case "$sec" in ''|*[!0-9]*) continue ;; esac
  if [ "$sec" -gt "$max_ceiling" ]; then max_ceiling="$sec"; longest="$t"; fi
done < <(tr ' ' '\n' < "$TASKS_FILE")

if [ "$max_ceiling" -eq 0 ]; then
  SKIP "credential headroom" "no task.toml found under $TASKS_DIR -- cannot derive a ceiling"
else
  export TB_TRIAL_CEILING_S="$max_ceiling"
  # shellcheck disable=SC1090
  . "$HERE/token-refresh.sh"
  gate="${TB_TOKEN_MIN_MINUTES:-$(_token_min_minutes)}"
  # Scratch, not the repo dir: a checklist must not leave files beside the
  # scripts it checks, least of all one named after a credential.
  _tok_log="$(mktemp -t preflight-token.XXXXXX 2>/dev/null || mktemp)"
  if refresh_token >"$_tok_log" 2>&1; then
    PASS "credential headroom" "gate ${gate} min (longest: $longest ${max_ceiling}s) -- $(grep -o 'refreshed, [0-9]* min of headroom' "$_tok_log" | tail -1)"
  else
    FAIL "credential headroom" "below the ${gate}-min gate for $longest (${max_ceiling}s)"
    tail -n 3 "$_tok_log" 2>/dev/null | sed 's/^/        /' >&2
  fi
  rm -f "$_tok_log"
fi

# ── 4. proxy ports 7425/7426 free ────────────────────────────────────────────
_listener_pid() { # <port>
  netstat -ano 2>/dev/null | tr -d '\r' \
    | awk -v suf=":$1" '$1=="TCP" && $4=="LISTENING" && index($2, suf) == length($2)-length(suf)+1 {print $5; exit}'
}
held=""
for p in 7425 7426; do
  pid="$(_listener_pid "$p")"
  [ -n "$pid" ] && held="${held:+$held }:$p(pid $pid)"
done
if [ -z "$held" ]; then
  PASS "proxy ports 7425/7426" "free"
else
  FAIL "proxy ports 7425/7426" "held by $held"
  echo "        run-two-workers.sh reclaims an ORPHANED mcp-auth-proxy itself; anything else is yours to stop." >&2
fi

# ── 5. no live sweep lock ────────────────────────────────────────────────────
if [ -f "$LOCK" ]; then
  lpid="$(cat "$LOCK" 2>/dev/null | tr -d '[:space:]')"
  # TB_SWEEP_LOCK_OWNER is how run-two-workers.sh says "that live pid is ME".
  # It takes the lock before running this checklist -- the interlock is
  # worthless if it is only taken after the slow checks -- so without this the
  # sweep would fail its own preflight on a lock it had just acquired.
  if [ -n "$lpid" ] && [ "$lpid" = "${TB_SWEEP_LOCK_OWNER:-}" ]; then
    PASS "sweep lock" "held by this launcher (pid $lpid)"
  elif [ -n "$lpid" ] && ps -W 2>/dev/null | awk -v p="$lpid" '$1==p{f=1} END{exit !f}'; then
    FAIL "sweep lock" "held by LIVE pid $lpid ($LOCK) -- one bench at a time"
  else
    PASS "sweep lock" "stale lock for dead pid ${lpid:-?}; run-two-workers.sh will clear it"
  fi
else
  PASS "sweep lock" "free"
fi

# ── 6. disk headroom on the repo drive ───────────────────────────────────────
avail_kb="$(df -k "$REPO" 2>/dev/null | tail -1 | awk '{print $4}')"
case "$avail_kb" in
  ''|*[!0-9]*) SKIP "repo drive free space" "df gave no usable figure" ;;
  *)
    avail_gb=$(( avail_kb / 1048576 ))
    if [ "$avail_gb" -ge "$MIN_FREE_GB" ]; then
      PASS "repo drive free space" "${avail_gb} GB (need ${MIN_FREE_GB} GB)"
    else
      FAIL "repo drive free space" "${avail_gb} GB, below the ${MIN_FREE_GB} GB floor"
    fi ;;
esac

# ── 7. leftover trial containers ─────────────────────────────────────────────
# The DOUBLE UNDERSCORE is the safety property, not a convenience: every harbor
# trial container carries the trial session id (`caffe-cifar-10__vziewm8__
# env-main-1`) and none of the owner's own long-lived containers contain one.
if command -v docker >/dev/null 2>&1; then
  running="$(docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null | grep '__' || true)"
  exited="$(docker ps -a --filter status=exited --format '{{.ID}} {{.Names}}' 2>/dev/null | grep '__' || true)"
  if [ -n "$running" ]; then
    FAIL "leftover containers" "$(printf '%s\n' "$running" | wc -l | tr -d ' ') trial container(s) are RUNNING -- another bench is live"
    printf '%s\n' "$running" | sed 's/^/        /' >&2
  elif [ -n "$exited" ]; then
    n="$(printf '%s\n' "$exited" | wc -l | tr -d ' ')"
    printf '%s\n' "$exited" | sed 's/^/        removing /'
    # shellcheck disable=SC2046
    docker rm -f $(printf '%s\n' "$exited" | awk '{print $1}') >/dev/null 2>&1 || true
    PASS "leftover containers" "$n exited trial container(s) removed"
  else
    PASS "leftover containers" "none"
  fi
else
  SKIP "leftover containers" "no docker on PATH"
fi

# ── 8. container TLS ─────────────────────────────────────────────────────────
# What is measured is the HANDSHAKE, nothing else. curl prints 000 when TLS or
# the connection fails and a real status code when the handshake completed --
# and a 403 or 404 is a completed handshake (measured 2026-09-14: the host and a
# container both get 403 from the bare downloads.claude.ai root while pypi, the
# npm registry and deb.debian.org answer 200 from the same container). A 3xx
# likewise. Failing a 40-hour sweep on a status code would be a gate that
# cannot discriminate, and this campaign has measured what those cost. Several
# hosts are probed because the trials install from all of them.
if command -v docker >/dev/null 2>&1 && [ "${TB_SKIP_NET_PREFLIGHT:-0}" != "1" ]; then
  img="${TB_NET_PREFLIGHT_IMAGE:-curlimages/curl:latest}"
  urls="${TB_NET_PREFLIGHT_URL:-https://downloads.claude.ai https://pypi.org/simple/pip/ https://registry.npmjs.org/-/ping https://deb.debian.org/debian/}"
  tls_fail=""; tls_seen=""; tls_slow=""; tls_skip=0
  # curl's exit code is docker run's exit code (the image's entrypoint is curl):
  # 28 is a timeout (a slow mirror, retried once with a longer budget and then
  # recorded as slow, never as interception -- deb.debian.org measured 20 s, 11 s
  # and 0.03 s on three consecutive probes), 35/51/53/58/59/60/77/80/90/91 are
  # the TLS family, 6/7 are DNS/connect. 000 with exit 0 cannot happen with real
  # curl but is what a stub prints for "no handshake", so it fails too.
  for url in $urls; do
    code=""; rc=0; attempt=0
    while [ $attempt -lt 2 ]; do
      attempt=$((attempt + 1))
      budget=$(( attempt == 1 ? 20 : 45 ))
      code="$(docker run --rm "$img" -sS -o /dev/null -w '%{http_code}' --max-time "$budget" "$url" 2>/dev/null)"; rc=$?
      [ "$rc" != "28" ] && break
    done
    case "$rc" in
      0)
        case "$code" in
          000|"") tls_fail="$tls_fail $url(no-handshake)" ;;
          [0-9][0-9][0-9]) tls_seen="$tls_seen $code" ;;
          *) tls_fail="$tls_fail $url(${code})" ;;
        esac ;;
      28) tls_slow="$tls_slow $url" ;;
      35|51|53|58|59|60|77|80|90|91|6|7) tls_fail="$tls_fail $url(curl-$rc)" ;;
      125|126|127) tls_skip=1; break ;;
      *) tls_fail="$tls_fail $url(curl-$rc)" ;;
    esac
  done
  if [ "$tls_skip" = "1" ]; then
    SKIP "container TLS" "probe could not run (no image / docker down)"
  elif [ -n "$tls_fail" ]; then
    FAIL "container TLS" "handshake failed for:$tls_fail -- a TLS-intercepting proxy/AV/VPN breaks apt/pip/npm inside EVERY task container"
  else
    PASS "container TLS" "handshake completed (codes:$tls_seen)${tls_slow:+; slow, not intercepted:$tls_slow}"
  fi
else
  SKIP "container TLS" "no docker on PATH or TB_SKIP_NET_PREFLIGHT=1"
fi

# ── 9. Ollama resident set ───────────────────────────────────────────────────
# Remediates rather than refuses, for the same reason run-dg.sh's headroom block
# does: evicting a model Ollama has ALREADY expired is unambiguous, and a
# condition run-dg self-heals at every trial must not block the launch.
ollama_host="${OLLAMA_HOST:-http://127.0.0.1:11434}"
ps_json="$(curl -s -m 10 "$ollama_host/api/ps" 2>/dev/null || echo "")"
if [ -z "$ps_json" ] || ! command -v python >/dev/null 2>&1; then
  SKIP "ollama resident set" "no /api/ps or no python"
else
  expired="$(printf '%s' "$ps_json" | python -c '
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
  if [ -z "$expired" ]; then
    PASS "ollama resident set" "no expired models resident"
  else
    printf '%s\n' "$expired" | while read -r m gib; do
      [ -n "$m" ] || continue
      echo "        unloading '$m' (${gib} GiB, keep-alive already expired)"
      curl -s -m 60 "$ollama_host/api/generate" -H 'content-type: application/json' \
        -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null 2>&1 || true
    done
    PASS "ollama resident set" "expired model(s) unloaded"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "preflight-sweep: ALL CHECKS PASSED"
  exit 0
fi
echo "preflight-sweep: $fails CHECK(S) FAILED -- not starting a sweep" >&2
exit 2
