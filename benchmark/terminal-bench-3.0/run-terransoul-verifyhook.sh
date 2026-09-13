#!/usr/bin/env bash
# Terminal-Bench 3.0 -- stock Claude Code + TerranSoul's verify-before-stop
# Claude Code Stop hook. Drives `terransoul_verify_hook_agent.py`
# (a thin `ClaudeCode` Harbor-agent subclass, NOT `terransoul_cli_agent.py`'s
# own loop -- that architecture was proposed and explicitly REJECTED by the
# owner: "TerranSoul is not a coding agent and is not meant to replace
# Claude Code as the one driving a benchmark sweep." See
# CAMPAIGN-RECORD.md line ~944-968 and .github/copilot-instructions.md ->
# "TerranSoul's Role for External Coding Agents" / rules/architecture-rules.md
# rule 14b.)
#
#   bash run-terransoul-verifyhook.sh                   # verify-gate 3-task subset
#   TB_TASK=<id>[,<id>...] bash run-terransoul-verifyhook.sh   # override the subset
#   TB_DRY_RUN=1 bash run-terransoul-verifyhook.sh       # print argv, no Harbor call
#   TB_PRINT_CONFIG=1 bash run-terransoul-verifyhook.sh  # real `harbor --print-config`,
#                                                         # resolves + validates the job,
#                                                         # NO container is built or run
#
# REQUIRED BEFORE ANY REAL RUN -- the isolated bench brain and its auth proxy.
# ONE COMMAND, detached and verified end to end (TBENCH-STACK-1, 2026-08-19):
#   node start-bench-stack.mjs
#   export TERRANSOUL_MCP_URL=http://host.docker.internal:7425/mcp
# or let this script do both: TB_START_STACK=1 bash run-terransoul-verifyhook.sh
#
# It replaces the old hand-typed pair (`start-bench-brain.mjs --port 7424` then
# `TB_PROXY_UPSTREAM_PORT=7424 node mcp-auth-proxy.mjs`), each half of which had
# a silent failure mode measured on 2026-08-19: the brain bound the PROXY's port
# when 7424 was taken and reported success, and the proxy defaulted its upstream
# to 7423 (production) and its token to the production store. Both defaults are
# gone at the source; this script still verifies which store is behind the proxy
# rather than trusting that it was -- see the MCP wiring preflight.
#
# Guards, each of which refuses with exit 2 and a printed reason:
#   TB_EXPECT_MODEL   expected ANTHROPIC_MODEL (default req/claude-sonnet-5;
#                     set to '' to disable). Refuses a model mismatch.
#   TB_ALLOW_NO_BRAIN run degraded with no TerranSoul MCP at all, stated on the
#                     receipt. Without it, an unset TERRANSOUL_MCP_URL refuses.
#   TB_BENCH_BRAIN_PORT / TB_PRODUCTION_BRAIN_PORT  (7424 / 7423) -- the store
#                     behind the proxy must be the former and never the latter.
#
# WHY A SEPARATE SCRIPT, NOT A TB_AGENT=verifyhook FLAG ON run-terransoul.sh:
# `terransoul_verify_hook_agent.py` has none of `terransoul_cli_agent.py`'s
# knobs (TERRANSOUL_THINKING_MODE / TERRANSOUL_MAX_ITERATIONS /
# TERRANSOUL_MEMORY_SCOPE / TB_REVIEWER) -- it is stock Claude Code plus one
# extra install step, "this harness does not reason at all" per its own
# docstring -- and it needs one thing run-terransoul.sh's default path does
# not: a Claude Code `--settings` file registering the Stop hook, uploaded via
# Harbor's `--ak config=<path>` (`agent.kwargs.config` ->
# `BaseInstalledAgent.config_source`, confirmed by reading Harbor's own
# installed `claude_code.py`/`base.py`, not assumed from prose). Branching
# that into run-terransoul.sh would touch its tested default (which must stay
# `terransoul_cli_agent.py`) for a second agent shape that shares only the
# scaffolding below, so that scaffolding is deliberately duplicated -- in the
# same order, with the same guard logic -- rather than risking the existing
# script. If the two ever grow a real shared library, that is a follow-up,
# not a reason to touch the working default now.
set -euo pipefail
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# ── Claude Code settings: register the Stop hook ────────────────────────────
# `terransoul_verify_hook_agent.py::install()` installs `@terransoul/cli`
# globally in the container and confirms `command -v terransoul` BEFORE the
# trial starts; this file is what actually wires that binary into Claude
# Code's hook system (`hooks.Stop`, and since 2026-08-19 `hooks.PostToolUseFailure`).
# Kept as its own committed, reviewable file rather than inlined JSON in this
# script.
#
# ── WHY EVERY HOOK IN THAT FILE CARRIES AN EXPLICIT `timeout` (SECONDS) ──────
# JSON cannot hold a comment, so the reasoning lives here, at the site that
# uploads the file. Pinned by test-run-terransoul.sh test 33.
#
# CLAUDE CODE APPLIES NO USABLE DEFAULT. MEASURED 2026-08-19: a hook that
# blocked left `claude -p` stalled at 400 s on ONE failed Bash command
# (EXIT=124, empty result); the identical run with `"timeout": 5` finished in
# 18 s with {"is_error":false,"subtype":"success","num_turns":2}. A hook's own
# try/catch cannot cover a blocking syscall, so the bound has to come from the
# settings file.
#
#   PostToolUseFailure = 5 s. It sits on the agent's CRITICAL PATH, makes NO
#   brain call at all (failure-hook.mjs is a self-contained port of
#   LoopDetector::observe), and does nothing but fingerprint the event and
#   touch one small state file. Its honest budget is milliseconds; 5 s is
#   slack, not an allowance.
#
#   Stop = 240 s. The opposite regime -- this is the hook that is ALLOWED to be
#   slow, because it calls the brain, and those calls were measured at 23.6 s
#   and 37.9 s. 240 s is 6.3x the slowest measured run and exactly 2x the
#   hook's own per-call ceiling (MCP_TIMEOUT=120000, set further down this
#   script), so the two ops that can legitimately be slow -- the ledger
#   `status` and the LLM-judge `verify` -- may BOTH hit their own ceiling and
#   the hook still returns by itself and logs. What the bound really cuts is
#   the unbounded case: stop-hook.mjs issues one `record` call per Bash command
#   in the session, so a brain that hangs rather than refuses multiplies 120 s
#   by however many commands the trial ran. Capping that at 4 minutes of a
#   ~40-minute trial is the trade. Lower would start truncating real
#   verifications -- and a truncated verify gate is not a slow run, it is a run
#   that measures nothing, which is the failure this whole campaign keeps
#   hitting.
SETTINGS_SOURCE="${TB_VERIFYHOOK_SETTINGS:-$HERE/claude-settings-verifyhook.json}"
[ -f "$SETTINGS_SOURCE" ] || { echo "no Claude Code settings file at $SETTINGS_SOURCE" >&2; exit 2; }

# ── Credentials ─────────────────────────────────────────────────────────────
# Identical to run-terransoul.sh: read from the Claude settings file unless
# already exported. Never echoed.
# DEFAULT FLIPPED 2026-08-19 to settings.Sonnet5.json. It used to default to
# settings.Terranimus.json, whose ANTHROPIC_MODEL is `req/claude-fable-5` — so
# the 2026-08-18 shakedown measured the WRONG ACTOR against a standing
# sonnet-5 directive and nothing in the script noticed. Primary source, not
# recollection: jobs-terransoul/tsvh-shakedown-20260818-212303-30995/config.json
# resolved with `"model": "req/claude-fable-5"`. The guard below is what makes
# a future flip of this line non-silent.
# The settings file is ALSO handed to the container (`--ak config=` further
# down), so in oauth mode it must not be one that carries an endpoint override:
# ANTHROPIC_BASE_URL inside it would route the run back to the third-party
# endpoint while the job's config.json still read `claude-opus-5`, i.e. a
# correct-looking receipt over the wrong actor. Default per mode.
TB_AUTH="${TB_AUTH:-endpoint}"
if [ "$TB_AUTH" = "oauth" ]; then
  SETTINGS="${TB_SETTINGS_JSON:-$HOME/.claude/settings.json}"
else
  SETTINGS="${TB_SETTINGS_JSON:-$HOME/.claude/settings.Sonnet5.json}"
fi
if [ -f "$SETTINGS" ]; then
  eval "$(node -e '
    const j = require(process.argv[1]).env || {};
    const q = (s) => "\x27" + String(s ?? "").replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]) {
      if (j[k]) console.log(`: "${"$"}{${k}:=${"$"}(printf %s ${q(j[k])})}"`);
    }
  ' "$SETTINGS")"
fi
# ── Credential mode ─────────────────────────────────────────────────────────
# TB_AUTH=endpoint (default) — a third-party Anthropic-compatible endpoint,
#   authenticated with an x-api-key style ANTHROPIC_AUTH_TOKEN.
# TB_AUTH=oauth — the HOST'S OWN Claude subscription, the way TB2.1 ran
#   (run-dg.sh:703 passes --ae CLAUDE_CODE_OAUTH_TOKEN and sets no ANTHROPIC_*
#   endpoint vars at all). The credential is a short-lived OAuth access token
#   read from ~/.claude/.credentials.json.
#
# ⛔ THE TOKEN CANNOT BE REFRESHED MID-RUN. harbor injects it once via --ae and
# in-container Claude Code has no browser to re-authenticate with, so a sweep
# that outlives the token 401s on its later trials. That is not hypothetical:
# 20 trials once scored 0 with ZERO completion tokens after the token expired,
# and the run looked like a model failure rather than an auth failure. Rotation
# is ALSO lazy — the host CLI only exchanges the refresh token when it is
# INVOKED and finds an expired one — so `refresh_token` below pokes the CLI
# rather than waiting for a rotation nothing is triggering.
if [ "$TB_AUTH" = "oauth" ]; then
  # Exact ids only: `claude-opus-5`, `claude-sonnet-5`. `claude-opus-4-5` is
  # Opus 4.5 and was passed by mistake once — it is a different model.
  #
  # ASSIGNED, NOT DEFAULTED. `${ANTHROPIC_MODEL:-...}` would inherit whatever a
  # settings file already resolved (measured: `req/claude-sonnet-5` leaked in
  # from the endpoint settings file and the guard then refused a run that was
  # otherwise correct). In this mode the model is a LAUNCH PARAMETER, exactly as
  # TB2.1's `-m "${TB_MODEL:-claude-opus-5}"` made it.
  ANTHROPIC_MODEL="${TB_MODEL:-claude-opus-5}"
  # ONE implementation, sourced — this logic previously lived in two drivers
  # and was MISSING from three others, which is how a 2-day-stale token reached
  # a sweep. See benchmark/terminal-bench-2.1/token-refresh.sh.
  # shellcheck source=../terminal-bench-2.1/token-refresh.sh
  . "$REPO/benchmark/terminal-bench-2.1/token-refresh.sh"
  refresh_token || {
    echo "[run] REFUSING: no Claude credential with enough life left for a sweep." >&2
    echo "[run] Run 'claude -p ok' to make the CLI exchange its refresh token, then retry." >&2
    exit 2
  }
  # refresh_token PUBLISHES to a file rather than exporting into this shell —
  # its contract is "$TB_TOKEN_FILE now holds CLAUDE_CODE_OAUTH_TOKEN=...".
  TB_TOKEN_FILE="${TB_TOKEN_FILE:-$REPO/mcp-data/.tb-token.env}"
  [ -s "$TB_TOKEN_FILE" ] || {
    echo "[run] REFUSING: token-refresh reported success but $TB_TOKEN_FILE is empty." >&2
    exit 2
  }
  # shellcheck disable=SC1090
  . "$TB_TOKEN_FILE"
  : "${CLAUDE_CODE_OAUTH_TOKEN:?$TB_TOKEN_FILE did not define CLAUDE_CODE_OAUTH_TOKEN}"
  # An endpoint override would silently defeat the whole point of this mode.
  unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
  export CLAUDE_CODE_OAUTH_TOKEN
else
  : "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL not set and not found in $SETTINGS}"
  : "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN not set and not found in $SETTINGS}"
fi
: "${ANTHROPIC_MODEL:?ANTHROPIC_MODEL not set and not found in $SETTINGS}"
# TBENCH-CREDS-EXPORT-1 (found 2026-08-18, shakedown phase): the `:` "${VAR:=…}"
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
# key actually worked (confirmed: the exact same token succeeds every time
# when actually exported). See test-credential-export.sh.
if [ "$TB_AUTH" = "oauth" ]; then
  export ANTHROPIC_MODEL
else
  export ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL
fi

# ── Model guard: never re-measure the wrong actor ───────────────────────────
# A settings file is a silent, global input: whichever one this script happens
# to read decides which model the whole sweep measures, and nothing downstream
# re-states it loudly enough to catch. That is not hypothetical — the
# 2026-08-18 shakedown ran to completion, produced a result.json, and cost real
# money measuring `req/claude-fable-5` while the campaign's actor is sonnet-5.
# Declaring the expected actor turns "wrong model" from something you discover
# in a resolved config afterwards into a refusal before anything is spent.
#
# TB_EXPECT_MODEL='' (explicitly empty, not merely unset) disables the guard,
# for the deliberate case of measuring something else on purpose. The receipt
# line prints the resolved model either way, so the record never depends on
# knowing which settings file was in play.
# The expected actor depends on the credential mode: the endpoint serves
# `req/`-prefixed ids, the host subscription serves bare ones. Defaulting per
# mode keeps the guard meaningful in both instead of forcing callers to disable
# it (an empty TB_EXPECT_MODEL) whenever they switch modes — a disabled guard is
# how a sweep once measured the wrong model to completion.
if [ "$TB_AUTH" = "oauth" ]; then
  TB_EXPECT_MODEL="${TB_EXPECT_MODEL-claude-opus-5}"
else
  TB_EXPECT_MODEL="${TB_EXPECT_MODEL-req/claude-sonnet-5}"
fi
if [ -n "$TB_EXPECT_MODEL" ] && [ "$ANTHROPIC_MODEL" != "$TB_EXPECT_MODEL" ]; then
  echo "[run] REFUSING: ANTHROPIC_MODEL is '$ANTHROPIC_MODEL', expected '$TB_EXPECT_MODEL'." >&2
  echo "[run] It resolved from $SETTINGS (or a pre-exported ANTHROPIC_MODEL, which wins)." >&2
  echo "[run] A sweep measures whatever model this variable names; a mismatch means the" >&2
  echo "[run] number belongs to a different actor than the one being reported." >&2
  echo "[run] Fix the source (TB_SETTINGS_JSON=~/.claude/settings.Sonnet5.json), or set" >&2
  echo "[run] TB_EXPECT_MODEL to the model you actually intend to measure." >&2
  exit 2
fi

# ── Host process headroom: the sweep needs to SPAWN, not just to run ────────
#
# MEASURED, tsbroad-20260819-080345-63875: 19 of 20 trials died with
# `Return code: 3221225794` = 0xC0000142, Windows "DLL initialization failed" —
# a process-CREATION failure. Harbor could not spawn `docker compose` at all,
# so artifact extraction (`cp`), teardown (`down`) and the verifier `build`
# each failed in turn, every affected trial was marked failed, and its
# containers were left orphaned because `down` was one of the things that could
# not run. The job wrote a result.json and exited. That is a measurement of
# NOTHING, not a score of 0 (rules: a run that never happened is not a
# failure), and 0xC0000142 already appears in CAMPAIGN-RECORD.md from
# 2026-08-15 with the same verdict.
#
# The trap that makes this worth a guard: MEMORY LOOKS FINE. At the moment of
# collapse the host had 1038 processes / 90 node.exe / 115 conhost.exe and
# 27 GB of RAM still free. Every "is the machine ok?" check that looks at
# memory says yes. The exhausted resource is the process/desktop-heap budget.
#
# And a spawn TEST is not sufficient either: `docker compose version` succeeds
# at this same process count. The failure is threshold-dependent and appears at
# PEAK, once several trial containers are up — so the check that helps is
# HEADROOM before launch, not liveness at launch.
#
# TB_MAX_HOST_PROCESSES='' disables the guard; TB_ALLOW_HIGH_LOAD=1 proceeds
# anyway and stamps the receipt, matching the TB_ALLOW_SKIP_GPU/TB_ALLOW_NO_BRAIN
# pattern — a degraded run is allowed, but never silently.
TB_MAX_HOST_PROCESSES="${TB_MAX_HOST_PROCESSES-900}"
HOST_PROCS=""
if [ -n "$TB_MAX_HOST_PROCESSES" ] && command -v tasklist >/dev/null 2>&1; then
  HOST_PROCS="$(tasklist 2>/dev/null | wc -l | tr -d '[:space:]')"
  if [ -n "$HOST_PROCS" ] && [ "$HOST_PROCS" -gt "$TB_MAX_HOST_PROCESSES" ] 2>/dev/null; then
    if [ -n "${TB_ALLOW_HIGH_LOAD:-}" ]; then
      echo "[run] WARNING: $HOST_PROCS host processes (> $TB_MAX_HOST_PROCESSES), continuing by TB_ALLOW_HIGH_LOAD." >&2
      echo "[run] If trials fail with return code 3221225794 (0xC0000142), THIS is why," >&2
      echo "[run] and those trials are INVALID rather than scored 0." >&2
    else
      echo "[run] REFUSING: $HOST_PROCS host processes, over the $TB_MAX_HOST_PROCESSES headroom limit." >&2
      echo "[run] Windows fails process CREATION long before it runs out of memory, and a" >&2
      echo "[run] sweep spawns docker compose repeatedly per trial (build/cp/down/verify)." >&2
      echo "[run] A run started here dies with 3221225794 (0xC0000142) mid-sweep and yields" >&2
      echo "[run] no measurement at all -- 19 of 20 trials were lost that way on 2026-08-19." >&2
      echo "[run] Close background agents/terminals (node.exe and conhost.exe dominate), or" >&2
      echo "[run] set TB_ALLOW_HIGH_LOAD=1 to proceed with the risk recorded on the receipt." >&2
      exit 2
    fi
  fi
fi

# ── Preflight: the CLI must be packable, and the endpoint must actually work ─
# Same rationale as run-terransoul.sh: a run that never happened is not a
# failure, it is a measurement of nothing (this repo has published one
# before -- 20 trials scored 0 with zero completion tokens after a token was
# revoked). Both checks cost seconds and turn that class of outcome into a
# refusal to start.
# ── Preflight: the Docker daemon ────────────────────────────────────────────
# Every trial runs in a container, so the daemon is the one dependency with NO
# fallback — and it was the only preflight this script did not have. Measured
# 2026-08-20: `com.docker.service` was found Stopped mid-campaign. The run
# before that (tsopusctl-20260820-033713) came back with 5 of 6 trials errored
# -- 3 RuntimeError, 1 RewardFileNotFoundError, 1 ApiRateLimitError -- and the
# result was initially attributed to subscription rate limits. Only ONE error
# was a rate limit; the other four are consistent with the engine dying under
# the run. A dead daemon does not announce itself as a dead daemon, it announces
# itself as a scattering of unrelated-looking trial failures, which is exactly
# the shape that gets misread as a result.
#
# `docker info` is the check that actually proves the daemon answers; `docker
# ps` or a version string can succeed against a client with no engine behind it.
if command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    echo "[run] REFUSING: the Docker daemon is not answering." >&2
    echo "[run] Every trial runs in a container, so this would not fail cleanly -- it would" >&2
    echo "[run] produce errored trials that look like agent failures and score as zeros." >&2
    echo "[run] Start it (elevated: Start-Service com.docker.service, or launch Docker" >&2
    echo "[run] Desktop and wait for 'Engine running'), then re-run." >&2
    exit 2
  fi
else
  echo "[run] REFUSING: no docker client on PATH; harbor cannot start any trial." >&2
  exit 2
fi

# Windows Update servicing gate (TSVH-WU-1, 2026-08-23). The tsvh sweep lost
# 9 of 15 trials to 0xC0000142 (DLL-init failure on process creation) in two
# acute ~11-second windows while WindowsUpdateClient Id-19 installs ran in the
# same span — update servicing (TrustedInstaller swapping system DLLs) breaks
# `docker compose build` spawns, and each broken build invalidates a whole
# trial. A pending reboot means servicing is mid-flight or armed, so refuse by
# default; TB_ALLOW_PENDING_REBOOT=1 overrides for a deliberate risk-accepted
# run. Detection is two registry keys, checked via reg.exe so Git Bash works.
if [ "${TB_ALLOW_PENDING_REBOOT:-0}" != "1" ]; then
  _wu=0
  reg query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired' >/dev/null 2>&1 && _wu=1
  reg query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' >/dev/null 2>&1 && _wu=1
  if [ "$_wu" = "1" ]; then
    echo "[run] REFUSING: Windows Update has a REBOOT PENDING. Update servicing broke" >&2
    echo "[run] process creation twice during the 2026-08-23 sweep (0xC0000142) and" >&2
    echo "[run] invalidated 9 of 15 trials. Reboot first, or set" >&2
    echo "[run] TB_ALLOW_PENDING_REBOOT=1 to accept the risk knowingly." >&2
    exit 2
  fi
fi

CORE_DIR="$REPO/packages/terransoul-core"
CLI_DIR="$REPO/packages/terransoul-cli"
[ -f "$CORE_DIR/package.json" ] || { echo "no core package at $CORE_DIR" >&2; exit 2; }
[ -f "$CLI_DIR/package.json" ] || { echo "no CLI package at $CLI_DIR" >&2; exit 2; }

if [ "$TB_AUTH" = "oauth" ]; then
  # There is no endpoint to probe and an OAuth access token is NOT an
  # x-api-key, so the /v1/messages probe below would report a WORKING
  # credential as a 401 — the same false-negative shape as TBENCH-CREDS-EXPORT-1.
  # `refresh_token` already proved liveness the only way that matters here: it
  # poked the host CLI and confirmed the credential has headroom left.
  #
  # (Note for anyone re-enabling a probe here: a reasoning model can return
  # HTTP 200 with an EMPTY text block when max_tokens is small, because the
  # budget is spent on hidden reasoning before any visible token. Measured on
  # claude-opus-5: max_tokens=64 -> stop_reason=max_tokens, 0 chars of text,
  # 64 output tokens. A 16-token probe would call a healthy model dead.)
  echo "[preflight] credential: CLAUDE_CODE_OAUTH_TOKEN (${#CLAUDE_CODE_OAUTH_TOKEN} chars, not echoed), model $ANTHROPIC_MODEL"
else
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
fi

# ── Preflight: MCP wiring, and WHICH STORE is behind it ─────────────────────
#
# WHY A REFUSAL AND NOT A WARNING. Lines further down document that with no
# TERRANSOUL_MCP_URL the Stop hook "fails open ... so an unset URL just means
# the verify gate never fires". Read the consequence plainly: the job still
# runs, still reports `agent=claude-code-terransoul-hook`, still costs a full
# sweep, and measures STOCK Claude Code with nothing of TerranSoul attached.
# The 2026-08-18 shakedown is the demonstration — roughly $100 spent, and its
# proxy log (proxy-logs/proxy-tsvh-20260818-210944.jsonl) holds 19 calls, all
# brain_verify_completion from the hook, with no `initialize` and no
# `tools/list` from the agent at all. Degrading to that must be an explicit,
# printed act, never an accident of an unset variable.
#
# WHICH BRAIN. `mcp-auth-proxy.mjs`'s TB_PROXY_UPSTREAM_PORT USED TO DEFAULT
# to 7423 — the PRODUCTION brain, which holds task-specific TerminalBench
# lessons from prior campaigns — and on 2026-08-19 a proxy started without
# that variable served production to the agent; only this check caught it.
# That default is gone (the proxy now defaults to the bench brain and refuses a
# production upstream without TB_PROXY_ALLOW_PRODUCTION_UPSTREAM=1), and THIS
# CHECK STAYS regardless: fixing a bad default is not a reason to remove the
# guard that caught it. Serving prior-campaign lessons to the agent is
# contamination that would invalidate the submission
# (rules/bench-agi-purity.md). The isolated bench
# brain is `start-bench-brain.mjs` on 7424 against mcp-data-tbench-clean/,
# which `clean-bench-brain.mjs` audits by retrieval. This check does not take
# the operator's word for which one is upstream: it probes /health THROUGH the
# proxy URL the container will use, and reads the `port` field the SERVING
# brain reports about itself (router.rs::handle_health emits `"port":
# state.port`, its own listener port). A proxy pointed at production answers
# 7423 there no matter what anyone intended.
TB_BENCH_BRAIN_PORT="${TB_BENCH_BRAIN_PORT:-7424}"
TB_PRODUCTION_BRAIN_PORT="${TB_PRODUCTION_BRAIN_PORT:-7423}"
MCP_CONFIG="$HERE/mcp-terransoul.json"
STACK_LAUNCHER="$HERE/start-bench-stack.mjs"
TB_PROXY_PORT_DEFAULT="${TB_PROXY_PORT:-7425}"

# ── THE STACK HAS AN OWNER NOW (TBENCH-STACK-1, measured 2026-08-19) ────────
# The brain + proxy pair used to be two hand-typed commands in a fixed order
# with three environment variables that had to be right, and every way of
# getting it wrong failed silently. Worse, the proxy was being started as a
# harness-tracked background task: it was KILLED MID-SWEEP on 2026-08-19,
# leaving live trials with no MCP for roughly 12 minutes while the fail-open
# Stop hook reported nothing. start-bench-stack.mjs owns that lifecycle —
# detached, so it outlives whatever shell started it, and verified end to end
# (an authenticated tools/list through the proxy, which is the only check that
# catches a token belonging to the wrong store).
#
# TB_START_STACK=1 lets this script bring the stack up itself; otherwise the
# refusal below names the exact one command. Half-right must not be silent.
if [ -n "${TB_START_STACK:-}" ] && [ -z "${TERRANSOUL_MCP_URL:-}" ]; then
  echo "[run] TB_START_STACK=1 — bringing the bench MCP stack up before the preflight." >&2
  node "$STACK_LAUNCHER" --brain-port "$TB_BENCH_BRAIN_PORT" --proxy-port "$TB_PROXY_PORT_DEFAULT" >&2 \
    || { echo "[run] REFUSING: the bench MCP stack did not come up." >&2; exit 2; }
  export TERRANSOUL_MCP_URL="http://host.docker.internal:$TB_PROXY_PORT_DEFAULT/mcp"
fi

if [ -z "${TERRANSOUL_MCP_URL:-}" ]; then
  if [ -n "${TB_ALLOW_NO_BRAIN:-}" ]; then
    echo "[run] RUNNING WITH NO BRAIN, by TB_ALLOW_NO_BRAIN: the agent gets no TerranSoul" >&2
    echo "[run] MCP tools and the verify gate never fires. This measures STOCK Claude Code;" >&2
    echo "[run] any number from it must be reported as such, not as claude-code-terransoul-hook." >&2
  else
    echo "[run] REFUSING: TERRANSOUL_MCP_URL is unset." >&2
    echo "[run] Without it the agent gets no MCP tools and the Stop hook fails open — the" >&2
    echo "[run] job would run, cost a full sweep, and measure stock Claude Code while" >&2
    echo "[run] reporting agent=claude-code-terransoul-hook (measured 2026-08-18)." >&2
    echo "[run] Bring the bench MCP stack up with THE ONE COMMAND (detached, health-checked," >&2
    echo "[run] token derived from the upstream, verified with an authenticated tools/list):" >&2
    echo "[run]   node $STACK_LAUNCHER" >&2
    echo "[run]   export TERRANSOUL_MCP_URL=http://host.docker.internal:$TB_PROXY_PORT_DEFAULT/mcp" >&2
    echo "[run] Or re-run this script with TB_START_STACK=1 to have it do both." >&2
    echo "[run] (Starting start-bench-brain.mjs and mcp-auth-proxy.mjs by hand still works, but the" >&2
    echo "[run] stack launcher is the only path verified end to end — see TBENCH-STACK-1, 2026-08-19.)" >&2
    echo "[run] Or set TB_ALLOW_NO_BRAIN=1 to run degraded, with that stated on the receipt." >&2
    exit 2
  fi
else
  [ -f "$MCP_CONFIG" ] || { echo "[run] REFUSING: no MCP config at $MCP_CONFIG" >&2; exit 2; }
  PROXY_PROBE_URL="${TB_PROXY_PROBE_URL:-$(printf %s "$TERRANSOUL_MCP_URL" | sed -e 's|host\.docker\.internal|127.0.0.1|' -e 's|/mcp/*$||')}"
  BRAIN_PROBE_URL="${TB_BRAIN_PROBE_URL:-http://127.0.0.1:$TB_BENCH_BRAIN_PORT}"
  echo "[preflight] probing the brain on $BRAIN_PROBE_URL and the proxy on $PROXY_PROBE_URL ..."
  TB_PROBE_PROXY="$PROXY_PROBE_URL" \
  TB_PROBE_BRAIN="$BRAIN_PROBE_URL" \
  TB_PROBE_BENCH_PORT="$TB_BENCH_BRAIN_PORT" \
  TB_PROBE_PROD_PORT="$TB_PRODUCTION_BRAIN_PORT" \
  TB_PROBE_MCP_URL="$TERRANSOUL_MCP_URL" \
  TB_PROBE_MCP_CONFIG="$MCP_CONFIG" \
  node -e '
const fs = require("node:fs");
const proxy = process.env.TB_PROBE_PROXY;
const brain = process.env.TB_PROBE_BRAIN;
const benchPort = Number(process.env.TB_PROBE_BENCH_PORT);
const prodPort = Number(process.env.TB_PROBE_PROD_PORT);
// Every tool the shipped extra-instruction file tells the agent it has, plus
// the one the Stop hook calls. A missing name here means the agent would be
// told about a tool that is not on the wire.
const REQUIRED = ["brain_search", "brain_get_entry", "brain_kg_neighbors", "brain_health", "brain_verify_completion"];
const die = (msg) => { console.error("  " + msg); process.exit(1); };

async function health(base, label) {
  let res;
  try { res = await fetch(base + "/health"); }
  catch (e) { die(`${label}: ${base}/health is unreachable (${e.message})`); }
  if (!res.ok) die(`${label}: ${base}/health returned HTTP ${res.status}`);
  let body;
  try { body = JSON.parse(await res.text()); }
  catch { die(`${label}: ${base}/health did not return JSON`); }
  if (body.status && body.status !== "ok") die(`${label}: reports status=${body.status}`);
  return body;
}

// The MCP streamable-HTTP transport answers either JSON or SSE; take the last
// data frame either way (same parse clean-bench-brain.mjs uses).
function parseRpc(text) {
  const line = text.replace(/^data:\s*/gm, "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return null; }
}
let rpcId = 0;
async function rpc(method, params, sessionId) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(proxy + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if (!res.ok) die(`proxy: ${method} -> HTTP ${res.status}: ${text.slice(0, 160)}`);
  const body = parseRpc(text);
  if (!body) die(`proxy: ${method} returned an unparseable body: ${text.slice(0, 160)}`);
  if (body.error) die(`proxy: ${method} -> ${JSON.stringify(body.error).slice(0, 160)}`);
  return { result: body.result, sessionId: res.headers.get("mcp-session-id") || sessionId };
}

(async () => {
  // 0. The config the AGENT gets and the URL the HOOK gets must be the same
  //    endpoint. Two different endpoints is a silent split brain.
  const cfg = JSON.parse(fs.readFileSync(process.env.TB_PROBE_MCP_CONFIG, "utf8"));
  const declared = cfg?.mcpServers?.terransoul?.url;
  if (!declared) die(`${process.env.TB_PROBE_MCP_CONFIG} declares no mcpServers.terransoul.url`);
  if (declared !== process.env.TB_PROBE_MCP_URL) {
    die(`the agent would get ${declared} but the Stop hook gets ${process.env.TB_PROBE_MCP_URL} — same endpoint required`);
  }

  // 1. The isolated bench brain itself is up on the port we expect it on.
  const direct = await health(brain, "bench brain");
  if (Number(direct.port) !== benchPort) {
    die(`bench brain: ${brain}/health reports it is serving port ${direct.port}, expected ${benchPort}`);
  }

  // 2. THE SAFETY CHECK. Whatever answers through the proxy is the store the
  //    agent will actually read. Its self-reported port decides.
  const served = await health(proxy, "proxy");
  const servedPort = Number(served.port);
  if (servedPort === prodPort) {
    die(
      `REFUSING: the proxy on ${proxy} is serving the PRODUCTION brain (port ${prodPort}). ` +
      "It holds task-specific TerminalBench lessons from earlier campaigns; serving them to " +
      "the agent is contamination and invalidates the submission. Restart the proxy with " +
      `TB_PROXY_UPSTREAM_PORT=${benchPort}.`,
    );
  }
  if (servedPort !== benchPort) {
    die(
      `REFUSING: the proxy on ${proxy} is serving a brain that reports port ${servedPort}, ` +
      `not the isolated bench brain on ${benchPort}. Only the audited bench store may be served.`,
    );
  }

  // 3. The tools really are on the wire, through the proxy, right now.
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tsvh-preflight", version: "1" },
  });
  const listed = await rpc("tools/list", {}, init.sessionId);
  const names = new Set((listed.result?.tools || []).map((t) => t.name));
  const missing = REQUIRED.filter((n) => !names.has(n));
  if (missing.length) {
    die(`proxy: tools/list is missing ${missing.join(", ")} (served: ${[...names].join(", ") || "none"})`);
  }
  console.log(`  ok: brain on ${servedPort} via ${proxy}, ${names.size} tool(s) served, memory_total=${served.memory_total ?? "?"}`);
})().catch((e) => { console.error("  " + e.message); process.exit(1); });
' || {
    echo "[preflight] MCP wiring check failed — refusing to start" >&2
    echo "[preflight] Rebuild the stack from scratch with one command:" >&2
    echo "[preflight]   node $STACK_LAUNCHER --stop && node $STACK_LAUNCHER" >&2
    exit 2
  }

  # ── IS THE BRAIN SERVING THE INSTRUCTIONS WE THINK IT IS? ─────────────────
  # A SOURCE change is not a DEPLOYED change. MEASURED 2026-08-19 against the
  # binary this stack was running (target-mcp/release/terransoul.exe, Aug 18
  # 20:49): it still served "do not let consulting memory delay you" and "also
  # searches derived sub-queries" — 4 grep hits each — and carried ZERO hits of
  # "BEFORE YOU COMMIT TO AN APPROACH". The de-suppression existed only in
  # tools.rs, pinned by a cargo test that links the SOURCE and can never see
  # the shipped .exe.
  #
  # That matters more than a stale binary usually would, because
  # extra-instruction-harness.md was shrunk 72% on the explicit argument that
  # SERVER_INSTRUCTIONS now carries the deleted guidance. Against a stale
  # binary the run ships NEITHER copy, and nothing anywhere says so — the exact
  # silent-degradation shape as the unset-TERRANSOUL_MCP_URL incident above.
  #
  # The check asks the RUNNING SERVER, through the same URL the container uses,
  # so it cannot be satisfied by a rebuild that was never restarted.
  echo "[preflight] checking the SERVER_INSTRUCTIONS served on $PROXY_PROBE_URL ..."
  node "$HERE/check-served-instructions.mjs" --url "$PROXY_PROBE_URL" >&2 || {
    echo "[preflight] served-instructions check failed — refusing to start" >&2
    exit 2
  }
fi

# ── Harbor ──────────────────────────────────────────────────────────────────
HARBOR="$(command -v harbor || echo "$HOME/.local/bin/harbor")"
"$HARBOR" --version >/dev/null || { echo "harbor not found" >&2; exit 2; }

ATTEMPTS="${TB_ATTEMPTS:-5}"      # leaderboard minimum is 5 trials per task
CONCURRENCY="${TB_CONCURRENCY:-2}" # owner decision: two workers, never three
DATASET="${TB_DATASET:-terminal-bench/terminal-bench}"
# TBENCH-ORCH-1 (same race class as run-terransoul.sh, memory_id 25958): a
# timestamp alone is a CWE-367-class TOCTOU risk if two invocations launch
# within the same second. $$ is always distinct between two concurrently
# running invocations, with no external uuid/date dependency.
JOB="${TB_JOB_PREFIX:-tsvh}-$(date +%Y%m%d-%H%M%S)-$$"
JOBS_DIR="${TB_JOBS_DIR:-$HERE/jobs-terransoul}"
mkdir -p "$JOBS_DIR"

export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"

args=(
  run
  -a "terransoul_verify_hook_agent:TerranSoulVerifyHookAgent"
  -m "$ANTHROPIC_MODEL"
  --ak "config=$SETTINGS_SOURCE"
  --env docker
  -o "$JOBS_DIR" --job-name "$JOB"
  -k "$ATTEMPTS" -n "$CONCURRENCY" -y
)

# The container gets EITHER the endpoint credential OR the host subscription's
# OAuth token — never both. Passing an endpoint override alongside the OAuth
# token would silently route the run back to the third-party endpoint and the
# job's config.json would still read `claude-opus-5`, so the receipt would look
# right while the actor was wrong.
if [ "$TB_AUTH" = "oauth" ]; then
  args+=(--ae "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
else
  args+=(--ae "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL")
  args+=(--ae "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN")
  args+=(--ae "ANTHROPIC_MODEL=$ANTHROPIC_MODEL")
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

# The Stop hook reaches the MCP brain the same way `terransoul_cli_agent.py`
# does (`mcpFromEnv` reads these exact two env vars, confirmed in
# `packages/terransoul-cli/test/stop-hook.test.mjs`'s real-CLI-process test).
# NO LONGER OPTIONAL. The hook fails open with no MCP configured (`decideStop`
# returns `{block:false}` immediately when `mcp` is null), so an unset URL
# means the verify gate never fires -- never a hang or a false block, and never
# a visible failure either. The preflight above therefore refuses an unset
# TERRANSOUL_MCP_URL unless TB_ALLOW_NO_BRAIN says so out loud.
if [ -n "${TERRANSOUL_MCP_URL:-}" ]; then
  args+=(--ae "TERRANSOUL_MCP_URL=$TERRANSOUL_MCP_URL")
  [ -n "${TERRANSOUL_MCP_TOKEN:-}" ] && args+=(--ae "TERRANSOUL_MCP_TOKEN=$TERRANSOUL_MCP_TOKEN")

  # ── AND THE AGENT'S OWN MCP CLIENT ────────────────────────────────────────
  # THE ENV VAR ABOVE REACHES THE HOOK ONLY. `TERRANSOUL_MCP_URL` is read by
  # `terransoul stop-hook` (`mcpFromEnv`); Claude Code has never heard of it.
  # Registering a server with the AGENT is a different mechanism entirely:
  # `--mcp-config` -> harbor/cli/utils.py::load_mcp_servers ->
  # harbor/cli/jobs.py:1235-1295 -> agent.mcp_servers ->
  # harbor/agents/installed/claude_code.py:1559-1585, which writes
  # {"mcpServers": ...} into the container's CLAUDE_CONFIG_DIR/.claude.json —
  # and does so ONLY when that list is non-empty, which is precisely why the
  # 2026-08-18 shakedown's containers had no mcpServers key and its whole proxy
  # log contains not one agent-side `initialize`. The 2026-08-17 jobs-learn
  # config for this same agent class DID declare mcp_servers and its proxy log
  # shows initialize/tools/list/brain_search. Both mechanisms are needed: the
  # hook verifies, the agent retrieves.
  args+=(--mcp-config "$MCP_CONFIG")

  # The task-agnostic knowledge instruction. READ-SIDE ONLY: the write half
  # lives in extra-instruction-memory.md and is deliberately NOT wired (the
  # proxy's default allowlist refuses those tools, and cross-trial writes are a
  # separate ruling). Purity of this file is gated by test-run-terransoul.sh,
  # which reads the task roster from the dataset and fails if any task name
  # appears in it.
  args+=(--extra-instruction-path "$HERE/extra-instruction-harness.md")

  # Claude Code's MCP client gives up on a slow server long before the brain's
  # `research`/`max` rungs finish. Same values the working 2026-08-17 config
  # used; overridable, never absent.
  args+=(--ae "MCP_TIMEOUT=${TB_MCP_TIMEOUT:-120000}")
  args+=(--ae "MCP_TOOL_TIMEOUT=${TB_MCP_TOOL_TIMEOUT:-900000}")
fi
# Optional operator override for the ledger's `record` op (CA-1 fast path);
# unset lets the hook auto-discover the task repo's OWN declared verify
# command from its manifest (`discoverVerifyCommands` in stop-hook.mjs) --
# never a hardcoded per-task verb list, per rules/bench-agi-purity.md.
if [ -n "${TERRANSOUL_VERIFY_COMMANDS:-}" ]; then
  args+=(--ae "TERRANSOUL_VERIFY_COMMANDS=$TERRANSOUL_VERIFY_COMMANDS")
fi

# TB_TASK takes one id or a comma-separated list; defaults to the exact
# 3-task subset CAMPAIGN-RECORD.md measured this architecture against
# (`memcached-backdoor`, `mvcc-lsm-compaction`, `session-window-debug`), so a
# bare invocation reproduces the same A/B comparison rather than a full sweep.
TB_TASK="${TB_TASK:-terminal-bench/memcached-backdoor,terminal-bench/mvcc-lsm-compaction,terminal-bench/session-window-debug}"
IFS=',' read -ra _tasks <<< "$TB_TASK"
for _t in "${_tasks[@]}"; do
  _t="$(printf %s "$_t" | tr -d '[:space:]')"
  [ -n "$_t" ] && args+=(-i "$_t")
done

# ── GPU tasks abort the WHOLE JOB, not just their own trial ─────────────────
# Same guard as run-terransoul.sh, same rationale (see there for the full
# incident writeup) -- irrelevant to the default 3-task subset (none of the
# three declare a GPU requirement) but kept so a TB_TASK override is covered.
TASK_CACHE="$HOME/.cache/harbor/tasks/packages/terminal-bench"
if [ ! -d "$TASK_CACHE" ]; then
  echo "[run] NOTE: no task cache at $TASK_CACHE — the GPU-only guard cannot run." >&2
  echo "[run] If this is a full sweep, expect the job to abort at the first GPU task." >&2
fi

# A TASK ID THAT MATCHES NOTHING IS A SILENT COVERAGE LOSS — same guard as
# run-terransoul.sh: refuse rather than let Harbor silently run a smaller set.
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
    g="$(grep -m1 -E '^[[:space:]]*gpus[[:space:]]*=' "$toml" 2>/dev/null | tr -d '[:space:]' | cut -d= -f2 || true)"
    [ -n "$g" ] && [ "$g" != "0" ] || continue
    name="$(basename "$(dirname "$(dirname "$toml")")")"
    if [ -z "${TB_TASK:-}" ] || printf %s "$TB_TASK" | grep -q "$name"; then
      gpu_tasks="$gpu_tasks $name"
    fi
  done
  if [ -n "$gpu_tasks" ]; then
    if [ -n "${TB_ALLOW_SKIP_GPU:-}" ]; then
      echo "[run] EXCLUDING GPU-only task(s), by TB_ALLOW_SKIP_GPU:$gpu_tasks" >&2
      echo "[run] any accuracy from this job is over the REMAINING tasks and must say so" >&2
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

# THE RECEIPT IS THE RECORD. Everything that decides what this sweep actually
# measures goes on one line: which model, which credential file it came from,
# and whether the brain is attached at all. The shakedown's own log line named
# the agent and the settings file but not the model, so `req/claude-fable-5`
# never appeared anywhere a reader would look.
if [ -n "${TERRANSOUL_MCP_URL:-}" ]; then
  BRAIN_RECEIPT="brain=$TERRANSOUL_MCP_URL(bench:$TB_BENCH_BRAIN_PORT)"
else
  BRAIN_RECEIPT="brain=NONE(TB_ALLOW_NO_BRAIN — stock Claude Code, verify gate never fires)"
fi
echo "[run] job=$JOB model=$ANTHROPIC_MODEL creds=$(basename "$SETTINGS") k=$ATTEMPTS n=$CONCURRENCY agent=claude-code-terransoul-hook settings=$(basename "$SETTINGS_SOURCE") $BRAIN_RECEIPT"

# A SEAM SO THE ARGUMENT CONSTRUCTION CAN BE TESTED WITHOUT SPENDING A SWEEP —
# same discipline as run-terransoul.sh's TB_DRY_RUN (the GPU exclusion there
# shipped broken precisely because nothing could observe the argv until a
# real 74-task run watched the job abort).
if [ -n "${TB_DRY_RUN:-}" ]; then
  printf '%s\n' "${args[@]}"
  exit 0
fi

# A SECOND SEAM, ONE LAYER DEEPER: TB_DRY_RUN proves what THIS SCRIPT hands
# Harbor; it cannot prove Harbor accepts it (the exact class of bug this repo
# has already shipped once — the GPU-exclusion pattern above was DRY_RUN-only
# and still shipped broken). `--print-config` is Harbor's OWN validation path
# (harbor/cli/jobs.py: resolves + validates the full JobConfig — including
# `validate_agent_concurrency_limits()` — and returns before `Job.create()`,
# so no environment/container is ever built). This is the exact step
# CAMPAIGN-RECORD.md records as "validated with --print-config before
# spending anything" for this same agent.
if [ -n "${TB_PRINT_CONFIG:-}" ]; then
  "$HARBOR" "${args[@]}" --print-config
  exit 0
fi

"$HARBOR" "${args[@]}"

# ── Result ──────────────────────────────────────────────────────────────────
# Read result.json, never the exit code — identical convention to
# run-terransoul.sh (see there for why: Harbor exits 0 on an all-zero job, and
# accuracy is PER-TRIAL, not "N/N tasks solved by at least one attempt").
JOB_DIR="$JOBS_DIR/$JOB"
echo
if [ -f "$JOB_DIR/result.json" ]; then
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
