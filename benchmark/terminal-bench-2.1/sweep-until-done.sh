#!/usr/bin/env bash
# sweep-until-done.sh — run a two-worker sweep TO COMPLETION across quota walls.
#
#   usage: bash sweep-until-done.sh <tasks-file> [--stamps-file <path>]
#
# ⛔ WHY THIS EXISTS. A SPENT QUOTA NEEDS A SCHEDULE, NOT A DELAY.
#
# MEASURED 2026-09-15 02:35 on the live 89-task sweep ts09142020: worker 0 hit
#     api_error_status: 429
#     "You've hit your session limit · resets 4:50pm (UTC)"
# after 28 tasks. run-two-workers.sh handled it EXACTLY right — it killed the
# sibling so it could not burn the rest of the list into the same spent session,
# reaped the containers, wrote jobs/ts09142020.remaining (61 tasks, original
# order) and exited 3 with
#     [sweep] HALTED: quota — resume with: bash run-two-workers.sh jobs/<stamp>.remaining
#
# And then it stopped, because nothing above it knew how to wait. The Claude Max
# account's 5-hour session cap clears at a FIXED WALL-CLOCK TIME, so a 22-hour
# sweep meets this wall two or three times; each meeting currently costs however
# many hours pass before a human notices, waits out the reset and relaunches.
# `reference_quota_is_not_a_transient_fault` is the brain lesson: a retry after
# a delay is guaranteed to fail (six tasks, six retries, six 429s ~13 min later),
# while a resume scheduled at the printed reset time succeeds.
#
# WHAT IT DOES NOT DO — deliberately:
#   * It does not retry a graded failure. Only tasks that stayed UNMEASURED (the
#     `.remaining` run-two-workers.sh wrote) are re-run, so k=1 stays k=1.
#   * It does not relaunch after a PREFLIGHT halt. Two consecutive refusals mean
#     a broken environment (brain / MCP token / credential / TLS); relaunching
#     into it burns the session and hides the fault.
#   * It does not merge. It PRINTS the merge command for every stamp it ran,
#     because a merge is a published number and belongs to a human.
#
# WATCHES EVIDENCE, NOT A PROCESS TREE. launch-sweep-detached.sh is
# fire-and-forget by construction (its own header: "NO COMPLETION NOTIFICATION"),
# so completion is read from the artefacts the sweep writes: the `.tb-sweep.lock`
# pid (tested for liveness with the same `ps -W` protocol every other reader
# uses — see `_take_sweep_lock` in run-two-workers.sh), the per-stamp
# detached-sweep-<stamp>.out/.err, and the anchored worker logs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# ── knobs ────────────────────────────────────────────────────────────────────
# Production sets NONE of the test hooks. The waits are real defaults chosen
# from the measured event: a session cap prints its own reset time, and the
# fallback only applies when it does not.
POLL_S="${TB_UNTIL_DONE_POLL_S:-60}"
GRACE_S="${TB_QUOTA_RESUME_GRACE_S:-180}"
FALLBACK_S="${TB_QUOTA_FALLBACK_WAIT_S:-3600}"
MAX_WALLS="${TB_QUOTA_MAX_WALLS:-6}"
START_GRACE_S="${TB_UNTIL_DONE_START_GRACE_S:-300}"
TIGHT_LOOP_S="${TB_UNTIL_DONE_TIGHT_LOOP_S:-600}"
WAIT_CHUNK_S="${TB_UNTIL_DONE_WAIT_CHUNK_S:-300}"

LAUNCH_CMD="${TB_UNTIL_DONE_LAUNCH_CMD:-$HERE/launch-sweep-detached.sh}"
SLEEP_CMD="${TB_UNTIL_DONE_SLEEP_CMD:-sleep}"
JOBS_ROOT="${TB_JOBS_DIR:-$HERE/jobs}"
LOGS_DIR="${TB_UNTIL_DONE_LOGS_DIR:-$REPO/mcp-data/logs}"
SWEEP_LOCK="${TB_LOCK_FILE:-$REPO/mcp-data/.tb-sweep.lock}"

# The clock, in ONE place. A test pins it (TB_UNTIL_DONE_NOW_EPOCH) so the
# reset-time arithmetic is assertable without waiting for a real reset; nothing
# in production sets it.
_now_epoch() {
  if [ -n "${TB_UNTIL_DONE_NOW_EPOCH:-}" ]; then printf '%s' "$TB_UNTIL_DONE_NOW_EPOCH"
  else date +%s; fi
}

say() { # one timestamped line per state transition, so a detached log tells the story
  printf '[until-done] %s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# ── the reset-time parser ────────────────────────────────────────────────────
#
# ⛔ THE STRING IS THE ACCOUNT'S, NOT OURS, so it is parsed defensively and a
# failure to parse is NOT an error — it falls back to a fixed wait. The exact
# form observed 2026-09-15 is
#     You've hit your session limit · resets 4:50pm (UTC)
# with a U+00B7 middle dot that survives no encoding assumption worth making, so
# the match anchors on `resets` and the clock time alone. The hour-only form
# (`resets 3pm (UTC)`) is accepted because the account prints it on the hour.
#
# `(UTC)` present means the time is UTC; absent, it is read as local. Getting
# that backwards is a 10-hour error here, so it is decided by the text and never
# by a default.
_reset_epoch_from_text() { # <text> -> future epoch on stdout, empty when unparseable
  local text="$1" m hh mm ampm zone now day cand
  m="$(printf '%s' "$text" | grep -oiE 'resets[[:space:]]+[0-9]{1,2}(:[0-5][0-9])?[[:space:]]*(am|pm)([[:space:]]*\(UTC\))?' | head -1)"
  [ -n "$m" ] || return 0

  hh="$(printf '%s' "$m" | grep -oE '[0-9]{1,2}' | head -1)"
  mm="$(printf '%s' "$m" | grep -oE ':[0-5][0-9]' | head -1)"; mm="${mm#:}"
  [ -n "$mm" ] || mm="00"
  ampm="$(printf '%s' "$m" | grep -oiE '(am|pm)' | head -1 | tr 'APM' 'apm')"
  zone=""
  printf '%s' "$m" | grep -qiE '\(UTC\)' && zone="UTC"

  case "$hh" in ''|*[!0-9]*) return 0 ;; esac
  [ "$hh" -le 12 ] || return 0
  # 12am is 00, 12pm is 12; every other pm hour is +12. Writing this as a plain
  # `+12` would put 12:05am at 12:05 — half a day wrong, in the direction that
  # resumes into a still-spent session.
  hh=$((10#$hh))
  mm=$((10#$mm))
  if [ "$ampm" = "pm" ]; then
    [ "$hh" -lt 12 ] && hh=$((hh + 12))
  else
    [ "$hh" -eq 12 ] && hh=0
  fi

  now="$(_now_epoch)"
  if [ "$zone" = "UTC" ]; then
    day="$(date -u -d "@$now" +%Y-%m-%d 2>/dev/null)"
    cand="$(date -d "$day $(printf '%02d:%02d' "$hh" "$mm") UTC" +%s 2>/dev/null)"
  else
    day="$(date -d "@$now" +%Y-%m-%d 2>/dev/null)"
    cand="$(date -d "$day $(printf '%02d:%02d' "$hh" "$mm")" +%s 2>/dev/null)"
  fi
  case "${cand:-}" in ''|*[!0-9]*) return 0 ;; esac

  # A reset time already past is TOMORROW's. The cap prints a wall-clock time
  # with no date, so this is the only way it can be read.
  while [ "$cand" -le "$now" ]; do cand=$((cand + 86400)); done
  printf '%s' "$cand"
}

# The transcript of the trial that hit the wall. run-dg.sh writes the account's
# reply into several files; the ones below are ordered cheapest-and-most-exact
# first. Bounded to the newest two job dirs per prefix so this cannot turn into
# a scan of a 40-hour campaign.
_reset_epoch_for_stamp() { # <stamp> -> epoch on stdout, empty when not found
  local stamp="$1" d f hit epoch
  for d in $(ls -1dt "$JOBS_ROOT/ts${stamp}w0"-*/ "$JOBS_ROOT/ts${stamp}w1"-*/ 2>/dev/null | head -4); do
    for f in "$d"*/result.json "$d"*/exception.txt "$d"*/agent/claude-code.txt \
             "$d"*/agent/sessions/projects/*/*.jsonl; do
      [ -f "$f" ] || continue
      hit="$(grep -m1 -oaiE 'resets[[:space:]]+[0-9]{1,2}(:[0-5][0-9])?[[:space:]]*(am|pm)([[:space:]]*\(UTC\))?' "$f" 2>/dev/null | head -1)"
      [ -n "$hit" ] || continue
      epoch="$(_reset_epoch_from_text "$hit")"
      if [ -n "$epoch" ]; then printf '%s' "$epoch"; return 0; fi
    done
  done
  return 0
}

# ── watching a launched sweep ────────────────────────────────────────────────
_lock_pid_alive() {
  local pid
  [ -f "$SWEEP_LOCK" ] || return 1
  pid="$(cat "$SWEEP_LOCK" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$pid" ] || return 1
  # The SAME protocol every other lock reader uses (_take_sweep_lock,
  # launch-sweep-detached.sh, sweep-status.sh): column 1 of `ps -W` is the msys
  # pid the lock holds. tasklist would answer about a WINPID and always say no.
  ps -W 2>/dev/null | awk -v p="$pid" '$1==p{f=1} END{exit !f}'
}

# Everything a worker log has said SINCE this sweep's own launch marker. The
# par logs are APPENDED across launches (sweep-status.sh's whole header is about
# the false alarms that causes), so an unanchored grep would read the PREVIOUS
# sweep's halt as this one's.
_anchored_worker_log() { # <stamp>
  local stamp="$1" w f start
  for w in 0 1; do
    f="$LOGS_DIR/tbench-par${w}.log"
    [ -f "$f" ] || continue
    start="$(grep -n "\[sweep\] job prefix: ts${stamp}w${w}\$" "$f" 2>/dev/null | tail -1 | cut -d: -f1)"
    [ -n "$start" ] || continue
    tail -n +"$start" "$f"
  done
}

# The per-stamp launcher logs need no anchor: launch-sweep-detached.sh names
# them after the stamp, and every resume mints a new one.
_detached_log() { # <stamp>
  cat "$HERE/detached-sweep-$1.out" "$HERE/detached-sweep-$1.err" 2>/dev/null
}

# quota | preflight | outage | done | "" (nothing terminal yet)
_classify_stamp() { # <stamp>
  local stamp="$1" blob
  blob="$(_detached_log "$stamp")
$(_anchored_worker_log "$stamp")"
  # Preflight FIRST: it is the one class that must never be auto-relaunched, so
  # a log carrying both signals must be read as the more serious one.
  case "$blob" in
    *'HALTED: preflight'*|*'preflight refused twice'*) printf 'preflight'; return 0 ;;
  esac
  case "$blob" in
    *'HALTED: quota'*|*'QUOTA EXHAUSTED on'*) printf 'quota'; return 0 ;;
    *'HALTED: outage'*) printf 'outage'; return 0 ;;
    *'both workers finished'*) printf 'done'; return 0 ;;
  esac
  return 0
}

# Poll until the launched sweep reaches a terminal state. Prints the verdict:
# quota | preflight | outage | done | gone.
#
# "gone" is the honest answer when the process is no longer holding the lock and
# no terminal line was ever written (a killed console, a refusal before the lock
# was taken). It is NOT auto-relaunched for the same reason preflight is not.
_watch_stamp() { # <stamp>
  local stamp="$1" verdict dead=0 grace_polls
  grace_polls=$(( START_GRACE_S / POLL_S )); [ "$grace_polls" -ge 1 ] || grace_polls=1
  while :; do
    verdict="$(_classify_stamp "$stamp")"
    if [ -n "$verdict" ]; then printf '%s' "$verdict"; return 0; fi
    if _lock_pid_alive; then
      dead=0
    else
      dead=$((dead + 1))
      if [ "$dead" -ge "$grace_polls" ]; then printf 'gone'; return 0; fi
    fi
    "$SLEEP_CMD" "$POLL_S"
  done
}

# ── waiting ──────────────────────────────────────────────────────────────────
# Chunked so a 4-hour park still prints progress, and so a stubbed sleep in the
# tests records one number rather than a stream of them.
_sleep_until() { # <target epoch>
  local target="$1" now left chunk
  while :; do
    now="$(_now_epoch)"
    left=$(( target - now ))
    [ "$left" -gt 0 ] || return 0
    chunk="$left"; [ "$chunk" -le "$WAIT_CHUNK_S" ] || chunk="$WAIT_CHUNK_S"
    "$SLEEP_CMD" "$chunk"
    # A pinned clock (tests) would otherwise loop forever: the wait cannot
    # shorten if now never moves.
    [ -n "${TB_UNTIL_DONE_NOW_EPOCH:-}" ] && return 0
  done
}

_tail_logs() { # <stamp>
  say "---- last 40 lines of the sweep's own logs ----"
  { _detached_log "$1"; _anchored_worker_log "$1"; } | tail -40
}

# ── main ─────────────────────────────────────────────────────────────────────
# Sourced by the tests to exercise the parser in isolation. Everything above is
# pure function definition; nothing below runs when this is set.
if [ "${TB_UNTIL_DONE_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

TASKS_FILE="${1:-}"
shift || true
STAMPS_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stamps-file) STAMPS_FILE="${2:-}"; shift 2 || shift ;;
    *) echo "usage: bash sweep-until-done.sh <tasks-file> [--stamps-file <path>]" >&2; exit 2 ;;
  esac
done

if [ -z "$TASKS_FILE" ] || [ ! -f "$TASKS_FILE" ]; then
  echo "usage: bash sweep-until-done.sh <tasks-file> [--stamps-file <path>]" >&2
  exit 2
fi
if [ "$(tr '\n' ' ' < "$TASKS_FILE" | wc -w | tr -d ' ')" -eq 0 ]; then
  echo "REFUSING: $TASKS_FILE lists no tasks." >&2
  exit 2
fi

mkdir -p "$JOBS_ROOT"

say "supervising to completion: $TASKS_FILE"
say "walls allowed: $MAX_WALLS  poll: ${POLL_S}s  resume grace: ${GRACE_S}s  fallback wait: ${FALLBACK_S}s"

STAMPS=()
walls=0
next_tasks="$TASKS_FILE"

while :; do
  # ── launch ────────────────────────────────────────────────────────────────
  launch_out="$(mktemp -t until-done-launch.XXXXXX 2>/dev/null || mktemp)"
  say "launching: bash $LAUNCH_CMD $next_tasks"
  bash "$LAUNCH_CMD" "$next_tasks" > "$launch_out" 2>&1
  lrc=$?
  sed 's/^/[until-done]   /' "$launch_out"
  # THE STAMP IS READ BACK, NEVER GUESSED. launch-sweep-detached.sh derives it
  # from `date +%m%d%H%M` at the moment it runs and exports it to the sweep, so
  # a stamp computed here is wrong whenever the launch crosses a minute
  # boundary — and the stamp is what names the job dirs, the `.remaining`, the
  # detached logs, and every prefix the final merge is pointed at.
  stamp="$(grep -m1 -oE 'ts[0-9]{8,}w0' "$launch_out" | head -1 | sed 's/^ts//; s/w0$//')"
  rm -f "$launch_out"
  if [ "$lrc" -ne 0 ] || [ -z "$stamp" ]; then
    say "LAUNCH FAILED (exit $lrc, stamp='${stamp:-}') — nothing is running; stopping."
    exit 5
  fi
  STAMPS+=("$stamp")
  if [ -z "$STAMPS_FILE" ]; then STAMPS_FILE="$JOBS_ROOT/ts${stamp}.stamps"; fi
  printf '%s\n' "$stamp" >> "$STAMPS_FILE"
  launched_at="$(_now_epoch)"
  say "sweep ts${stamp}w0/ts${stamp}w1 is running; stamps recorded in $STAMPS_FILE"

  # ── watch ─────────────────────────────────────────────────────────────────
  verdict="$(_watch_stamp "$stamp")"
  say "sweep ts$stamp reached terminal state: $verdict"

  case "$verdict" in
    done)
      remain="$JOBS_ROOT/ts${stamp}.remaining"
      left=0
      [ -f "$remain" ] && { left="$(grep -c . "$remain" 2>/dev/null)"; left="${left:-0}"; }
      if [ "$left" -gt 0 ]; then
        say "both workers finished but $left task(s) are still owed — treating as a wall."
      else
        say "SWEEP COMPLETE across ${#STAMPS[@]} launch(es)."
        # merge-sweep.sh takes <jobs-dir> [prefix ...] and is explicit-and-plural
        # by design: merging one prefix published a number computed from 1 job
        # out of 56. Every prefix pair this supervisor launched is named.
        prefixes=""
        for s in "${STAMPS[@]}"; do prefixes="$prefixes ts${s}w0 ts${s}w1"; done
        say "merge with: bash $HERE/merge-sweep.sh $JOBS_ROOT$prefixes"
        exit 0
      fi
      ;;
    preflight)
      say "PREFLIGHT HALT — NOT relaunching. Two consecutive refusals is a broken"
      say "environment (bench brain / MCP token / credential / container TLS), and a"
      say "relaunch would spend the session without measuring anything."
      _tail_logs "$stamp"
      prefixes=""
      for s in "${STAMPS[@]}"; do prefixes="$prefixes ts${s}w0 ts${s}w1"; done
      say "fix the REFUSING line above, then resume with:"
      say "  bash $HERE/sweep-until-done.sh $JOBS_ROOT/ts${stamp}.remaining --stamps-file $STAMPS_FILE"
      say "already-measured trials still merge: bash $HERE/merge-sweep.sh $JOBS_ROOT$prefixes"
      exit 4
      ;;
    gone)
      say "the sweep stopped without writing a terminal line (killed console, or a"
      say "refusal before the lock was taken). NOT relaunching blind."
      _tail_logs "$stamp"
      exit 6
      ;;
  esac

  # ── a wall: quota, outage, or a finish that left tasks owed ───────────────
  remain="$JOBS_ROOT/ts${stamp}.remaining"
  left=0
  [ -f "$remain" ] && { left="$(grep -c . "$remain" 2>/dev/null)"; left="${left:-0}"; }
  if [ "$left" -eq 0 ]; then
    say "nothing left owed after the halt — SWEEP COMPLETE across ${#STAMPS[@]} launch(es)."
    prefixes=""
    for s in "${STAMPS[@]}"; do prefixes="$prefixes ts${s}w0 ts${s}w1"; done
    say "merge with: bash $HERE/merge-sweep.sh $JOBS_ROOT$prefixes"
    exit 0
  fi

  walls=$((walls + 1))
  say "wall $walls/$MAX_WALLS ($verdict) — $left task(s) still owed in $remain"
  if [ "$walls" -ge "$MAX_WALLS" ]; then
    say "WALL BUDGET SPENT ($MAX_WALLS). Stopping rather than looping into the cap."
    prefixes=""
    for s in "${STAMPS[@]}"; do prefixes="$prefixes ts${s}w0 ts${s}w1"; done
    say "resume with: bash $HERE/sweep-until-done.sh $remain --stamps-file $STAMPS_FILE"
    say "merge what exists: bash $HERE/merge-sweep.sh $JOBS_ROOT$prefixes"
    exit 3
  fi

  now="$(_now_epoch)"
  ran_for=$(( now - launched_at ))
  target=""
  if [ "$ran_for" -lt "$TIGHT_LOOP_S" ] && [ "$walls" -gt 1 ]; then
    # ⛔ TIGHT-LOOP GUARD. A relaunch that hits the wall again within minutes
    # means the reset time we read was wrong, already past, or the cap is not
    # the one that string describes. Believing it a second time produces a
    # launch storm against a spent session — the exact shape of the six retries
    # that all 429'd ~13 minutes apart.
    say "relaunch halted again after only ${ran_for}s (< ${TIGHT_LOOP_S}s) — ignoring the"
    say "printed reset time and waiting the fallback instead."
  elif [ "$verdict" = "quota" ]; then
    target="$(_reset_epoch_for_stamp "$stamp")"
  fi

  if [ -n "$target" ]; then
    target=$(( target + GRACE_S ))
    say "reset parsed from the halted trial's transcript: $(date -d "@$target" '+%Y-%m-%d %H:%M:%S %Z') (reset + ${GRACE_S}s grace)"
  else
    target=$(( now + FALLBACK_S + GRACE_S ))
    say "no usable reset time ($verdict) — waiting the fallback ${FALLBACK_S}s + ${GRACE_S}s grace"
  fi
  say "sleeping until $(date -d "@$target" '+%Y-%m-%d %H:%M:%S %Z') ($(( target - now ))s)"
  _sleep_until "$target"
  say "reset reached — resuming with $remain"
  next_tasks="$remain"
done
