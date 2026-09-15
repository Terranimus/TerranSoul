/**
 * Tests for `backfill-block-stamps.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so every
 * import below throws. Each test ALSO pins a behaviour a plausible wrong
 * implementation would violate, and names it — so none of them stays green if
 * the rule is loosened later:
 *
 *   * window-only attribution (stamp whatever trial was running) fails the
 *     "did not WRITE the id" and "concurrent" tests;
 *   * re-sending `credit-trial-outcome.mjs`'s TRIAL-wide window fails the
 *     unique-author test, because that window stamps every block in the span,
 *     including blocks another trial wrote;
 *   * stamping on reward alone (ignoring `runWasSound`) fails the ungraded test;
 *   * writing before probing, or writing in a dry run, fails the transport tests.
 *
 * THE MEASUREMENT IT EXISTS FOR (2026-09-15): memory 26661 carries an unstamped
 * `[Update 1788859279859 · agent-session]` block written 4.2 minutes into a
 * trial that scored 1, beside a newer block stamped `GRADED failure`. A later
 * trial reproduced an earlier failing answer to 9 significant digits from a row
 * that mixed passing and failing advice with no per-block grade.
 *
 * Hermetic: a temp jobs root, a temp SQLite store and an injected transport. No
 * brain, no network, no real job dirs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { run, updateHeaders, REASONS } from './backfill-block-stamps.mjs'

const SEP = '·'
const iso = (ms) => new Date(ms).toISOString()
const T0 = Date.parse('2026-09-08T09:17:05.000Z')
const MIN = 60_000
const quiet = { log() {}, error() {} }

/** A jobs root + store, built from a compact description. */
function fixture({ trials, memories }) {
  const root = mkdtempSync(join(tmpdir(), 'backfill-stamps-'))
  const jobsDir = join(root, 'jobs')
  const dataDir = join(root, 'data')
  mkdirSync(jobsDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const index = []
  const logs = new Map()
  for (const t of trials) {
    const dir = join(jobsDir, t.job, t.trial)
    mkdirSync(join(dir, 'verifier'), { recursive: true })
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify({
        started_at: iso(t.start),
        finished_at: iso(t.end),
        agent_execution: { started_at: iso(t.start + 1000), finished_at: iso(t.end - 1000) },
        verifier_result: t.reward === null ? null : { rewards: { reward: t.reward } },
        agent_result: { n_output_tokens: t.outputTokens ?? 1000 },
        exception_info: null,
      }),
    )
    if (t.reward !== null) writeFileSync(join(dir, 'verifier', 'reward.txt'), `${t.reward}\n`)
    const lines = logs.get(t.job) ?? []
    for (const l of t.log ?? []) lines.push(JSON.stringify(l))
    logs.set(t.job, lines)
    index.push({ schema: 1, task: 'task-x', trial: t.trial, job: t.job, reward: t.reward, started_at: iso(t.start) })
  }
  for (const [job, lines] of logs) {
    writeFileSync(join(jobsDir, job, 'terransoul-proxy-calls.jsonl'), lines.join('\n') + '\n')
  }
  writeFileSync(join(jobsDir, 'forensics-index.jsonl'), index.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const db = new DatabaseSync(join(dataDir, 'memory.db'))
  db.exec(
    'CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT \'\', ' +
      'category TEXT, created_at INTEGER NOT NULL)',
  )
  const insert = db.prepare('INSERT INTO memories (id, content, category, created_at) VALUES (?, ?, ?, ?)')
  for (const m of memories) insert.run(m.id, m.content, 'self-improve-attempt', m.createdAt ?? T0 - 10 * MIN)
  db.close()
  return { jobsDir, dataDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** The proxy's own line shapes for one accepted write that returned `id`. */
const wrote = (at, id, tool = 'brain_append') => [
  { tool, allowed: true, at: iso(at - 20) },
  { name: tool, verdict: 'accepted', at: iso(at) },
  { authored: [id], at: iso(at) },
]
const header = (ms, extra = '') => `[Update ${ms} ${SEP} agent-session${extra}]`
const notebook = (...blocks) => ['HEAD: a lesson.', ...blocks.map((h) => `\n${h}\nbody`)].join('\n')

/** A transport that records every call and answers like the brain would. */
function recorder(entries = new Map()) {
  const calls = []
  const callTool = async (params) => {
    calls.push(params)
    if (params.name === 'brain_get_entry') {
      const e = entries.get(params.arguments.id)
      if (!e) return { res: { ok: true, status: 200 }, text: JSON.stringify({ result: { isError: true } }) }
      return { res: { ok: true, status: 200 }, text: JSON.stringify({ result: { content: [{ text: JSON.stringify(e) }] } }) }
    }
    const inner = { memory_id: params.arguments.id, blocks_stamped: 1, head_stamped: false, changed: true }
    return { res: { ok: true, status: 200 }, text: JSON.stringify({ result: { content: [{ text: JSON.stringify(inner) }] } }) }
  }
  return { calls, callTool }
}

test('a unique author inside its window is stamped with a window narrowed to THAT block', async () => {
  // FAILS IF the call re-used the trial-wide window credit-trial-outcome sends:
  // the server stamps EVERY `[Update]` block in the window, so a trial-wide call
  // would also grade a block another trial wrote in the same span.
  const ms = T0 + 4 * MIN
  const f = fixture({
    trials: [{ job: 'j1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: 1, log: wrote(ms + 13, 26661) }],
    memories: [{ id: 26661, content: notebook(header(ms), header(ms + 9 * MIN)) }],
  })
  try {
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, log: quiet })
    const row = out.rows.find((r) => r.ms === ms)
    assert.equal(row.author, 'task-x__A')
    assert.equal(row.verdict, 'success')
    assert.deepEqual(out.calls, [
      {
        name: 'brain_stamp_outcome',
        arguments: { id: 26661, from_ms: ms, to_ms: ms, outcome: 'success', graded_at: T0 + 6 * MIN },
      },
    ])
    // The block OUTSIDE every window is reported, never guessed at.
    assert.equal(out.rows.find((r) => r.ms === ms + 9 * MIN).reason, REASONS.NO_WINDOW)
  } finally {
    f.cleanup()
  }
})

test('a block inside a window whose trial did NOT write that id is not stamped', async () => {
  // FAILS IF attribution were by time alone. The trial read 26661 and wrote a
  // DIFFERENT memory; being in flight when the block landed is not authorship.
  const ms = T0 + 3 * MIN
  const f = fixture({
    trials: [
      {
        job: 'j1',
        trial: 'task-x__A',
        start: T0,
        end: T0 + 6 * MIN,
        reward: 0,
        log: [{ served: [26661], at: iso(T0 + MIN) }, { read: [26661], at: iso(T0 + MIN) }, ...wrote(ms, 999)],
      },
    ],
    memories: [{ id: 26661, content: notebook(header(ms)) }],
  })
  try {
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, log: quiet })
    assert.equal(out.rows.length, 1)
    assert.equal(out.rows[0].reason, REASONS.NO_WRITER)
    assert.deepEqual(out.calls, [])
  } finally {
    f.cleanup()
  }
})

test('two concurrent trials that both wrote the id leave the block UNATTRIBUTABLE', async () => {
  // FAILS IF the tool picked one (first, nearest, or latest). Two workers with
  // their own proxy logs, overlapping windows, both appending to 26661.
  const ms = T0 + 3 * MIN
  const f = fixture({
    trials: [
      { job: 'w1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: 1, log: wrote(ms + 10, 26661) },
      { job: 'w2', trial: 'task-y__B', start: T0 + MIN, end: T0 + 7 * MIN, reward: 0, log: wrote(T0 + 5 * MIN, 26661) },
    ],
    memories: [{ id: 26661, content: notebook(header(ms), header(T0 + 5 * MIN)) }],
  })
  try {
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, log: quiet })
    assert.equal(out.rows.length, 2)
    for (const r of out.rows) {
      assert.equal(r.reason, REASONS.CONCURRENT_AUTHORS)
      assert.deepEqual(r.qualifiers, ['task-x__A', 'task-y__B'])
    }
    assert.deepEqual(out.calls, [])
  } finally {
    f.cleanup()
  }
})

test('a concurrent trial whose accepted write recorded no id also blocks attribution', async () => {
  // FAILS IF uniqueness were decided only among trials whose writes are
  // visible. Trial B's proxy accepted a write and logged no `authored` id, so B
  // may have written this block; A being the only VISIBLE author is not unique.
  const ms = T0 + 3 * MIN
  const f = fixture({
    trials: [
      { job: 'w1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: 1, log: wrote(ms + 10, 26661) },
      {
        job: 'w2',
        trial: 'task-y__B',
        start: T0 + MIN,
        end: T0 + 7 * MIN,
        reward: 1,
        log: [{ name: 'brain_append', verdict: 'accepted', at: iso(ms) }],
      },
    ],
    memories: [{ id: 26661, content: notebook(header(ms)) }],
  })
  try {
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, log: quiet })
    assert.equal(out.rows[0].reason, REASONS.CONCURRENT_UNOBSERVABLE)
    assert.deepEqual(out.calls, [])
  } finally {
    f.cleanup()
  }
})

test('an already-stamped header is never planned again, and the header rule matches the server', async () => {
  // FAILS IF "stamped" were read as the exact verdict token (the server's own
  // idempotence) rather than ANY grade: a block graded failure by the forward
  // path would gain a second, backfilled token.
  assert.deepEqual(
    updateHeaders(`x\n[Update 5 ${SEP} agent-session ${SEP} GRADED failure 2026-09-14]\r\n[Update 6 ${SEP} import]\n[Update nope]`),
    [
      { ms: 5, source: 'agent-session', graded: true },
      { ms: 6, source: 'import', graded: false },
    ],
  )
  const ms = T0 + 4 * MIN
  const f = fixture({
    trials: [{ job: 'j1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: 1, log: wrote(ms, 26661) }],
    memories: [{ id: 26661, content: notebook(header(ms, ` ${SEP} GRADED failure 2026-09-14`)) }],
  })
  try {
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, log: quiet })
    assert.equal(out.rows.length, 0)
    assert.deepEqual(out.calls, [])
    assert.equal(out.summary.alreadyStamped, 1)
  } finally {
    f.cleanup()
  }
})

test('an ungraded author, or one whose run was not a fair test, is never stamped', async () => {
  // FAILS IF the verdict were taken from anything but the rule credit-trial-outcome
  // stamps with: no reward.txt means no grade, and a zero-token run is not a failure.
  const ms1 = T0 + 2 * MIN
  const ms2 = T0 + 12 * MIN
  const f = fixture({
    trials: [
      { job: 'j1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: null, log: wrote(ms1, 26661) },
      {
        job: 'j1',
        trial: 'task-x__B',
        start: T0 + 10 * MIN,
        end: T0 + 16 * MIN,
        reward: 0,
        outputTokens: 0,
        log: wrote(ms2, 26661),
      },
    ],
    memories: [{ id: 26661, content: notebook(header(ms1), header(ms2)) }],
  })
  try {
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, log: quiet })
    assert.equal(out.rows.find((r) => r.ms === ms1).reason, REASONS.AUTHOR_UNGRADED)
    assert.equal(out.rows.find((r) => r.ms === ms2).reason, REASONS.AUTHOR_NOT_SOUND)
    assert.deepEqual(out.calls, [])
  } finally {
    f.cleanup()
  }
})

test('a dry run makes NO calls, even with a transport injected', async () => {
  // FAILS IF the plan were sent (or the store probed) without --apply.
  const ms = T0 + 4 * MIN
  const f = fixture({
    trials: [{ job: 'j1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: 0, log: wrote(ms, 26661) }],
    memories: [{ id: 26661, content: notebook(header(ms)) }],
  })
  try {
    const t = recorder()
    const out = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, callTool: t.callTool, log: quiet })
    assert.equal(out.calls.length, 1, 'the plan still holds the call it would make')
    assert.equal(t.calls.length, 0, 'but nothing was sent')
    assert.equal(out.applied, null)
  } finally {
    f.cleanup()
  }
})

test('--apply probes the target store first, refuses a store without the blocks, and only ever stamps', async () => {
  // FAILS IF a write went out before the probe, if a store that lacks the block
  // were written anyway, or if anything but brain_get_entry / brain_stamp_outcome
  // were called (brain_observe_outcome would move the ranking counters).
  const ms = T0 + 4 * MIN
  const f = fixture({
    trials: [{ job: 'j1', trial: 'task-x__A', start: T0, end: T0 + 6 * MIN, reward: 0, log: wrote(ms, 26661) }],
    memories: [{ id: 26661, content: notebook(header(ms)) }],
  })
  try {
    // A store whose 26661 is an unrelated row that merely shares the number.
    const wrong = recorder(new Map([[26661, { id: 26661, content: notebook(header(ms + 1)) }]]))
    const refused = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, apply: true, callTool: wrong.callTool, log: quiet })
    assert.equal(refused.applied.refused, true)
    assert.deepEqual(wrong.calls.map((c) => c.name), ['brain_get_entry'])

    const right = recorder(new Map([[26661, { id: 26661, content: notebook(header(ms)) }]]))
    const done = await run({ dataDir: f.dataDir, jobsDir: f.jobsDir, apply: true, callTool: right.callTool, log: quiet })
    assert.equal(done.applied.refused, false)
    assert.equal(done.applied.blocksStamped, 1)
    assert.deepEqual(right.calls.map((c) => c.name), ['brain_get_entry', 'brain_stamp_outcome'])
    assert.equal(right.calls[1].arguments.outcome, 'failure')
  } finally {
    f.cleanup()
  }
})
