#!/usr/bin/env node
/**
 * Tests for `recount-outcomes.mjs` — the repair path for counters a wrong
 * crediting rule produced.
 *
 * ⛔ WHY EVERY TEST HERE FAILS ON THE PRE-CHANGE TREE: the module did not
 * exist, so the import below throws. Behaviourally there was no repair path at
 * all — only `record_memory_outcome`, which increments, and an increment cannot
 * undo a rule that was wrong for every increment it made.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  recountRows,
  summarise,
  buildRecount,
  collectJobDirs,
  readJob,
  foldOrderedRows,
  taskKey,
} from './recount-outcomes.mjs'

const ID = 26809

/** One job, one trial — the shape every job in this campaign actually has. */
function job(name, { reward, lines, result = {}, trials } = {}) {
  return {
    job: name,
    logText: (lines ?? []).join(String.fromCharCode(10)),
    trials: trials ?? [
      {
        name,
        reward,
        result: {
          task_name: name.split('__')[0],
          agent_result: { n_output_tokens: 9000 },
          started_at: '2026-09-04T10:00:00.000000Z',
          finished_at: '2026-09-04T11:00:00.000000Z',
          agent_execution: {
            started_at: '2026-09-04T10:05:00.000000Z',
            finished_at: '2026-09-04T10:55:00.000000Z',
          },
          ...result,
        },
      },
    ],
  }
}

const at = (iso) => `2026-09-04T${iso}.000Z`

test('only USED memories are counted; shown-only ones are exposed, never counted', () => {
  const jobs = [
    // Opened it, and failed.
    job('sam__a', {
      reward: 0,
      lines: [
        JSON.stringify({ served: [ID, 111], at: at('10:06:00') }),
        JSON.stringify({ read: [ID], at: at('10:07:00') }),
      ],
    }),
    // Only saw it in a search result, and passed. This is the exact shape that
    // paid a MobileSAM notebook for a CIFAR pass.
    job('cifar__b', {
      reward: 1,
      lines: [JSON.stringify({ served: [ID], at: at('10:06:00') })],
    }),
  ]
  const { rows, exposed } = recountRows(jobs, ID)
  assert.deepEqual(rows.map((r) => [r.trial, r.reward, r.how]), [['sam__a', 0, 'read']])
  assert.deepEqual(exposed.map((e) => e.trial), ['cifar__b'])
  const counts = summarise(rows)
  assert.equal(counts.graded_successes, 0)
  assert.equal(counts.graded_failures, 1)
})

test('an authored memory is counted and labelled as authored', () => {
  const jobs = [
    job('sam__a', {
      reward: 0,
      lines: [JSON.stringify({ authored: [ID], at: at('10:20:00') })],
    }),
  ]
  const { rows } = recountRows(jobs, ID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].how, 'authored')
})

test('the counters are POSITIONAL, so order decides the streak and the last verdict', () => {
  // ⛔ THIS IS WHY THE TOOL SORTS AND DOES NOT GROUP. `consecutive_failures` and
  // `last_outcome` cannot be recovered from totals: the same 2 passes and 3
  // failures give a streak of 3 or of 0 depending only on sequence.
  const rows = (rewards) => rewards.map((reward, i) => ({ reward, at: i }))
  assert.deepEqual(summarise(rows([1, 1, 0, 0, 0])), {
    graded_successes: 2,
    graded_failures: 3,
    consecutive_failures: 3,
    last_outcome: 'failure',
    last_outcome_at: 4,
  })
  assert.deepEqual(summarise(rows([0, 0, 0, 1, 1])), {
    graded_successes: 2,
    graded_failures: 3,
    consecutive_failures: 0,
    last_outcome: 'success',
    last_outcome_at: 4,
  })
  // A success in the MIDDLE breaks the streak — the difference between "refuted"
  // and "mixed", and the one the live measurement turned on.
  assert.equal(summarise(rows([0, 0, 1, 0, 0])).consecutive_failures, 2)
  assert.equal(summarise([]).last_outcome, null)
})

test('rows are ordered by when the trial finished, not by the order jobs were read', () => {
  const mk = (name, reward, finished) =>
    job(name, {
      reward,
      lines: [JSON.stringify({ read: [ID], at: at('10:07:00') })],
      result: { finished_at: finished },
    })
  const { rows } = recountRows(
    [
      mk('c__3', 0, '2026-09-09T10:00:00.000000Z'),
      mk('a__1', 1, '2026-09-04T10:00:00.000000Z'),
      mk('b__2', 0, '2026-09-06T10:00:00.000000Z'),
    ],
    ID,
  )
  assert.deepEqual(rows.map((r) => r.trial), ['a__1', 'b__2', 'c__3'])
  assert.equal(summarise(rows).consecutive_failures, 2)
})

test('a trial that never ran is EXCLUDED with a reason, never silently dropped', () => {
  // ⛔ THE REAL SHAPES, all three measured on memory 26809's own history.
  const jobs = [
    // Zero output tokens: the agent never executed.
    job('sam__cut', {
      reward: 0,
      lines: [JSON.stringify({ authored: [ID], at: at('10:20:00') })],
      result: {
        agent_result: { n_output_tokens: 0 },
        exception_info: { exception_type: 'UnknownApiError' },
      },
    }),
    // The container never came up, and a STALE reward file says it passed.
    job('sam__phantom', {
      reward: 1,
      lines: [JSON.stringify({ authored: [ID], at: at('10:20:00') })],
      result: {
        verifier_result: null,
        agent_result: null,
        exception_info: { exception_type: 'RuntimeError' },
      },
    }),
  ]
  const { rows, skipped } = recountRows(jobs, ID)
  assert.equal(rows.length, 0, 'neither trial was a fair test of anything')
  assert.deepEqual(skipped.map((s) => s.trial).sort(), ['sam__cut', 'sam__phantom'])
  for (const s of skipped) assert.match(s.why, /not a fair test/)
})

test('a sole-trial job is attributed even when its calls fall outside its own window', () => {
  // ⛔ MEASURED 2026-09-12: three single-trial jobs produced proxy calls OUTSIDE
  // the window their own result.json records — two whose container died and was
  // retried, one whose traffic belongs to an earlier attempt of the same job.
  // `idsForTrial` answered `attributed: true` with an EMPTY list, so those
  // trials were neither counted nor excluded nor exposed: they vanished. A
  // forensic tool may exclude a trial, but it must never lose one.
  const jobs = [
    job('sam__outside', {
      reward: 0,
      lines: [JSON.stringify({ authored: [ID], at: at('09:00:00') })], // before the window
    }),
  ]
  const { rows } = recountRows(jobs, ID)
  assert.equal(rows.length, 1, 'the sole trial of a job owns every line in that job log')
  assert.equal(rows[0].via, 'sole-trial')

  // A job with SEVERAL trials keeps the window rule, because then the log
  // really does need splitting and a guess would re-create the bug being fixed.
  const shared = {
    job: 'multi',
    logText: JSON.stringify({ authored: [ID], at: at('09:00:00') }),
    trials: ['x__1', 'y__2'].map((name, i) => ({
      name,
      reward: 0,
      result: {
        task_name: name,
        agent_result: { n_output_tokens: 9000 },
        started_at: `2026-09-04T1${i}:00:00.000000Z`,
        finished_at: `2026-09-04T1${i}:30:00.000000Z`,
        agent_execution: {
          started_at: `2026-09-04T1${i}:05:00.000000Z`,
          finished_at: `2026-09-04T1${i}:25:00.000000Z`,
        },
      },
    })),
  }
  assert.equal(recountRows([shared], ID).rows.length, 0, 'no window covers that line')
})

test('the recount call omits last_outcome for a memory that was never graded', () => {
  // "Never graded" and "graded and passed" are different facts, and the schema
  // keeps them apart by ABSENCE. Sending null would collapse them.
  const call = buildRecount(ID, summarise([]), 'recount:test')
  assert.equal(call.name, 'brain_recount_outcome')
  assert.deepEqual(call.arguments, {
    id: ID,
    source: 'recount:test',
    graded_successes: 0,
    graded_failures: 0,
    consecutive_failures: 0,
  })
  const graded = buildRecount(ID, summarise([{ reward: 0, at: 7 }]), 'recount:test')
  assert.equal(graded.arguments.last_outcome, 'failure')
  assert.equal(graded.arguments.last_outcome_at, 7)
})

test('END TO END: the script walks real job dirs and applies through MCP', async () => {
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  // execFile, NOT execFileSync: the stub server lives in this process and a
  // synchronous spawn would block the event loop that has to answer it.
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'recount-outcomes.mjs')

  const root = mkdtempSync(join(tmpdir(), 'tb-recount-'))
  const mkJob = (bucket, name, reward, lines, finished) => {
    const dir = join(root, bucket, name)
    mkdirSync(join(dir, name, 'verifier'), { recursive: true })
    writeFileSync(join(dir, 'terransoul-proxy-calls.jsonl'), lines.join(String.fromCharCode(10)))
    writeFileSync(join(dir, name, 'verifier', 'reward.txt'), String(reward))
    writeFileSync(
      join(dir, name, 'result.json'),
      JSON.stringify({
        task_name: name.split('__')[0],
        agent_result: { n_output_tokens: 9000 },
        started_at: '2026-09-04T10:00:00.000000Z',
        finished_at: finished,
        agent_execution: {
          started_at: '2026-09-04T10:05:00.000000Z',
          finished_at: '2026-09-04T10:55:00.000000Z',
        },
      }),
    )
  }
  mkJob('jobs', 'sam__a', 1, [JSON.stringify({ authored: [ID], at: at('10:20:00') })], '2026-09-04T11:00:00.000000Z')
  mkJob('jobs-extra', 'sam__b', 0, [JSON.stringify({ read: [ID], at: at('10:20:00') })], '2026-09-06T11:00:00.000000Z')
  mkJob('jobs', 'cifar__c', 1, [JSON.stringify({ served: [ID], at: at('10:20:00') })], '2026-09-07T11:00:00.000000Z')

  // Both `jobs*` roots are walked, not just the first.
  assert.equal(collectJobDirs(root).length, 3)
  assert.ok(readJob(collectJobDirs(root)[0]).trials.length >= 1)

  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const params = JSON.parse(body).params
      calls.push(params)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  memory_id: params.arguments.id,
                  outcome: {
                    graded_successes: params.arguments.graded_successes,
                    graded_failures: params.arguments.graded_failures,
                  },
                  previous: { graded_successes: 9, graded_failures: 6 },
                  trail_recorded: true,
                }),
              },
            ],
          },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  let stdout
  try {
    const r = await runScript(
      process.execPath,
      [script, String(ID), '--root', root, '--source', 'recount:test 2026-09-12', '--apply'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TERRANSOUL_MCP_URL: 'http://127.0.0.1:' + port + '/mcp',
          TERRANSOUL_MCP_TOKEN: 'stub-token',
        },
      },
    )
    stdout = r.stdout
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'brain_recount_outcome')
  assert.deepEqual(calls[0].arguments, {
    id: ID,
    source: 'recount:test 2026-09-12',
    graded_successes: 1,
    graded_failures: 1,
    consecutive_failures: 1,
    last_outcome: 'failure',
    last_outcome_at: Date.parse('2026-09-06T11:00:00.000Z'),
  })
  assert.match(stdout, /exposed, not counted: 1/)
  assert.match(stdout, /applied — 1\/1/)
  assert.match(stdout, /was 9\/6/)
})

test('DRY BY DEFAULT: without --apply nothing is sent', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'recount-outcomes.mjs')

  const root = mkdtempSync(join(tmpdir(), 'tb-recount-dry-'))
  const dir = join(root, 'jobs', 'sam__a')
  mkdirSync(join(dir, 'sam__a', 'verifier'), { recursive: true })
  writeFileSync(
    join(dir, 'terransoul-proxy-calls.jsonl'),
    JSON.stringify({ authored: [ID], at: at('10:20:00') }),
  )
  writeFileSync(join(dir, 'sam__a', 'verifier', 'reward.txt'), '0')
  writeFileSync(
    join(dir, 'sam__a', 'result.json'),
    JSON.stringify({
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-04T10:00:00.000000Z',
      finished_at: '2026-09-04T11:00:00.000000Z',
    }),
  )

  // No MCP env at all: a script that tried to send would exit 3.
  const out = await runScript(process.execPath, [script, String(ID), '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, TERRANSOUL_MCP_URL: '', TERRANSOUL_MCP_TOKEN: '' },
  })
  assert.match(out.stdout, /DRY RUN/)
  assert.doesNotMatch(out.stdout, /applied/)
})


test('the --task scope reads the BARE task, not the namespaced task_name', () => {
  // ⛔ THE DEFECT THIS PINS. `result.json` carries
  // `task_name: "terminal-bench/sam-cell-seg"`; the directory, the watch's
  // cohort key (`trialName.split("__")[0]`), the alarm line and the alert row's
  // `task` field all carry the BARE `sam-cell-seg`. A strict-equality scope on
  // the raw field therefore matched NOTHING for the one value an operator would
  // ever type — and, since the early return tests the UNSCOPED row count, an
  // `--apply` run went on to write 0/0/0 over the very refutation this tool
  // exists to record. The key is normalised where the row is BUILT, and the
  // filter normalises both sides so either spelling names the same scope.
  const jobs = [
    job('sam-cell-seg__a', {
      reward: 0,
      result: { task_name: 'terminal-bench/sam-cell-seg' },
      lines: [JSON.stringify({ read: [ID], at: at('10:07:00') })],
    }),
    job('video-processing__b', {
      reward: 1,
      result: { task_name: 'terminal-bench/video-processing' },
      lines: [JSON.stringify({ read: [ID], at: at('10:07:00') })],
    }),
  ]
  const { rows } = recountRows(jobs, ID)
  assert.deepEqual(rows.map((r) => r.task), ['sam-cell-seg', 'video-processing'])
  const scoped = foldOrderedRows(rows, { task: 'sam-cell-seg' })
  assert.equal(scoped.graded_failures, 1)
  assert.equal(scoped.graded_successes, 0)
  assert.equal(scoped.consecutive_failures, 1)
  // Either spelling names the same scope: the normalisation is on BOTH sides.
  assert.deepEqual(foldOrderedRows(rows, { task: 'terminal-bench/sam-cell-seg' }), scoped)
  // And the unscoped answer — the retrospective tool's own question — is still
  // every task the memory was used on.
  assert.equal(foldOrderedRows(rows).graded_successes, 1)
  assert.equal(taskKey('terminal-bench/sam-cell-seg'), 'sam-cell-seg')
  assert.equal(taskKey('sam-cell-seg'), 'sam-cell-seg')
})

test('a --task that scopes to ZERO rows refuses rather than writing a zeroed ledger', async () => {
  // ⛔ THE WRITE PATH, NOT JUST THE ARITHMETIC. A scope that matches nothing
  // folds to a perfectly self-consistent 0 success / 0 failure / streak 0, which
  // the gateway's contradiction guard cannot refuse, so `--apply` would overwrite
  // a real 2/8/8 and remove the serving layer's REFUTED banner. "I found no rows
  // under this scope" is a REFUSAL, never a recount.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'recount-outcomes.mjs')

  const root = mkdtempSync(join(tmpdir(), 'tb-recount-scope-'))
  const dir = join(root, 'jobs', 'j1')
  mkdirSync(join(dir, 'sam-cell-seg__a', 'verifier'), { recursive: true })
  writeFileSync(
    join(dir, 'terransoul-proxy-calls.jsonl'),
    JSON.stringify({ authored: [ID], at: at('10:20:00') }),
  )
  writeFileSync(join(dir, 'sam-cell-seg__a', 'verifier', 'reward.txt'), '0')
  writeFileSync(
    join(dir, 'sam-cell-seg__a', 'result.json'),
    JSON.stringify({
      task_name: 'terminal-bench/sam-cell-seg',
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-04T10:00:00.000000Z',
      finished_at: '2026-09-04T11:00:00.000000Z',
    }),
  )
  const env = { ...process.env, TERRANSOUL_MCP_URL: '', TERRANSOUL_MCP_TOKEN: '' }

  // The value an operator reads off the alarm line works.
  const ok = await runScript(process.execPath, [script, String(ID), '--root', root, '--task', 'sam-cell-seg'], { encoding: 'utf8', env })
  assert.match(ok.stdout, /"graded_failures":1/)

  // A scope nothing matches is a refusal with a non-zero exit, and it never
  // prints a call it would make.
  let failed = null
  try {
    await runScript(process.execPath, [script, String(ID), '--root', root, '--task', 'no-such-task'], { encoding: 'utf8', env })
  } catch (e) {
    failed = e
  }
  assert.ok(failed, '--task matching nothing must exit non-zero')
  assert.equal(failed.code, 6)
  assert.match(`${failed.stdout}${failed.stderr}`, /matched no USED rows/)
  assert.doesNotMatch(`${failed.stdout}`, /would set/)
})

// ── OUTCOME-VISIBLE-6 — a READ WHILE REFUTED is exposure, not use ────────────
//
// ⛔ WHY THESE FAIL ON THE PRE-CHANGE TREE. `summarise` counted every row it was
// handed, and `partitionExposureWhileRefuted` / `exposureWhileRefuted` /
// `seededRefutationThreshold` / `EXPOSED_WHILE_REFUTED` did not exist, so the
// import below throws. Behaviourally the fold read the fixture as
// 2 successes / 2 failures / consecutive 0 — the refuted-time pass CLEARED the
// streak, and a cleared streak is exactly what makes `MemoryOutcome::is_refuted`
// answer no, lifting the banner and the quarantine.
//
// MEASURED 2026-09-13 on 26809: 10 consecutive graded failures, quarantined, then
// `redo09130830` read the quarantined view, authored 27007 and passed 9/9. The
// credit loop logged `reward=1 -> success for 2 used memories: 26809, 27007` and
// the body was served in full again. The next reader builds from it, loses twice,
// and it is re-quarantined: a loop, not a repair.
import {
  partitionExposureWhileRefuted,
  exposureWhileRefuted,
  seededRefutationThreshold,
  EXPOSED_WHILE_REFUTED,
} from './recount-outcomes.mjs'
import { readFileSync as readSeed } from 'node:fs'

test('a graded PASS on a read taken while the entry was already refuted does not count', () => {
  // authored pass, read fail, read fail (streak 2 = refuted), read PASS.
  const rows = [
    { trial: 'sam__1', reward: 1, at: 1, how: 'authored' },
    { trial: 'sam__2', reward: 0, at: 2, how: 'read' },
    { trial: 'sam__3', reward: 0, at: 3, how: 'read' },
    { trial: 'sam__4', reward: 1, at: 4, how: 'read' },
  ]
  assert.deepEqual(foldOrderedRows(rows, { threshold: 2 }), {
    graded_successes: 1,
    graded_failures: 2,
    consecutive_failures: 2,
    last_outcome: 'failure',
    last_outcome_at: 3,
  })
  // And the drop is NAMED, not merely subtracted: a narrowed count that cannot
  // say what it narrowed is the same defect class as the over-count it replaces.
  assert.deepEqual(
    exposureWhileRefuted(rows, { threshold: 2 }).map((r) => r.trial),
    ['sam__4'],
  )
  // Every row lands in exactly one bucket, and the kept ones are the counted ones.
  const split = partitionExposureWhileRefuted(rows, 2)
  assert.deepEqual(split.kept.map((r) => r.trial), ['sam__1', 'sam__2', 'sam__3'])
  assert.deepEqual(split.exposed.map((r) => r.trial), ['sam__4'])
})

test('an AUTHORED pass on a refuted entry DOES count — that is what releases it', () => {
  // ⛔ THE OTHER HALF, AND WITHOUT IT THE RULE WOULD BE A DELETION. An author who
  // appends to a refuted entry is still crediting it, so a refuted entry stays
  // releasable — by authorship, or by an explicit recount. Only the reader of the
  // quarantined index is powerless, which is the point: it never saw the body.
  const rows = [
    { trial: 'sam__1', reward: 0, at: 1, how: 'read' },
    { trial: 'sam__2', reward: 0, at: 2, how: 'read' },
    { trial: 'sam__3', reward: 1, at: 3, how: 'authored' },
  ]
  const folded = foldOrderedRows(rows, { threshold: 2 })
  assert.equal(folded.graded_successes, 1)
  assert.equal(folded.consecutive_failures, 0, 'an authored pass clears the streak')
  assert.equal(folded.last_outcome, 'success')
  assert.deepEqual(exposureWhileRefuted(rows, { threshold: 2 }), [])
})

test('an exposure row neither counts nor ADVANCES the streak', () => {
  // A refuted-time read that LOST must not be debited either: the reader was
  // served the verdict and a graded index, so its grade is evidence about the
  // construction in neither direction. Two of them in a row leave the streak
  // exactly where the last real failure left it.
  const rows = [
    { trial: 'a', reward: 0, at: 1, how: 'read' },
    { trial: 'b', reward: 0, at: 2, how: 'read' },
    { trial: 'c', reward: 0, at: 3, how: 'read' },
    { trial: 'd', reward: 1, at: 4, how: 'read' },
  ]
  const folded = foldOrderedRows(rows, { threshold: 2 })
  assert.equal(folded.graded_failures, 2)
  assert.equal(folded.consecutive_failures, 2)
  assert.equal(folded.last_outcome_at, 2, 'the last COUNTED grading, not the last row seen')
})

test('a row with no `how` is still counted — unknown provenance is not evidence of a read', () => {
  // The two directions are not symmetric: a miscounted row shows up in the
  // printed table, a silently deleted one does not. Only callers that can tell
  // authorship apart set `how`.
  const rows = [
    { reward: 0, at: 1 },
    { reward: 0, at: 2 },
    { reward: 1, at: 3 },
  ]
  assert.equal(foldOrderedRows(rows, { threshold: 2 }).graded_successes, 1)
  assert.equal(foldOrderedRows(rows, { threshold: 2 }).consecutive_failures, 0)
})

test('the exposure threshold is READ FROM the seeded refutation rule, not written here', () => {
  // ⛔ NOT A LITERAL IN THE FOLD. "Exposure" means "the serving layer gave this
  // reader the verdict and the index instead of the body", which is a property of
  // the SERVING layer — whose threshold is a seeded `memories` row, not a number
  // in this directory. A constant here would let the fold drop rows the product
  // still serves in full, or count rows it quarantines: the same
  // label-contradicts-the-bytes defect the whole OUTCOME-VISIBLE line closes.
  const seed = join(import.meta.dirname, '..', '..', 'mcp-data', 'shared', 'seed-config.sql')
  const m = readSeed(seed, 'utf8').match(
    /outcome\.refuted\.min_consecutive_failures\s*\|\s*(-?\d+)\s*\|/,
  )
  assert.ok(m, `outcome.refuted.min_consecutive_failures is not seeded in ${seed}`)
  assert.equal(seededRefutationThreshold(), Number(m[1]))
  // A non-positive seeded value means the annotation is OFF — the product reads
  // it that way before the predicate ever runs, so nothing is exposure.
  const rows = [
    { trial: 'a', reward: 0, at: 1, how: 'read' },
    { trial: 'b', reward: 0, at: 2, how: 'read' },
    { trial: 'c', reward: 1, at: 3, how: 'read' },
  ]
  assert.equal(foldOrderedRows(rows, { threshold: 0 }).graded_successes, 1)
  assert.deepEqual(exposureWhileRefuted(rows, { threshold: 0 }), [])
  assert.equal(EXPOSED_WHILE_REFUTED, 'exposed-while-refuted')
})

test('END TO END: recountRows plus the fold drop the refuted-time read', () => {
  // The same shape assembled from real job artefacts rather than hand-built rows,
  // so `how` comes from the proxy log and not from the test.
  const head = [
    job('sam__1', {
      reward: 1,
      lines: [JSON.stringify({ authored: [ID], at: at('10:20:00') })],
      result: { finished_at: '2026-09-04T10:00:00.000000Z' },
    }),
    job('sam__2', {
      reward: 0,
      lines: [JSON.stringify({ read: [ID], at: at('10:07:00') })],
      result: { finished_at: '2026-09-05T10:00:00.000000Z' },
    }),
    job('sam__3', {
      reward: 0,
      lines: [JSON.stringify({ read: [ID], at: at('10:07:00') })],
      result: { finished_at: '2026-09-06T10:00:00.000000Z' },
    }),
  ]
  // The redo09130830 shape: opens the quarantined view and PASSES.
  const current = job('sam__4', {
    reward: 1,
    lines: [JSON.stringify({ read_refuted: [ID], refuted_at_read: true, at: at('10:07:00') })],
    result: { finished_at: '2026-09-07T10:00:00.000000Z' },
  })
  const { rows, exposed } = recountRows([...head, current], ID)
  // ⛔ THE EXPOSURE ROW IS CARRIED, NOT DROPPED AT THE KEY. `read_refuted` is
  // outside USED_KEYS, so the fourth trial yields no used id — but omitting it
  // would make the trial vanish from a forensic tool, and it is also NOT the
  // "shown, never opened" bucket: this agent DID open the entry. So it is a row
  // labelled `exposed-while-refuted` that the fold then refuses.
  assert.deepEqual(
    rows.map((r) => [r.trial, r.how]),
    [
      ['sam__1', 'authored'],
      ['sam__2', 'read'],
      ['sam__3', 'read'],
      ['sam__4', EXPOSED_WHILE_REFUTED],
    ],
  )
  assert.ok(
    !exposed.some((e) => e.trial === 'sam__4'),
    'a trial that OPENED the entry is not in the shown-but-never-opened bucket',
  )
  assert.equal(summarise(rows, 2).graded_successes, 1)
  assert.equal(summarise(rows, 2).consecutive_failures, 2)
  // ⛔ UNCONDITIONAL, streak or no streak: the proxy row observed the banner on
  // the served bytes, so even a fold whose artefacts reconstruct a shorter streak
  // must not re-credit it. Threshold 99 puts the derived rule out of reach.
  assert.equal(summarise(rows, 99).graded_successes, 1)

  // And with the LEGACY spelling (a plain `read` row, as every archived job has),
  // the FOLD is what drops it.
  const legacy = job('sam__4', {
    reward: 1,
    lines: [JSON.stringify({ read: [ID], at: at('10:07:00') })],
    result: { finished_at: '2026-09-07T10:00:00.000000Z' },
  })
  const legacyRows = recountRows([...head, legacy], ID).rows
  assert.equal(legacyRows.length, 4, 'the legacy row IS a used row; the fold is what excludes it')
  assert.equal(summarise(legacyRows, 2).graded_successes, 1)
  assert.equal(summarise(legacyRows, 2).consecutive_failures, 2)
  assert.deepEqual(
    exposureWhileRefuted(legacyRows, { threshold: 2 }).map((r) => r.trial),
    ['sam__4'],
  )
})
