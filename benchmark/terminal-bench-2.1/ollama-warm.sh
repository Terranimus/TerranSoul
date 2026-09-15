#!/usr/bin/env bash
# Load an Ollama model ON PURPOSE, and say why when that fails. SOURCED, not run:
#
#   . "$HERE/ollama-warm.sh"
#   ollama_base_url                                   # -> http://host:port
#   out="$(ollama_load_model <model> [keep_alive])"   # 0 = loaded, 1 = not;
#                                                     # one line on stdout either way
#
# Call ollama_load_model inside `$(...) || ...` as above: it returns 1 on an
# expected failure, which a bare call would turn into an exit under `set -e`.
#
# ONE LOADER, TWO CALLERS. run-dg.sh's warmth gate has sent this request inline
# since 2026-08-30 (TBENCH-COLD-BRAIN-1). Re-reading /health reaches only
# Ollama's /api/tags, a listing call that loads nothing, and that gate spun
# through four "warming" cycles with /api/ps empty until it sent an inference
# request. start-bench-brain.sh waited on the SAME cold-start state and never
# sent one. MEASURED 2026-09-15 16:02: the sweep launcher's bench-brain wait ran
# out after 300 s on "llm_provider_state is 'degraded'" and the sweep ran zero
# trials, while ONE load request sent by hand made the brain healthy in 17 s.
# The request lives here so the two paths cannot drift apart again.
#
# EMPTY PROMPT, stream:false is Ollama's documented load call. It answers once
# the weights are resident ({"done_reason":"load"}) and generates nothing, so
# the caller's next /health poll finds the model in /api/ps.
#
# KEEP_ALIVE MUST OUTLIVE A SWEEP TASK. Ollama unloads an idle model after its
# keep_alive, 5 minutes by default. A long trial that makes few LLM calls is
# idle far longer than that, so the next task's readiness check found the model
# cold again. TB_OLLAMA_WARM_KEEP_ALIVE sets the lease as a Go duration (2h,
# 90m). Ollama keeps the MOST RECENT request's keep_alive, and the brain's own
# calls carry theirs (30m, or TS_OLLAMA_KEEP_ALIVE), so this lease covers the
# gap until the brain's first call, not the whole sweep. That is why the
# per-task readiness check re-arms it rather than trusting one load at launch.

# THE URL THE BENCH SCRIPTS ALREADY USE. run-dg.sh and preflight-sweep.sh read
# ${OLLAMA_HOST:-http://127.0.0.1:11434}, and the brain hardcodes the same
# loopback default (crates/brain/src/ollama_agent.rs OLLAMA_BASE_URL).
# OLLAMA_HOST is ALSO Ollama's own server variable, whose idiomatic values are
# schemeless ("0.0.0.0", "127.0.0.1:11434"). Those are normalised rather than
# handed to curl as-is: a missing scheme gets http://, a missing port gets
# 11434, and the bind-all 0.0.0.0 becomes loopback, the address a client can
# actually connect to.
ollama_base_url() {
  local raw="${OLLAMA_HOST:-http://127.0.0.1:11434}" scheme rest hostport path=""
  raw="${raw%/}"
  case "$raw" in
    http://*|https://*) scheme="${raw%%://*}"; rest="${raw#*://}" ;;
    *) scheme=http; rest="$raw" ;;
  esac
  hostport="${rest%%/*}"
  [ "$hostport" = "$rest" ] || path="/${rest#*/}"
  case "$hostport" in
    \[*\]) hostport="$hostport:11434" ;;
    \[*\]:*|*:*) ;;
    *) hostport="$hostport:11434" ;;
  esac
  case "$hostport" in 0.0.0.0:*) hostport="127.0.0.1:${hostport#0.0.0.0:}" ;; esac
  printf '%s://%s%s\n' "$scheme" "$hostport" "$path"
}

ollama_load_model() {
  local model="${1:-}" keep="${2:-${TB_OLLAMA_WARM_KEEP_ALIVE:-2h}}"
  local url errf resp rc code body why
  if [ -z "$model" ]; then
    echo "no model name was given to load"
    return 1
  fi
  # Both values are spliced into a JSON string, where a quote or backslash
  # would corrupt the request, so anything outside the expected alphabet is
  # refused with a reason instead of being sent.
  case "$model" in
    *[!A-Za-z0-9._:/@+-]*)
      echo "refusing to load '$model': unexpected characters in the model name"
      return 1 ;;
  esac
  case "$keep" in
    ""|*[!A-Za-z0-9.-]*)
      echo "refusing keep_alive '$keep': expected a Go duration such as 2h or 90m"
      return 1 ;;
  esac

  url="$(ollama_base_url)/api/generate"
  errf="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/ollama-warm.$$")"
  resp="$(curl -sS -m "${TB_OLLAMA_WARM_TIMEOUT_S:-180}" -w '\n%{http_code}' \
            -H 'content-type: application/json' \
            -d "{\"model\":\"$model\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":\"$keep\"}" \
            "$url" 2>"$errf")"
  rc=$?
  why="$(tr -d '\r' < "$errf" 2>/dev/null | sed -n '/./{p;q;}')"
  rm -f "$errf"

  code="${resp##*$'\n'}"
  case "$resp" in *$'\n'*) body="${resp%$'\n'*}" ;; *) body="" ;; esac

  if [ "$rc" -ne 0 ]; then
    echo "POST $url failed (curl exit $rc): ${why:-no error text}"
    return 1
  fi
  why="$(printf '%s' "$body" | tr -d '\r\n' \
           | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ "$code" != "200" ] || [ -n "$why" ]; then
    echo "POST $url returned HTTP $code: ${why:-$(printf '%s' "$body" | tr -d '\r\n' | cut -c1-200)}"
    return 1
  fi
  echo "Ollama loaded '$model' via $url (keep_alive $keep)"
  return 0
}
