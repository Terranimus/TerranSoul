#!/usr/bin/env node
/**
 * Tests for `forensics-side-by-side.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so the
 * import throws. Beyond that, the cases pin the two properties that make this
 * a READER rather than a second writer — it must surface the value an operator
 * came for, and it must reconstruct a record for a job directory that predates
 * the index instead of silently omitting it.
 *
 * Hermetic: a fabricated jobs root per case. No corpus, no brain, no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { collectRows, renderTable, cell, failedCell, readIndex, CELL_CHARS } from './forensics-side-by-side.mjs'
import { INDEX_FILE } from './post-trial-forensics.mjs'

const VALUE = '0.485378353934278'

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A jobs root holding one trial per spec, with real grader artifacts. */
function corpus(specs) {
  const root = join(mkdtempSync(join(tmpdir(), 'sbs-')), 'jobs')
  for (const s of specs) {
    const jobDir = join(root, s.job ?? `job-${s.trial}`)
    const dir = join(jobDir, s.trial)
    mkdirSync(dir, { recursive: true })
    // Only SOME jobs carry a job-level result.json, exactly as the real corpus
    // does — the fast path and the per-trial fallback are both exercised.
    if (s.jobStartedAt) write(join(jobDir, 'result.json'), JSON.stringify({ started_at: s.jobStartedAt }))
    write(
      join(dir, 'result.json'),
      JSON.stringify({
        task_name: `terminal-bench/${s.task}`,
        started_at: s.startedAt ?? '2026-09-10T00:00:00Z',
        agent_result: { n_input_tokens: 9, n_output_tokens: s.outTokens ?? 1234, cost_usd: 1 },
        verifier_result: { rewards: { reward: s.reward } },
        exception_info: null,
      }),
    )
    write(join(dir, 'verifier', 'reward.txt'), `${s.reward}\n`)
    write(
      join(dir, 'verifier', 'ctrf.json'),
      JSON.stringify({
        results: {
          tests: s.reward > 0
            ? [{ name: 'test_out.py::test_a', status: 'passed' }]
            : [
                { name: 'test_out.py::test_a', status: 'passed' },
                {
                  name: 'test_out.py::test_alignment',
                  status: 'failed',
                  trace: `def test_alignment():\n        for a, b in zip(x, y):\n>           assert v >= 0.5\nE           AssertionError: too low: ${VALUE}\nE           assert ${VALUE} >= 0.5`,
                },
              ],
        },
      }),
    )
  }
  return root
}

test('the table shows a failing trial WITH its value and hides passes under --failed-only', () => {
  // FAILS if the reader prints only statuses. The entire reason to keep a
  // forensics record is that `reward=0` is not a diagnosis and the printed
  // value is — and a table that mixes passes into a failure sweep buries the
  // rows an operator opened it for.
  const root = corpus([
    { task: 'alpha-task', trial: 'alpha-task__fail', reward: 0 },
    { task: 'alpha-task', trial: 'alpha-task__pass', reward: 1 },
  ])

  const all = collectRows(root, {})
  assert.equal(all.rows.length, 2)
  assert.equal(all.backfilled, 2, 'both job dirs predate the index and must be reconstructed')

  const failed = collectRows(root, { failedOnly: true })
  assert.equal(failed.rows.length, 1)
  assert.equal(failed.rows[0].trial, 'alpha-task__fail')

  const table = renderTable(failed.rows)
  assert.ok(table.includes('alpha-task__fail'), table)
  assert.ok(table.includes(VALUE), `the printed value is missing from the table:\n${table}`)
  assert.ok(!table.includes('alpha-task__pass'), 'a passing trial leaked into --failed-only')
  // One header, one rule, one row.
  assert.equal(table.split('\n').length, 3)
  rmSync(dirname(root), { recursive: true, force: true })
})

test('a job directory that predates the index is reconstructed AND indexed', () => {
  // FAILS if the reader only reads: the index would then be permanently blind
  // to every trial run before it existed, which is most of the corpus, and a
  // "side by side" view missing the history is not one.
  const root = corpus([{ task: 'beta-task', trial: 'beta-task__one', reward: 0 }])
  assert.ok(!existsSync(join(root, INDEX_FILE)))

  const first = collectRows(root, {})
  assert.equal(first.backfilled, 1)
  assert.ok(existsSync(join(root, INDEX_FILE)))
  // A reader must not rewrite the trials it reads.
  assert.ok(!existsSync(join(root, 'job-beta-task__one', 'beta-task__one', 'forensics.json')))

  const second = collectRows(root, {})
  assert.equal(second.backfilled, 0, 'the second pass must come from the index')
  assert.equal(second.rows.length, 1)
  assert.deepEqual(second.rows[0].failed[0].values, [VALUE, '0.5'])

  const index = readIndex(root)
  assert.equal(index.size, 1)
  assert.equal(index.get('beta-task__one').reward, 0)
  rmSync(dirname(root), { recursive: true, force: true })
})

test('--since and --task narrow the walk before anything is reconstructed', () => {
  // FAILS if the pre-filter reads only the JOB-level result.json. Older roots
  // in this corpus have none, so every such trial arrives dateless, survives
  // --since, and is then reconstructed in full — a ~1.4 MB parse per trial —
  // only to be dropped afterwards. `backfilled` is asserted, not just the row
  // count, because the row count looks identical either way.
  const root = corpus([
    { task: 'gamma-task', trial: 'gamma-task__old', reward: 0, startedAt: '2026-09-01T00:00:00Z' },
    { task: 'gamma-task', trial: 'gamma-task__new', reward: 0, startedAt: '2026-09-11T00:00:00Z' },
    { task: 'delta-task', trial: 'delta-task__new', reward: 0, startedAt: '2026-09-11T00:00:00Z', jobStartedAt: '2026-09-11T00:00:00Z' },
  ])
  const since = collectRows(root, { since: '2026-09-09' })
  assert.deepEqual(since.rows.map((r) => r.trial).sort(), ['delta-task__new', 'gamma-task__new'])
  assert.equal(since.backfilled, 2, 'the filtered-out job must never be reconstructed')

  const scoped = collectRows(root, { task: 'delta-task' })
  assert.deepEqual(scoped.rows.map((r) => r.trial), ['delta-task__new'])
  rmSync(dirname(root), { recursive: true, force: true })
})

test('--limit stops an unbounded reconstruction and SAYS it did', () => {
  // The corpus on the bench machine is ~2,000 job directories on a drive this
  // campaign has wedged twice with unbounded scans. A silent cap would be
  // worse than none: the table would look complete and be short.
  const root = corpus([
    { task: 'eps-task', trial: 'eps-task__a', reward: 0 },
    { task: 'eps-task', trial: 'eps-task__b', reward: 0 },
    { task: 'eps-task', trial: 'eps-task__c', reward: 0 },
  ])
  const capped = collectRows(root, { limit: 2 })
  assert.equal(capped.backfilled, 2)
  assert.equal(capped.skipped, 1)
  assert.equal(capped.rows.length, 2)
  rmSync(dirname(root), { recursive: true, force: true })
})

test('a cell cannot break the table or run away', () => {
  // A markdown table is one row per line and one cell per pipe; a trace
  // containing either destroys the whole table's alignment for every row.
  assert.equal(cell('a|b'), 'a\\|b')
  assert.equal(cell('one\ntwo'), 'one two')
  assert.equal(cell(''), '—')
  const long = cell('x'.repeat(500))
  assert.equal(long.length, CELL_CHARS)
  assert.ok(long.endsWith('…'))
})

test('the failed cell keeps the value and drops the pytest file prefix', () => {
  assert.equal(
    failedCell({ failed: [{ name: 'test_out.py::test_alignment', values: ['0.49', '0.5'] }] }),
    'test_alignment=0.49',
  )
  assert.equal(failedCell({ failed: [] }), '—')
})

test('an index line torn by a concurrent append is skipped, not fatal', () => {
  const root = corpus([])
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, INDEX_FILE), '{"trial":"a-task__x","reward":0}\n{"trial":"tor\n')
  const index = readIndex(root)
  assert.equal(index.size, 1)
  assert.ok(index.has('a-task__x'))
  assert.ok(readFileSync(join(root, INDEX_FILE), 'utf8').includes('a-task__x'))
  rmSync(dirname(root), { recursive: true, force: true })
})
