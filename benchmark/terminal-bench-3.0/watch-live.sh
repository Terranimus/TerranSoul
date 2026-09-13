#!/usr/bin/env bash
# Analyse every IN-FLIGHT trial, without waiting for the job to finish.
#
#   bash watch-live.sh            # one pass over every running trial
#   bash watch-live.sh --tools    # also show the last tool calls of each
#
# WHY. A Terminal-Bench trial runs for 60-90 minutes. Waiting for the job to
# end before looking at it means every defect costs a full trial to discover,
# and this campaign spent most of a day that way. The agent's stream-json is
# written continuously inside the container, so there is nothing to wait for:
# `terransoul analyze` reads it exactly as it reads a finished one.
#
# The analysis itself lives in the CLI (`terransoul analyze`), which knows
# nothing about Docker or Harbor. This script is the bench-side half that knows
# where a running trial keeps its log. Keeping the split means the analyser
# stays usable on any run from any surface.
#
# THE `sh -c` IS LOAD-BEARING, not style. Under Git Bash / MSYS on Windows a
# bare `docker exec <c> cat /logs/agent/x` has its argument path-translated to
# `C:/Program Files/Git/logs/agent/x` before Docker ever sees it, and returns
# ~90 bytes of "No such file" instead of the log. Quoting the command for an
# in-container shell is what stops the translation.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLI="$REPO/packages/terransoul-cli/bin/terransoul.mjs"
STREAM=/logs/agent/terransoul-stream.jsonl

WORK="${TMPDIR:-/tmp}/ts-watch-live"
mkdir -p "$WORK"

containers="$(docker ps --format '{{.Names}}' | grep -- '__env-' || true)"
if [ -z "$containers" ]; then
  echo "no trial containers running"
  exit 0
fi

for c in $containers; do
  echo "════════ $c"
  out="$WORK/$c.jsonl"
  if ! docker exec "$c" sh -c "cat $STREAM" > "$out" 2>/dev/null; then
    echo "  (no stream yet)"
    continue
  fi
  [ -s "$out" ] || { echo "  (stream empty)"; continue; }

  node "$CLI" analyze "$out" 2>&1 | sed 's/^/  /'

  if [ "${1:-}" = "--tools" ]; then
    echo "  ── last tool calls"
    node -e '
      const {readFileSync} = require("node:fs")
      const calls = []
      for (const line of readFileSync(process.argv[1], "utf8").split("\n")) {
        if (!line.trim()) continue
        let ev; try { ev = JSON.parse(line) } catch { continue }
        if (ev.type !== "assistant") continue
        for (const b of ev.message?.content ?? []) {
          if (b.type === "tool_use") {
            const arg = b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? ""
            calls.push(`${b.name} ${String(arg).replace(/\s+/g, " ").slice(0, 76)}`)
          }
        }
      }
      for (const c of calls.slice(-8)) process.stdout.write(`    ${c}\n`)
    ' "$out"
  fi
done
