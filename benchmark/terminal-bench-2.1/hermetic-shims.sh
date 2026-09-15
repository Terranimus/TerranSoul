#!/usr/bin/env bash
# hermetic-shims.sh -- SOURCED (never run) by every *.test.sh that executes a
# real script able to reach the live machine through docker, netstat, ss or
# taskkill.
#
# ⛔ MEASURED 2026-09-15 18:45. A reviewer ran two-workers.test.sh beside the
# live ts09151819 sweep. Its halt case made the REAL run-two-workers.sh run
# `_reap_sweep_containers`, whose `docker rm -f` of every `__` container on the
# host SIGKILLed two live trials -- pytorch-model-cli (16,125 output tokens) and
# winning-avg-corewars (11,402). The test shimmed docker/netstat/ss, but a
# shim is only a guard if PATH really resolves it, and nothing checked; other
# tests in this directory launch run-dg.sh with no shim at all.
#
#   hermetic_shims <sandbox>
#       Creates logging shims for docker, netstat, ss and taskkill in
#       <sandbox>/hermetic-bin, puts that directory FIRST on PATH (exported),
#       and exports HERMETIC_LOG (one line per call: "<tool> <argv>") and
#       HERMETIC_ROOT_PID (this test's own pid).
#   hermetic_guard <sandbox> [tool...]
#       ABORTS the test (exit 2) unless every tool (default: the four above)
#       resolves to a file inside <sandbox>. Call it right after
#       hermetic_shims and before the first real script runs.
#
# What the shims answer:
#   docker ps          rows from $HERMETIC_DOCKER_PS ("<id> <name> [status]",
#                      status defaults to running), honouring -a, --filter
#                      status=<s> (repeatable, OR'd) and --format with
#                      {{.ID}} / {{.Names}}; nothing when the file is unset.
#   docker rm          logged, and the rows it names are removed from the file.
#   docker network ls  rows from $HERMETIC_DOCKER_NETWORKS; network rm removes.
#   docker run         prints $HERMETIC_DOCKER_RUN_OUT (empty by default).
#   netstat, ss        print nothing: no port is held.
#   taskkill           NEVER reaches the real binary. A forced (//F) kill of a
#                      pid that is a DESCENDANT of HERMETIC_ROOT_PID is carried
#                      out with `kill -9` on the msys process tree (//T takes
#                      its descendants too), so a test that stops its own
#                      children still does; a polite kill is refused as the
#                      real taskkill refuses a windowless process; ANY other
#                      pid is refused and logged as REFUSED.
# A test that needs a different answer puts its own fake earlier on PATH; the
# guard accepts any fake inside the sandbox.

hermetic_shims() { # <sandbox>
  local sb="$1" bin
  bin="$sb/hermetic-bin"
  mkdir -p "$bin" || return 1
  HERMETIC_LOG="$sb/hermetic-calls.log"
  HERMETIC_ROOT_PID="$$"
  : >> "$HERMETIC_LOG"

  # Each shim bakes in the log path and root pid, so a child whose environment
  # was trimmed still logs to the right file instead of failing loudly on an
  # unset variable.
  { printf '#!/usr/bin/env bash\n'
    printf 'HERMETIC_LOG="${HERMETIC_LOG:-%s}"\n' "$HERMETIC_LOG"
    cat <<'SHIM'
printf 'docker %s\n' "$*" >> "$HERMETIC_LOG"
_rows() { [ -n "${1:-}" ] && [ -f "$1" ] && cat "$1"; return 0; }
_drop() { # <file> <id-or-name>
  [ -n "${1:-}" ] && [ -f "$1" ] || return 0
  awk -v k="$2" '$1!=k && $2!=k' "$1" > "$1.hermetic-tmp" && mv "$1.hermetic-tmp" "$1"
}
case "${1:-}" in
  ps)
    shift
    all=0; fmt='{{.ID}}'; statuses=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -a|--all) all=1 ;;
        -q|--quiet) fmt='{{.ID}}' ;;
        --format) shift; fmt="${1:-}" ;;
        --format=*) fmt="${1#--format=}" ;;
        --filter|-f) shift; case "${1:-}" in status=*) statuses="$statuses ${1#status=}" ;; esac ;;
        --filter=status=*) statuses="$statuses ${1#--filter=status=}" ;;
      esac
      shift
    done
    _rows "${HERMETIC_DOCKER_PS:-}" | while read -r id name status; do
      [ -n "$id" ] || continue
      status="${status:-running}"
      if [ -n "$statuses" ]; then
        case " $statuses " in *" $status "*) ;; *) continue ;; esac
      elif [ "$all" != "1" ] && [ "$status" != "running" ]; then
        continue
      fi
      out="${fmt//'{{.ID}}'/$id}"
      out="${out//'{{.Names}}'/$name}"
      printf '%s\n' "$out"
    done
    ;;
  rm)
    shift
    for a in "$@"; do case "$a" in -*) ;; *) _drop "${HERMETIC_DOCKER_PS:-}" "$a" ;; esac; done
    ;;
  network)
    case "${2:-}" in
      ls) _rows "${HERMETIC_DOCKER_NETWORKS:-}" | awk 'NF{print $1}' ;;
      rm) shift 2; for a in "$@"; do _drop "${HERMETIC_DOCKER_NETWORKS:-}" "$a"; done ;;
    esac
    ;;
  run)
    printf '%s' "${HERMETIC_DOCKER_RUN_OUT:-}"
    ;;
esac
exit 0
SHIM
  } > "$bin/docker"

  local tool
  for tool in netstat ss; do
    { printf '#!/usr/bin/env bash\n'
      printf 'HERMETIC_LOG="${HERMETIC_LOG:-%s}"\n' "$HERMETIC_LOG"
      printf 'printf "%%s %%s\\n" "%s" "$*" >> "$HERMETIC_LOG"\n' "$tool"
      printf 'exit 0\n'
    } > "$bin/$tool"
  done

  { printf '#!/usr/bin/env bash\n'
    printf 'HERMETIC_LOG="${HERMETIC_LOG:-%s}"\n' "$HERMETIC_LOG"
    printf 'HERMETIC_ROOT_PID="${HERMETIC_ROOT_PID:-%s}"\n' "$HERMETIC_ROOT_PID"
    cat <<'SHIM'
printf 'taskkill %s\n' "$*" >> "$HERMETIC_LOG"
win=""; tree=0; force=0; want_pid=0
for a in "$@"; do
  if [ "$want_pid" = "1" ]; then win="$a"; want_pid=0; continue; fi
  case "$a" in
    //PID|/PID|-PID|//pid|/pid) want_pid=1 ;;
    //T|/T|-T|//t|/t) tree=1 ;;
    //F|/F|-F|//f|/f) force=1 ;;
  esac
done
case "$win" in ''|*[!0-9]*) echo "taskkill REFUSED: no numeric //PID" >> "$HERMETIC_LOG"; exit 1 ;; esac

# The msys process table as "pid ppid winpid". A leading status letter (I, S,
# O) shifts the columns on some rows, so a non-numeric first field is dropped.
table="$(ps 2>/dev/null | awk 'NR>1 { if ($1 !~ /^[0-9]+$/) { $1=""; $0=$0 } print $1, $2, $4 }')"
target="$(printf '%s\n' "$table" | awk -v w="$win" '$3==w {print $1; exit}')"
ours=0
if [ -n "$target" ] && [ "$target" != "$HERMETIC_ROOT_PID" ]; then
  p="$(printf '%s\n' "$table" | awk -v q="$target" '$1==q {print $2; exit}')"
  hops=0
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ] && [ "$hops" -lt 64 ]; do
    if [ "$p" = "$HERMETIC_ROOT_PID" ]; then ours=1; break; fi
    p="$(printf '%s\n' "$table" | awk -v q="$p" '$1==q {print $2; exit}')"
    hops=$((hops + 1))
  done
fi
if [ "$ours" != "1" ]; then
  echo "taskkill REFUSED winpid $win: not a descendant of test pid $HERMETIC_ROOT_PID" >> "$HERMETIC_LOG"
  exit 128
fi
if [ "$force" != "1" ]; then
  echo "taskkill polite kill of winpid $win not delivered (windowless process; needs //F)" >> "$HERMETIC_LOG"
  exit 1
fi
victims="$target"
if [ "$tree" = "1" ]; then
  frontier="$target"
  while [ -n "$frontier" ]; do
    frontier="$(printf '%s\n' "$table" | awk -v f=" $frontier " 'index(f, " " $2 " ") {print $1}' | tr '\n' ' ' | sed 's/ *$//')"
    [ -n "$frontier" ] && victims="$victims $frontier"
  done
fi
echo "taskkill killed msys pid(s) $victims (winpid $win)" >> "$HERMETIC_LOG"
# shellcheck disable=SC2086
kill -9 $victims 2>/dev/null
exit 0
SHIM
  } > "$bin/taskkill"

  chmod +x "$bin/docker" "$bin/netstat" "$bin/ss" "$bin/taskkill"
  PATH="$bin:$PATH"
  export PATH HERMETIC_LOG HERMETIC_ROOT_PID
  return 0
}

hermetic_guard() { # <sandbox> [tool...]
  local sb="$1" tool got
  shift
  [ $# -gt 0 ] || set -- docker netstat ss taskkill
  for tool in "$@"; do
    got="$(command -v "$tool" 2>/dev/null)"
    case "$got" in
      "$sb"/*) ;;
      *)
        echo "ABORT: '$tool' resolves to '${got:-<nothing>}', not a shim inside $sb." >&2
        echo "ABORT: this test executes a script that can reach the LIVE machine through '$tool'" >&2
        echo "ABORT: (a real docker rm -f from two-workers.test.sh killed two live trials on 2026-09-15 18:45)." >&2
        echo "ABORT: refusing to run." >&2
        exit 2
        ;;
    esac
  done
  return 0
}
