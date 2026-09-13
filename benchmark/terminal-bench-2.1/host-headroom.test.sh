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
run_block() {
  : > "$ACTIONS"
  local script="$SANDBOX/block.sh"
  awk '/TBENCH-HOST-HEADROOM-1/{on=1} on{print} on&&/^fi$/{exit}' "$HERE/run-dg.sh" > "$script"
  if ! grep -q "TBENCH-HOST-HEADROOM-1" "$script"; then
    return 9
  fi
  ACTIONS_LOG="$ACTIONS" PATH="$SANDBOX/bin:$PATH" TB_SKIP_HEADROOM=0 \
    bash "$script" > "$SANDBOX/out.txt" 2>&1
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

# ── 7. opt-out is honoured ───────────────────────────────────────────────────
: > "$ACTIONS"
awk '/TBENCH-HOST-HEADROOM-1/{on=1} on{print} on&&/^fi$/{exit}' "$HERE/run-dg.sh" > "$SANDBOX/block.sh"
ACTIONS_LOG="$ACTIONS" PATH="$SANDBOX/bin:$PATH" TB_SKIP_HEADROOM=1 \
  bash "$SANDBOX/block.sh" >/dev/null 2>&1
if [ -s "$ACTIONS" ]; then
  no "skip_flag_disables_everything" "acted despite TB_SKIP_HEADROOM=1"
else
  ok "skip_flag_disables_everything"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
