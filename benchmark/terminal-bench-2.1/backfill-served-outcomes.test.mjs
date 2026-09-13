/**
 * Tests for `backfill-served-outcomes.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist.
 *
 * THE GAP IT EXISTS FOR: `credit-trial-outcome.mjs` implements the right policy
 * on starved input — it reads the proxy's `served` log, which only 23 of 1207
 * job dirs have, against 2244 graded trials. Nearly every verdict ever produced
 * was discarded.
 *
 * ⛔ AND THE TOOL IS DELIBERATELY NOT RUN ON THE TASK THAT MOTIVATED IT. A dry
 * run scoped to filter-js-from-html plans 147 failure increments and 0
 * successes — because that task has never passed, so its base failure rate is
 * 1.0 and every served row shows 100% failure with ZERO lift. Applying it there
 * would debit 66 memories for appearing on a hard task, which is exactly what
 * served-memory-audit.mjs warns against. Shipping a tool and declining to fire
 * it is the correct outcome when your own instrument says the signal is empty.
 *
 * Hermetic: Map fixtures and a source read. No brain, no network, no job dirs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { planFromTrials } from './backfill-served-outcomes.mjs'

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'backfill-served-outcomes.mjs'),
  'utf8',
)

test('it counts successes as well as failures', () => {
  // ⛔ Debiting alone would ratchet the entire store downward: every row that
  // was ever retrieved would drift negative and nothing could ever recover.
  const perMemory = new Map([[42, new Map([['t', { served: 10, failed: 4 }]])]])
  const [p] = planFromTrials(perMemory, 0, Number.MAX_SAFE_INTEGER)
  assert.equal(p.failures, 4)
  assert.equal(p.successes, 6, 'the trials that PASSED must credit, not be dropped')
})

test('an id band confines the plan, because ids are per-brain', () => {
  // The bench store (:7424, mcp-data-tbench-clean) and production (:7423)
  // overlap at ~24000-26600. Writing a plan built from one into the other is a
  // mistake this session actually made.
  const perMemory = new Map([
    [1153, new Map([['t', { served: 4, failed: 4 }]])],
    [25952, new Map([['t', { served: 4, failed: 4 }]])],
  ])
  assert.deepEqual(
    planFromTrials(perMemory, 20000, Number.MAX_SAFE_INTEGER).map((p) => p.id),
    [25952],
  )
})

test('memories with no served trials never enter the plan', () => {
  const perMemory = new Map([[7, new Map([['t', { served: 0, failed: 0 }]])]])
  assert.deepEqual(planFromTrials(perMemory, 0, Number.MAX_SAFE_INTEGER), [])
})

test('it writes only with --apply, and probes the target store before bulk writing', () => {
  // ⛔ THE FAILURE THIS PREVENTS, made for real this session: a whole trial's
  // memories were credited to the production brain while the trial had been
  // reading the isolated bench store. Every call returned ok, `[credit]
  // recorded` printed, and nothing that mattered moved. A store probe turns
  // 2000 successful no-ops into one refusal.
  assert.match(SRC, /const APPLY = argv\.includes\('--apply'\)/, 'dry run must be the default')
  assert.match(SRC, /if \(!APPLY\) \{/, 'the dry-run branch must return before any write')
  assert.match(SRC, /session_id: 'backfill:store-probe'/, 'must probe the store first')
  assert.match(SRC, /WRONG STORE/, 'must refuse loudly when the probe does not credit')
  assert.match(
    SRC,
    /process\.exit\(4\)/,
    'a failed store probe must exit non-zero rather than continue',
  )
})
