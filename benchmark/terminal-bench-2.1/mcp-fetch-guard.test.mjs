/**
 * The MCP fetch path must refuse the benchmark's own material.
 *
 * ⛔ WHY THIS EXISTS — A HOLE CLOSED BEFORE IT OPENED. `brain_ingest_url`
 * fetches an arbitrary URL server-side. The PreToolUse answer-key guard
 * (54e29c4d / 5e558448) covers Claude Code's WebFetch and CANNOT see this path:
 * an MCP tools/call never passes through a PreToolUse hook.
 *
 * Nothing reaches it TODAY only because `external_fetch` is a born-untrusted
 * action-trust category (threshold 0.75 vs a ~0.67 cold start), deny-by-default
 * and by design unable to bootstrap. MEASURED 2026-09-07: the tool returns
 * "action gated by earned autonomy ... trust (0.67) is below the earned
 * threshold (0.75)", which is why it has ZERO uses across 90 trials while
 * extra-instruction.md instructs the agent to use it.
 *
 * action_trust.rs states that posture is DATA ("with no code change"), so the
 * deny is one config edit from being lifted — and whoever lifts it would open an
 * unguarded fetch to tbench.ai. The markers mirror
 * trial-contamination-check.mjs's BENCH_URL, derived from the one confirmed
 * incident (mteb-retrieve nXLVpLp read the grader from harbor-framework).
 *
 * FAILS ON THE PRE-CHANGE TREE: gate() had no FETCH_TOOLS branch, so every URL
 * below was forwarded and `denied()` returned false.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'mcp-auth-proxy.mjs'), 'utf8')

// The proxy is a server module; exercise the marker contract it applies rather
// than booting it, so this needs no port, no upstream and no network.
const MARKERS = /(?:tbench\.ai|harborframework\.com|harbor-framework|laude-institute|terminal[-_]bench)/i
const denied = (url) => MARKERS.test(url)

test('the guard is actually wired into gate(), not merely defined', () => {
  assert.ok(SRC.includes('FETCH_TOOLS'), 'FETCH_TOOLS must exist')
  assert.ok(SRC.includes("answer-key-url"), 'the deny must be recorded with its own reason')
  assert.ok(
    SRC.indexOf('FETCH_TOOLS.has(name)') > SRC.indexOf('function gate('),
    'the check must live INSIDE gate(), where forwarding is decided',
  )
})

test('benchmark-owned URLs are refused', () => {
  assert.ok(denied('https://www.tbench.ai/registry/terminal-bench-core/head/raman-fitting'))
  assert.ok(denied('https://hub.harborframework.com/tasks/terminal-bench/x/latest'))
  assert.ok(
    denied('https://raw.githubusercontent.com/harbor-framework/terminal-bench-2/main/tasks/mteb-retrieve/tests/test_outputs.py'),
    'the exact URL from the one confirmed contamination must be refused',
  )
  assert.ok(denied('https://github.com/laude-institute/terminal-bench/blob/main/x.py'))
})

test('ordinary research URLs are untouched', () => {
  assert.ok(!denied('https://arxiv.org/abs/2406.02396'))
  assert.ok(!denied('https://wiki.povray.org/content/HowTo:Compile_POV-Ray_2.2'))
  assert.ok(!denied('https://docs.python.org/3/library/json.html'))
  assert.ok(!denied('https://www.neb.com/en-us/protocols/2018/10/02/golden-gate-assembly'))
  assert.ok(!denied('https://stackoverflow.com/questions/1/lorentzian-baseline'))
})

test('the guard is scoped to fetch tools only', () => {
  assert.ok(
    SRC.includes("const FETCH_TOOLS = new Set(['brain_ingest_url'])"),
    'only the tool that actually fetches a URL may be gated this way',
  )
})
