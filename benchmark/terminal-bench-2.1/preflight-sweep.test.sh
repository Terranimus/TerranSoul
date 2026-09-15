#!/usr/bin/env bash
# preflight-sweep.sh must REFUSE a launch on every condition that has already
# cost this campaign trials, and must not refuse on anything else.
#
# FAILS ON THE PRE-CHANGE TREE: preflight-sweep.sh did not exist, so every
# invocation below dies with "No such file or directory" and every assertion
# fails. Nothing ran a pre-launch checklist at all -- each condition was checked,
# if at all, by a human reading RESUME.md, and the two that were checked in code
# (run-dg.sh's TLS and headroom preflights) fire per TRIAL, i.e. after the sweep
# has already been committed to.
#
# Hermetic: fake `curl`, `netstat`, `docker`, `df` and `ps` on PATH decide every
# answer, and TB_TOKEN_STATIC=1 makes the credential gate answer from a file
# rather than the host's real Claude credentials. Needs no brain, no daemon and
# no network.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRE="$HERE_T/preflight-sweep.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/repo/mcp-data-tbench-clean" "$SANDBOX/tasks/alpha" "$SANDBOX/tasks/bravo"
echo "bench-token-abc" > "$SANDBOX/repo/mcp-data-tbench-clean/mcp-token.txt"
printf 'CLAUDE_CODE_OAUTH_TOKEN=fake\n' > "$SANDBOX/token.env"
printf '[agent]\ntimeout_sec = 900.0\n'  > "$SANDBOX/tasks/alpha/task.toml"
printf '[agent]\ntimeout_sec = 7200.0\n' > "$SANDBOX/tasks/bravo/task.toml"
printf 'alpha\nbravo\n' > "$SANDBOX/tasks.txt"
ACTIONS="$SANDBOX/actions.log"

# $1 = 7424 memory_total, $2 = 7424 llm_provider_state, $3 = 7423 memory_total
make_curl() {
  cat > "$SANDBOX/bin/curl" <<EOF
#!/usr/bin/env bash
_url=""
for a in "\$@"; do case "\$a" in http*) _url="\$a" ;; esac; done
case "\$_url" in
  *:7424/health) printf '{"memory_total":$1,"llm_provider_state":"$2"}' ;;
  *:7423/health) printf '{"memory_total":$3,"llm_provider_state":"healthy"}' ;;
  *:7424/mcp)    printf '%s' "200" ;;
  */api/ps)      printf '%s' '{"models":[]}' ;;
esac
exit 0
EOF
  chmod +x "$SANDBOX/bin/curl"
}

# $1 = ports to report as LISTENING, space separated (empty = all free)
make_netstat() {
  { echo '#!/usr/bin/env bash'
    for p in $1; do
      echo "echo '  TCP    127.0.0.1:$p         0.0.0.0:0              LISTENING       4242'"
    done
    echo 'exit 0'
  } > "$SANDBOX/bin/netstat"
  chmod +x "$SANDBOX/bin/netstat"
}

# $1 = running rows, $2 = exited rows, $3 = the TLS probe's http code
make_docker() {
  cat > "$SANDBOX/bin/docker" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "ps" ]; then
  _all=0
  for a in "\$@"; do [ "\$a" = "-a" ] && _all=1; done
  if [ "\$_all" = "1" ]; then printf '%s' '$2'; else printf '%s' '$1'; fi
  [ -n "\$( [ "\$_all" = 1 ] && printf '%s' '$2' || printf '%s' '$1' )" ] && echo
  exit 0
fi
if [ "\${1:-}" = "rm" ]; then shift; for a in "\$@"; do case "\$a" in -*) ;; *) echo "rm \$a" >> "\$ACTIONS_LOG" ;; esac; done; exit 0; fi
if [ "\${1:-}" = "run" ]; then printf '%s' '$3'; exit 0; fi
exit 0
EOF
  chmod +x "$SANDBOX/bin/docker"
}

cat > "$SANDBOX/bin/df" <<'EOF'
#!/usr/bin/env bash
echo "Filesystem 1K-blocks Used Available Use% Mounted"
echo "D: 1953512444 1596111416 ${FAKE_AVAIL_KB:-357401028} 82% /d"
exit 0
EOF
chmod +x "$SANDBOX/bin/df"

# `sleep` and `claude` are stubbed so the credential case below exercises
# token-refresh.sh's FAILURE path without paying its real retry ladder (6 pokes
# x 30 s). What is under test here is preflight-sweep.sh's handling of a refusal;
# the ladder's own timing is token-freshness.test.sh's subject, not this one's.
cat > "$SANDBOX/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SANDBOX/bin/sleep"
cat > "$SANDBOX/bin/claude" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SANDBOX/bin/claude"

cat > "$SANDBOX/bin/ps" <<'EOF'
#!/usr/bin/env bash
# Only the pid in $FAKE_LIVE_PID is reported as running.
echo "     PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND"
[ -n "${FAKE_LIVE_PID:-}" ] && echo "${FAKE_LIVE_PID}    1    1    ${FAKE_LIVE_PID}  ?   197609  00:00:00 /usr/bin/bash"
exit 0
EOF
chmod +x "$SANDBOX/bin/ps"

run_pre() {
  : > "$ACTIONS"
  env PATH="$SANDBOX/bin:$PATH" \
      TB_REPO_OVERRIDE="$SANDBOX/repo" \
      TB21_DIR="$SANDBOX" \
      TB_TOKEN_STATIC=1 TB_TOKEN_FILE="$SANDBOX/token.env" \
      TB_LOCK_FILE="${LOCK_FILE:-$SANDBOX/no-lock}" \
      ACTIONS_LOG="$ACTIONS" \
      "$@" bash "$PRE" "$SANDBOX/tasks.txt" > "$SANDBOX/out.txt" 2>&1
}

echo "preflight-sweep"

# ── 1. everything healthy -> exit 0 ──────────────────────────────────────────
make_curl 42 healthy 999999
make_netstat ""
make_docker "" "" "200"
run_pre; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'ALL CHECKS PASSED' "$SANDBOX/out.txt"; then
  ok "a healthy host passes every check"
else
  no "a healthy host passes every check" "rc=$rc
$(cat "$SANDBOX/out.txt")"
fi
# The credential gate must be the LONGEST task's, not a constant: 7200 s + 30 min
# = 150, which is the 2026-09-13 sam-cell-seg loss expressed as a number.
if grep -q 'gate 150 min' "$SANDBOX/out.txt"; then
  ok "the credential gate covers the LONGEST task in the list"
else
  no "the credential gate covers the LONGEST task in the list" "$(grep credential "$SANDBOX/out.txt")"
fi

# ── 2. the bench brain is serving PRODUCTION's store ─────────────────────────
make_curl 123456 healthy 123456
run_pre; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL  bench brain' "$SANDBOX/out.txt"; then
  ok "a non-isolated bench brain fails the checklist"
else
  no "a non-isolated bench brain fails the checklist" "rc=$rc :: $(cat "$SANDBOX/out.txt")"
fi
make_curl 42 healthy 999999

# ── 3. a proxy port is held ──────────────────────────────────────────────────
make_netstat "7425"
run_pre; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL  proxy ports' "$SANDBOX/out.txt"; then
  ok "a held proxy port fails the checklist"
else
  no "a held proxy port fails the checklist" "rc=$rc :: $(cat "$SANDBOX/out.txt")"
fi
make_netstat ""

# ── 4. a LIVE sweep lock ─────────────────────────────────────────────────────
printf '4242\n' > "$SANDBOX/live.lock"
LOCK_FILE="$SANDBOX/live.lock" run_pre FAKE_LIVE_PID=4242; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL  sweep lock' "$SANDBOX/out.txt"; then
  ok "a live sweep lock fails the checklist"
else
  no "a live sweep lock fails the checklist" "rc=$rc :: $(cat "$SANDBOX/out.txt")"
fi
# ... and a STALE one does not, or a crashed sweep could never be resumed.
LOCK_FILE="$SANDBOX/live.lock" run_pre; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'PASS  sweep lock' "$SANDBOX/out.txt"; then
  ok "a stale sweep lock does NOT fail the checklist"
else
  no "a stale sweep lock does NOT fail the checklist" "rc=$rc :: $(cat "$SANDBOX/out.txt")"
fi

# ── 5. disk below the floor ──────────────────────────────────────────────────
run_pre FAKE_AVAIL_KB=1048576; rc=$?   # exactly 1 GB
if [ "$rc" -ne 0 ] && grep -q 'FAIL  repo drive free space' "$SANDBOX/out.txt"; then
  ok "under 30 GB free fails the checklist"
else
  no "under 30 GB free fails the checklist" "rc=$rc :: $(grep 'free space' "$SANDBOX/out.txt")"
fi

# ── 6. containers: RUNNING blocks, EXITED is cleaned up ──────────────────────
make_docker "abc123 sam-cell-seg__xyz__env-main-1" "" "200"
run_pre; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL  leftover containers' "$SANDBOX/out.txt"; then
  ok "a RUNNING trial container fails the checklist"
else
  no "a RUNNING trial container fails the checklist" "rc=$rc :: $(cat "$SANDBOX/out.txt")"
fi
make_docker "" "def456 extract-elf__abc__env-main-1" "200"
run_pre; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'rm def456' "$ACTIONS"; then
  ok "an EXITED trial container is removed, not refused"
else
  no "an EXITED trial container is removed, not refused" "rc=$rc killed=[$(tr '\n' '|' < "$ACTIONS")]"
fi
# THE ONE THAT MATTERS: the owner's own long-lived containers have no `__`.
make_docker "" "ddd4444 tl-mariadb-test" "200"
run_pre; rc=$?
if grep -q 'rm ddd4444' "$ACTIONS"; then
  no "the owner's containers survive" "DESTROYED a non-trial container"
else
  ok "the owner's containers survive"
fi
make_docker "" "" "200"

# ── 7. container TLS interception ────────────────────────────────────────────
make_docker "" "" "000"
run_pre; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL  container TLS' "$SANDBOX/out.txt"; then
  ok "a broken container TLS handshake fails the checklist"
else
  no "a broken container TLS handshake fails the checklist" "rc=$rc :: $(grep TLS "$SANDBOX/out.txt")"
fi
# A REDIRECT is still a successful handshake -- failing a 40-hour sweep on a 301
# would be a gate that cannot discriminate.
make_docker "" "" "301"
run_pre; rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a 3xx from the TLS probe is accepted"
else
  no "a 3xx from the TLS probe is accepted" "$(grep TLS "$SANDBOX/out.txt")"
fi
# A 403 is a COMPLETED handshake too (the bare downloads.claude.ai root answers
# 403 to host and container alike, 2026-09-14). RED on the pre-change tree: the
# old case statement failed every non-2xx/3xx code, so this run refused to start.
make_docker "" "" "403"
run_pre; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'PASS  container TLS' "$SANDBOX/out.txt"; then
  ok "a 403 from the TLS probe is a completed handshake and is accepted"
else
  no "a 403 from the TLS probe is a completed handshake and is accepted" "rc=$rc :: $(grep TLS "$SANDBOX/out.txt")"
fi
make_docker "" "" "200"

# ── 8. a credential that cannot cover the longest task ───────────────────────
: > "$SANDBOX/empty-token.env"
run_pre TB_TOKEN_FILE="$SANDBOX/empty-token.env" TB_TOKEN_WAIT_MAX_S=1; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL  credential headroom' "$SANDBOX/out.txt"; then
  ok "an unusable credential fails the checklist"
else
  no "an unusable credential fails the checklist" "rc=$rc :: $(grep -i credential "$SANDBOX/out.txt")"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
