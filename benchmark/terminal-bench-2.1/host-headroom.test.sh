#!/usr/bin/env bash
# The host-headroom preflight must free the memory that kills sweeps, and must
# never touch anything it does not own.
#
# ⛔ WHAT IT PINS. MEASURED 2026-09-08: Ollama held 14.39 GiB of Docker's
# 39.17 GiB budget for a model whose keep-alive expired ten hours earlier, and
# 14 trials across the campaign died with `0xC0000142` (STATUS_DLL_INIT_FAILED)
# — the host failing to START `docker` under memory pressure — in PAIRS at the
# same minute across both workers. Nothing checked either condition at run time.
#
# ⛔ THE TEST THAT MATTERS IS THE DESTRUCTIVE ONE. `owner_containers_survive`
# is the reason this file exists: the same machine runs the owner's
# `tl-mariadb-test`, `richardle-mariadb-local` and `shopee-crawler-mariadb-local`
# containers, EXITED for weeks. A `status=exited` sweep, or a loose
# `name=-main-` filter, deletes the owner's data. The `__` in a harbor trial
# session id is the property that separates them, and this pins it.
#
# Hermetic: fake `docker` and `curl` on PATH decide every answer, so this needs
# no daemon, no network and no Ollama. Runs in ~1s.
#
# FAILS ON THE PRE-CHANGE TREE: run-dg.sh had no headroom preflight at all, so
# `expired_model_is_unloaded` and `leaked_trial_containers_are_removed` see an
# empty action log, and `preflight_block_exists` finds no marker.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin"
ACTIONS="$SANDBOX/actions.log"

# A fake docker whose `ps -a` returns a MIXED list: three harbor trial
# containers (double underscore) and three of the owner's own (none). Every
# `rm` is appended to the action log so the test can assert on exactly what
# would have been destroyed.
cat > "$SANDBOX/bin/docker" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "ps" ]; then
  cat <<'ROWS'
aaa1111 caffe-cifar-10__vziewm8__env-main-1
bbb2222 mvcc-lsm-compaction__ch8ddwr__verifier__trial-main-1
ccc3333 memcached-backdoor__kydunhd__env-main-1
ddd4444 tl-mariadb-test
eee5555 richardle-mariadb-local
fff6666 shopee-crawler-mariadb-local
ROWS
  exit 0
fi
if [ "${1:-}" = "rm" ]; then
  shift
  for a in "$@"; do
    case "$a" in -*) ;; *) echo "rm $a" >> "$ACTIONS_LOG" ;; esac
  done
  exit 0
fi
exit 0
EOF
chmod +x "$SANDBOX/bin/docker"

# $1 = the JSON body /api/ps should return.
make_curl() {
  cat > "$SANDBOX/bin/curl" <<EOF
#!/usr/bin/env bash
_url=""
for a in "\$@"; do case "\$a" in http*) _url="\$a" ;; esac; done
case "\$_url" in
  */api/ps)  printf '%s' '$1' ;;
  */api/generate)
    # Record the unload request body so the test can assert keep_alive:0.
    _body=""
    _next=0
    for a in "\$@"; do
      if [ "\$_next" = "1" ]; then _body="\$a"; _next=0; fi
      [ "\$a" = "-d" ] && _next=1
    done
    echo "generate \$_body" >> "\$ACTIONS_LOG" ;;
esac
exit 0
EOF
  chmod +x "$SANDBOX/bin/curl"
}

# Run ONLY the preflight block, extracted from run-dg.sh by its own markers, so
# the test exercises the shipped text rather than a copy that could drift.
# A fake df whose Available column is whatever FAKE_AVAIL_KB says. Free disk is
# the one headroom figure that must REFUSE rather than remediate, so the block's
# exit code is now part of what these cases assert.
cat > "$SANDBOX/bin/df" <<'EOF'
#!/usr/bin/env bash
echo "Filesystem 1K-blocks Used Available Use% Mounted"
echo "D: 1953512444 1596111416 ${FAKE_AVAIL_KB:-357401028} 82% /d"
exit 0
EOF
chmod +x "$SANDBOX/bin/df"

BLOCK_RC=0
run_block() {
  : > "$ACTIONS"
  local script="$SANDBOX/block.sh"
  awk '/TBENCH-HOST-HEADROOM-1/{on=1} on{print} on&&/^fi$/{exit}' "$HERE/run-dg.sh" > "$script"
  if ! grep -q "TBENCH-HOST-HEADROOM-1" "$script"; then
    return 9
  fi
  ACTIONS_LOG="$ACTIONS" PATH="$SANDBOX/bin:$PATH" TB_SKIP_HEADROOM=0 REPO="$SANDBOX" \
    env "$@" bash "$script" > "$SANDBOX/out.txt" 2>&1
  BLOCK_RC=$?
  return 0
}

echo "host-headroom preflight"

# ── 1. the block ships at all ────────────────────────────────────────────────
if grep -q "TBENCH-HOST-HEADROOM-1" "$HERE/run-dg.sh"; then
  ok "preflight_block_exists"
else
  no "preflight_block_exists" "no TBENCH-HOST-HEADROOM-1 marker in run-dg.sh"
fi

# ── 2. an EXPIRED keep-alive is unloaded ─────────────────────────────────────
make_curl '{"models":[{"name":"gemma4:12b-it-qat","size_vram":15450000000,"expires_at":"2020-01-01T03:25:00Z"}]}'
run_block
if grep -q 'generate .*keep_alive' "$ACTIONS" && grep -q 'gemma4:12b-it-qat' "$ACTIONS"; then
  ok "expired_model_is_unloaded"
else
  no "expired_model_is_unloaded" "no unload recorded: $(tr '\n' '|' < "$ACTIONS")"
fi
if grep -q '"keep_alive":0' "$ACTIONS"; then
  ok "unload_uses_keep_alive_zero"
else
  no "unload_uses_keep_alive_zero" "$(tr '\n' '|' < "$ACTIONS")"
fi

# ── 3. a LIVE keep-alive is left alone ───────────────────────────────────────
make_curl '{"models":[{"name":"gemma4:12b-it-qat","size_vram":15450000000,"expires_at":"2099-01-01T03:25:00Z"}]}'
run_block
if grep -q 'generate' "$ACTIONS"; then
  no "live_model_is_not_unloaded" "evicted a model that had not expired"
else
  ok "live_model_is_not_unloaded"
fi

# ── 4. leaked TRIAL containers are removed ───────────────────────────────────
if grep -q 'rm aaa1111' "$ACTIONS" && grep -q 'rm bbb2222' "$ACTIONS" && grep -q 'rm ccc3333' "$ACTIONS"; then
  ok "leaked_trial_containers_are_removed"
else
  no "leaked_trial_containers_are_removed" "$(tr '\n' '|' < "$ACTIONS")"
fi

# ── 5. THE ONE THAT MATTERS: the owner's containers survive ──────────────────
if grep -qE 'rm (ddd4444|eee5555|fff6666)' "$ACTIONS"; then
  no "owner_containers_survive" "DESTROYED a non-trial container: $(tr '\n' '|' < "$ACTIONS")"
else
  ok "owner_containers_survive"
fi

# ── 6. the removal is auditable in the run log ───────────────────────────────
if grep -q 'caffe-cifar-10__vziewm8__env-main-1' "$SANDBOX/out.txt"; then
  ok "removed_names_are_printed"
else
  no "removed_names_are_printed" "removal was silent"
fi

# ── 7. FREE DISK, which must REFUSE rather than remediate ────────────────────
#
# ⛔ FAILS ON THE PRE-CHANGE TREE: the headroom preflight checked VRAM and
# leaked containers and nothing else, so a repo drive with a couple of GB left
# started a 20-40 h sweep that could not possibly finish it. Unlike an expired
# Ollama model there is nothing to remediate: harbor pulls images, docker writes
# layers and every trial writes job artefacts onto the same drive, and there is
# no safe automatic action that frees space on the owner's disk. It is also the
# rare headroom figure that is DETERMINISTIC rather than a judgement call — the
# same reason the TLS preflight above refuses — so it refuses, like that one,
# instead of reporting like the rest of this block.
make_curl '{"models":[]}'
run_block FAKE_AVAIL_KB=1048576   # exactly 1 GB
if [ "$BLOCK_RC" -ne 0 ] && grep -q 'REFUSING' "$SANDBOX/out.txt"; then
  ok "under_the_floor_refuses"
else
  no "under_the_floor_refuses" "rc=$BLOCK_RC :: $(cat "$SANDBOX/out.txt")"
fi
if grep -qE '1 GB free' "$SANDBOX/out.txt"; then
  ok "the_refusal_names_the_figure"
else
  no "the_refusal_names_the_figure" "$(cat "$SANDBOX/out.txt")"
fi

run_block FAKE_AVAIL_KB=104857600  # 100 GB
if [ "$BLOCK_RC" -eq 0 ] && grep -q '100 GB free' "$SANDBOX/out.txt"; then
  ok "ample_space_passes_and_is_reported"
else
  no "ample_space_passes_and_is_reported" "rc=$BLOCK_RC :: $(cat "$SANDBOX/out.txt")"
fi

# FAILS OPEN when it cannot measure. "A preflight that blocks because it could
# not check is worse than no preflight" is this block's own rule.
cat > "$SANDBOX/bin/df" <<'EOF'
#!/usr/bin/env bash
echo "df: nonsense"
exit 1
EOF
chmod +x "$SANDBOX/bin/df"
run_block
if [ "$BLOCK_RC" -eq 0 ]; then
  ok "an_unreadable_df_fails_open"
else
  no "an_unreadable_df_fails_open" "rc=$BLOCK_RC :: $(cat "$SANDBOX/out.txt")"
fi
cat > "$SANDBOX/bin/df" <<'EOF'
#!/usr/bin/env bash
echo "Filesystem 1K-blocks Used Available Use% Mounted"
echo "D: 1953512444 1596111416 ${FAKE_AVAIL_KB:-357401028} 82% /d"
exit 0
EOF
chmod +x "$SANDBOX/bin/df"

# ── 8. opt-out is honoured ───────────────────────────────────────────────────
: > "$ACTIONS"
awk '/TBENCH-HOST-HEADROOM-1/{on=1} on{print} on&&/^fi$/{exit}' "$HERE/run-dg.sh" > "$SANDBOX/block.sh"
ACTIONS_LOG="$ACTIONS" PATH="$SANDBOX/bin:$PATH" TB_SKIP_HEADROOM=1 FAKE_AVAIL_KB=1048576 \
  bash "$SANDBOX/block.sh" >/dev/null 2>&1
skip_rc=$?
if [ -s "$ACTIONS" ]; then
  no "skip_flag_disables_everything" "acted despite TB_SKIP_HEADROOM=1"
else
  ok "skip_flag_disables_everything"
fi
# Including the refusal: an explicit opt-out must not be overridden by the one
# check in this block that can stop a run.
if [ "$skip_rc" -eq 0 ]; then
  ok "skip_flag_also_disables_the_disk_refusal"
else
  no "skip_flag_also_disables_the_disk_refusal" "exit $skip_rc despite TB_SKIP_HEADROOM=1"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
