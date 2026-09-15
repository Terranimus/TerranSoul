#!/usr/bin/env node
/**
 * Tests for `post-trial-forensics.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so the
 * import throws and every case in this file errors. Beyond that, each case pins
 * a decision that has ALREADY been made wrongly somewhere in this campaign, and
 * the comment on each one says which.
 *
 * Hermetic: every case builds its own temp corpus and points the baseline
 * search at it, so nothing here reads the real 2,000-job corpus or the network.
 * The single exception is the last test, which runs against a real trial IF it
 * is present on this machine and skips cleanly when it is not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  forensicsForTrial,
  describeCheck,
  memoryFor,
  blocksFrom,
  claimsFrom,
  assignedConstants,
  numericLiterals,
  redactTaskNames,
  diffstat,
  BLOCK_HEAD_CHARS,
  MAX_CHECK_VALUES,
  MAX_CLAIM_NUMBERS,
  INDEX_FILE,
} from './post-trial-forensics.mjs'
import { STOP_FEEDBACK_PREFIX, JUDGE_BLOCK_PREFIX } from '../../packages/terransoul-cli/src/stop-hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * A 17-significant-digit decimal that a `Number()` round-trip DESTROYS.
 * `Number('0.10000000000000000555').toString() === '0.1'`, so any reader that
 * parses before it prints loses 19 of the 20 characters the grader wrote.
 */
const LOSSY = '0.10000000000000000555'

/** A 16-digit value of the shape the real corpus prints. */
const SIXTEEN = '0.4853783539342781'

function tmp(prefix = 'forensics-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * A trial directory with whichever artifacts a case needs.
 * `root` is a jobs ROOT (`…/jobs`); the trial lands at `root/<job>/<trial>`.
 */
function makeTrial({
  root,
  job = 'job1',
  task = 'demo-task',
  trial = `${task}__aaa`,
  reward = '0',
  result = {},
  ctrf = null,
  trajectory = null,
  session = null,
  proxy = null,
  stdout = '',
}) {
  const dir = join(root, job, trial)
  mkdirSync(dir, { recursive: true })
  write(
    join(dir, 'result.json'),
    JSON.stringify({
      task_name: `terminal-bench/${task}`,
      trial_name: trial,
      started_at: '2026-09-10T00:00:00Z',
      finished_at: '2026-09-10T01:00:00Z',
      agent_result: { n_input_tokens: 10, n_output_tokens: 100, cost_usd: 1 },
      verifier_result: { rewards: { reward: Number(reward) } },
      exception_info: null,
      ...result,
    }),
  )
  if (reward !== null) write(join(dir, 'verifier', 'reward.txt'), `${reward}\n`)
  if (ctrf) write(join(dir, 'verifier', 'ctrf.json'), JSON.stringify({ results: { tests: ctrf } }))
  if (stdout) write(join(dir, 'verifier', 'test-stdout.txt'), stdout)
  if (trajectory) write(join(dir, 'agent', 'trajectory.json'), JSON.stringify(trajectory))
  if (session) {
    write(
      join(dir, 'agent', 'sessions', 'projects', '-app', 'sess.jsonl'),
      session.map((e) => JSON.stringify(e)).join('\n'),
    )
  }
  if (proxy !== null) write(join(root, job, 'terransoul-proxy-calls.jsonl'), proxy ?? '')
  return dir
}

/** A trajectory step whose tool result carries one metadata write block. */
function writeStep(stepId, path, content) {
  return { step_id: stepId, result: `ok\n[metadata] ${JSON.stringify({ filePath: path, content })}` }
}

function hashTree(dir) {
  const h = createHash('sha256')
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else h.update(`${p}\u0000`).update(readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

// ── (a) precision ───────────────────────────────────────────────────────────
test('an assertion value survives EXACTLY as the grader printed it', () => {
  // FAILS the moment any reader parses before it prints. A `Number()` round
  // trip renders LOSSY as '0.1' and `toFixed(4)` renders the real corpus value
  // 0.485378353934278 as '0.4854' — and the failure this tool was built on
  // turned on a gap of 0.0146 against a floor, which both of those hide.
  // `reference_reported_value_that_is_really_a_choice`.
  const c = describeCheck({
    name: 'test_outputs.py::test_alignment',
    status: 'failed',
    trace: [
      'def test_alignment():',
      '        out = measure()',
      `>           assert out >= 0.5, f"too low: {out}"`,
      `E           AssertionError: too low: ${SIXTEEN}`,
      `E           assert ${SIXTEEN} >= 0.5`,
    ].join('\n'),
  })
  assert.ok(c.values.includes(SIXTEEN), `values were ${JSON.stringify(c.values)}`)
  assert.equal(c.values[0], SIXTEEN)
  assert.equal(c.assertion, `assert ${SIXTEEN} >= 0.5`)
  // And the lossy case, where a round trip is not merely imprecise but visible:
  assert.deepEqual(numericLiterals(`AssertionError: got ${LOSSY}`), [LOSSY])
  assert.notEqual(String(Number(LOSSY)), LOSSY, 'the fixture must actually be lossy, or this proves nothing')
})

// ── (b) ordinal semantics ───────────────────────────────────────────────────
test("a value printed from inside a loop is labelled 'first-failing', not aggregate", () => {
  // FAILS if the field is dropped or defaulted. A redo cycle was already spent
  // reading a first-failing row as if it were a mean: the two call for opposite
  // fixes (one bad row vs. a systematically low method), and a record that
  // prints the number without its ordinality invites the wrong one.
  const looped = describeCheck({
    name: 'x',
    trace: [
      'def test_x():',
      '        for (_, a), (_, b) in zip(out.iterrows(), ref.iterrows()):',
      '            score = iou(a, b)',
      '>           assert score >= 0.5',
      'E           assert 0.49 >= 0.5',
    ].join('\n'),
  })
  assert.equal(looped.ordinal_semantics, 'first-failing')

  const flat = describeCheck({
    name: 'y',
    trace: ['def test_y():', '        mean = total / n', '>       assert mean >= 0.5', 'E       assert 0.49 >= 0.5'].join('\n'),
  })
  assert.equal(flat.ordinal_semantics, 'aggregate')

  assert.equal(describeCheck({ name: 'z', trace: '' }).ordinal_semantics, 'unknown')
})

// ── (c) baseline ────────────────────────────────────────────────────────────
test('the baseline is the most recent SOUND pass, not the most recent trial', () => {
  // FAILS for two different wrong baselines, both of which are easy to write:
  //   * "most recent trial" picks the newer FAILURE, and diffing a failure
  //     against a failure reports "no change" about two runs that both lost;
  //   * "most recent reward>0" picks the PHANTOM pass — a stale reward.txt over
  //     a container that never started, which this corpus really contains
  //     (result.json holds agent_result:null plus an exception).
  const box = tmp()
  const jobs = join(box, 'jobs')
  const task = 'demo-task'

  makeTrial({
    root: jobs,
    job: 'old-pass',
    task,
    trial: `${task}__oldpass`,
    reward: '1',
    result: { started_at: '2026-09-01T00:00:00Z' },
    trajectory: { steps: [writeStep(1, '/app/solve.py', 'alpha\nbeta\n')] },
  })
  makeTrial({
    root: jobs,
    job: 'newer-fail',
    task,
    trial: `${task}__newerfail`,
    reward: '0',
    result: { started_at: '2026-09-05T00:00:00Z' },
  })
  makeTrial({
    root: join(box, 'jobs-archive'),
    job: 'phantom',
    task,
    trial: `${task}__phantom`,
    reward: '1',
    result: {
      started_at: '2026-09-09T00:00:00Z',
      agent_result: null,
      verifier_result: null,
      exception_info: { exception_type: 'RuntimeError' },
    },
  })
  const current = makeTrial({
    root: jobs,
    job: 'current',
    task,
    trial: `${task}__current`,
    reward: '0',
    result: { started_at: '2026-09-10T00:00:00Z' },
    trajectory: { steps: [writeStep(1, '/app/solve.py', 'alpha\ngamma\ndelta\n')] },
  })

  const r = forensicsForTrial(current, { write: false, index: false })
  assert.equal(r.baseline?.trial, `${task}__oldpass`)
  assert.equal(r.baseline.reward, 1)
  // 'beta' left, 'gamma'+'delta' arrived, in one file.
  assert.deepEqual(r.baseline.diffstat, { added: 2, removed: 1, changed_files: 1 })
  rmSync(box, { recursive: true, force: true })
})

test('a reward-1 trial that ended in AgentTimeoutError is never the baseline — the campaign scores it 0', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE. `findBaseline` took any trial whose
  // reward.txt was > 0 and that `runWasSound` called a fair run — and
  // `runWasSound` returns true on `reward > 0` whatever the exception says.
  // The campaign's own rule, `outcomeOf` in trial-outcome.mjs, counts an
  // errored trial as 0. So the "passing baseline" could be a trial the
  // campaign scores as a FAILURE, and `regressed_vs_baseline` then accused a
  // failure of regressing against another failure. Measured: the baseline for
  // a real task in this campaign had reward 1 and AgentTimeoutError. Pre-change
  // this picks `__timeoutpass` (newer than the clean pass) in the first half,
  // and returns it instead of null in the second.
  const box = tmp()
  const jobs = join(box, 'jobs')
  const task = 'demo-task'
  const timedOut = {
    exception_type: 'AgentTimeoutError',
    exception_message: 'Agent execution timed out after 3600.0 seconds',
  }

  makeTrial({
    root: jobs,
    job: 'clean-pass',
    task,
    trial: `${task}__cleanpass`,
    reward: '1',
    result: { started_at: '2026-09-01T00:00:00Z' },
  })
  makeTrial({
    root: jobs,
    job: 'timeout-pass',
    task,
    trial: `${task}__timeoutpass`,
    reward: '1',
    result: { started_at: '2026-09-08T00:00:00Z', exception_info: timedOut },
  })
  const current = makeTrial({
    root: jobs,
    job: 'current',
    task,
    trial: `${task}__current`,
    reward: '0',
    result: { started_at: '2026-09-10T00:00:00Z' },
  })

  const r = forensicsForTrial(current, { write: false, index: false })
  assert.equal(r.baseline?.trial, `${task}__cleanpass`, 'the newer timed-out "pass" is a campaign failure')

  // With ONLY the timed-out trial on disk there is no passing baseline at all,
  // so nothing may be reported as a regression against one.
  rmSync(join(jobs, 'clean-pass'), { recursive: true, force: true })
  const alone = forensicsForTrial(current, { write: false, index: false })
  assert.equal(alone.baseline, null)
  assert.ok(!alone.suspects.some((s) => s.rule === 'regressed_vs_baseline'))
  rmSync(box, { recursive: true, force: true })
})

test('a diffstat counts real lines, not the trailing newline', () => {
  // FAILS if `split('\n')` is counted as-is: 'z\n' would read as two lines,
  // and the phantom empty one cancels against the other file's phantom empty
  // one — so the number is right by accident on files that both end in a
  // newline and wrong on every file that does not.
  assert.deepEqual(
    diffstat([{ path: '/a', content: 'x\ny\n' }], [{ path: '/b', content: 'z\n' }]),
    { added: 1, removed: 2, changed_files: 2 },
  )
  assert.deepEqual(
    diffstat([{ path: '/a', content: '' }], [{ path: '/a', content: 'only\n' }]),
    { added: 1, removed: 0, changed_files: 1 },
  )
})

// ── (d) refuted reads ───────────────────────────────────────────────────────
test('a memory served under a refutation banner is NEVER credited', () => {
  // FAILS if `credited` is built from read ∪ authored without subtracting the
  // exposures. A refuted entry reaches the agent under a banner telling it not
  // to follow the body, so its presence on screen is evidence in NEITHER
  // direction — crediting it is the laundering defect
  // (`project_tbench_observe_outcome_launders_self_reported_success`).
  const log = [
    '{"served":[11,12,14],"at":"t"}',
    '{"read_refuted":[11],"refuted_at_read":true,"at":"t"}',
    '{"read":[12],"refuted_at_read":false,"at":"t"}',
    // The defensive shape: a row that kept the `read` key AND flagged it.
    '{"read":[15],"refuted_at_read":true,"at":"t"}',
    '{"authored":[13],"at":"t"}',
    'not json at all',
  ].join('\n')
  const m = memoryFor(log)
  assert.deepEqual(m.served, [11, 12, 14])
  assert.deepEqual(m.refuted_at_read, [11, 15])
  assert.deepEqual(m.authored, [13])
  assert.deepEqual(m.credited, [12, 13])
  for (const id of m.refuted_at_read) {
    assert.ok(!m.credited.includes(id), `${id} must not be creditable`)
  }
})

// ── (e) blocks ──────────────────────────────────────────────────────────────
test('a block is recorded with its kind and a head bounded to the constant', () => {
  // FAILS if the head is unbounded (one block message is a paragraph, and the
  // index is appended to forever) or if the kind is dropped — the kind is the
  // difference between "the judge objected" and "the ledger was stale", which
  // have already been confused in this campaign and have different fixes.
  const long = 'y'.repeat(3000)
  const events = [
    { type: 'user', timestamp: '2026-09-10T00:30:00Z', message: { content: `${STOP_FEEDBACK_PREFIX}\n${JUDGE_BLOCK_PREFIX}\n${long}` } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  ]
  const blocks = blocksFrom(events)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'judge')
  assert.equal(blocks[0].at, '2026-09-10T00:30:00Z')
  assert.equal(blocks[0].head.length, BLOCK_HEAD_CHARS)
  assert.ok(blocks[0].head.length <= BLOCK_HEAD_CHARS)
})

test('a trial with no session jsonl still reports its blocks from the flat transcript', () => {
  const blocks = blocksFrom([], `chatter\n${STOP_FEEDBACK_PREFIX}\n${JUDGE_BLOCK_PREFIX} because reasons\nmore`)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'judge')
})

// ── (f) void ────────────────────────────────────────────────────────────────
test('zero output tokens is VOID even when reward.txt says the trial passed', () => {
  // FAILS on the obvious implementation, `void = !runWasSound(...)`.
  // `runWasSound` short-circuits on reward > 0 BEFORE it looks at the token
  // count, deliberately, because the campaign rule it serves must never drop a
  // genuine pass. A forensic record asks a different question — was there
  // anything here to diagnose — and a run that emitted nothing has nothing to
  // diagnose no matter what a stale reward file says. Both readings ship.
  const box = tmp()
  const dir = makeTrial({
    root: join(box, 'jobs'),
    task: 'demo-task',
    trial: 'demo-task__zero',
    reward: '1',
    result: { agent_result: { n_input_tokens: 5, n_output_tokens: 0, cost_usd: 0 } },
  })
  const r = forensicsForTrial(dir, { write: false, index: false })
  assert.equal(r.tokens.output, 0)
  assert.equal(r.void, true, 'a run that produced no tokens is not a fair test')
  assert.equal(r.sound, true, 'the campaign predicate is unchanged, and both fields ship')
  assert.ok(r.suspects.some((s) => s.rule === 'void_run'))
  rmSync(box, { recursive: true, force: true })
})

// ── (g) purity ──────────────────────────────────────────────────────────────
test('no suspect rule or evidence can carry a benchmark task identifier', () => {
  // FAILS without the redactor: a container path and a check name are
  // agent-written strings, and an agent that puts the task name in a directory
  // makes every suspect it triggers a per-task heuristic in writing
  // (`rules/bench-agi-purity.md`). This builds exactly that trial for a sample
  // of the real task list and asserts nothing survives.
  const names = taskNames()
  if (!names.length) return // no task list on this machine — see taskNames()
  const box = tmp()
  const checked = []
  for (const task of names.slice(0, 12)) {
    const dir = makeTrial({
      root: join(box, 'jobs'),
      job: `job-${task}`,
      task,
      trial: `${task}__pure`,
      reward: '0',
      ctrf: [
        { name: `test_${task}.py::test_a`, status: 'passed' },
        {
          name: `test_${task}.py::test_b`,
          status: 'failed',
          trace: `def test_b():\n>       assert v >= 0.5\nE       assert 0.49 >= 0.5`,
        },
      ],
      trajectory: {
        steps: [
          writeStep(1, `/app/${task}/solve.py`, `thresh = ${SIXTEEN}\n`),
          writeStep(2, `/tmp/${task}_fixture.py`, `expected = ${SIXTEEN}\n`),
        ],
      },
      session: [{ type: 'assistant', message: { content: [{ type: 'text', text: `I measured 0.9876 on ${task}.` }] } }],
      proxy: '{"read_refuted":[9],"refuted_at_read":true,"at":"t"}',
    })
    const r = forensicsForTrial(dir, { write: false, index: false, taskNames: names })
    assert.ok(r.suspects.length, `${task}: the fixture must actually trigger suspects, or this proves nothing`)
    checked.push(task)
    for (const s of r.suspects) {
      for (const name of names) {
        assert.ok(!s.rule.includes(name), `rule "${s.rule}" names ${name}`)
        assert.ok(!s.evidence.includes(name), `evidence "${s.evidence}" names ${name}`)
      }
    }
  }
  assert.ok(checked.length >= 1)
  rmSync(box, { recursive: true, force: true })
})

test('the redactor takes the LONGEST name first', () => {
  // A short name that prefixes a longer one would otherwise leave the tail
  // behind — the same ordering bug `bench-seed-purity.test.mjs` records.
  assert.equal(redactTaskNames('fix-git-hard and fix-git', ['fix-git', 'fix-git-hard']), '<task> and <task>')
})

// ── (h) the trial is never mutated ──────────────────────────────────────────
test('writing a forensics record does not touch verifier/ or agent/', () => {
  // FAILS if anything here ever opens a grader artifact for writing, or if the
  // deliverable replay is allowed to run a recorded command with the agent's
  // own file arguments. A diagnostic that can alter the thing it measures
  // destroys every number derived from the corpus afterwards.
  const box = tmp()
  const dir = makeTrial({
    root: join(box, 'jobs'),
    task: 'demo-task',
    trial: 'demo-task__ro',
    reward: '0',
    ctrf: [{ name: 'test_x.py::test_a', status: 'failed', trace: `>   assert v >= 0.5\nE   assert 0.49 >= 0.5` }],
    stdout: 'FAILED test_x.py::test_a\n',
    trajectory: { steps: [writeStep(1, '/app/solve.py', 'body\n')] },
    proxy: '{"served":[1],"at":"t"}',
  })
  const beforeVerifier = hashTree(join(dir, 'verifier'))
  const beforeAgent = hashTree(join(dir, 'agent'))

  const r = forensicsForTrial(dir, { base: join(box, 'jobs') })

  assert.equal(hashTree(join(dir, 'verifier')), beforeVerifier, 'verifier/ was modified')
  assert.equal(hashTree(join(dir, 'agent')), beforeAgent, 'agent/ was modified')
  assert.ok(existsSync(join(dir, 'forensics.json')))
  assert.ok(existsSync(join(dir, 'forensics.md')))
  assert.ok(existsSync(join(box, 'jobs', INDEX_FILE)))
  const line = JSON.parse(readFileSync(join(box, 'jobs', INDEX_FILE), 'utf8').trim())
  assert.equal(line.trial, 'demo-task__ro')
  assert.equal(line.reward, 0)
  assert.deepEqual(line.failed[0].values, ['0.49', '0.5'])
  assert.deepEqual(r.errors, [])
  rmSync(box, { recursive: true, force: true })
})

// ── supporting rules ────────────────────────────────────────────────────────
test('a trivial literal is not a fitted constant', () => {
  // FAILS without the materiality bar. Measured on the first real trial this
  // ran against: `mean = 0.0`, `std = 1.0`, `drop_prob = 0.0`, `keep_prob = 1.0`
  // all "reappeared in a fixture" because 0.0 and 1.0 appear in every numeric
  // file ever written. Four suspects, zero signal — and a reader who learns to
  // skip the rule stops reading the one instance that matters.
  assert.deepEqual(assignedConstants('mean = 0.0\nstd = 1.0\nratio = 0.500\n'), [])
  assert.deepEqual(assignedConstants(`thresh = ${SIXTEEN}`), [{ name: 'thresh', literal: SIXTEEN }])
})

test('only a DECIMAL the grader never printed counts as an unmatched claim', () => {
  const c = claimsFrom('I saw 0.9610 over 304 objects, and 0.49 matched.', 'assert 0.49 >= 0.5')
  assert.deepEqual(c.unmatched_numbers, ['0.9610'])
  assert.ok(c.grader_numbers.includes('0.5'))
})

test('a check that prints hundreds of values is CAPPED in count, never in precision', () => {
  // FAILS without the cap, and this is not hypothetical: measured on the first
  // real sweep this ran over, one trial's assertion trace printed a rejected
  // list and produced 400+ values — into the record, into the append-only
  // index, and into a table cell, burying the one value an operator opened it
  // for. The kept values must still be byte-exact: capping a LIST is display,
  // capping a VALUE is falsifying evidence.
  const flood = Array.from({ length: 400 }, (_, i) => `${i}`).join(', ')
  const c = describeCheck({
    name: 'test_x.py::test_big',
    trace: `def test_big():\n>       assert ok\nE       AssertionError: ${SIXTEEN} rejected [${flood}]`,
  })
  assert.equal(c.values.length, MAX_CHECK_VALUES)
  assert.equal(c.values[0], SIXTEEN, 'the leading value is the one that matters and must survive verbatim')
  assert.ok(c.values_truncated > 300, `values_truncated was ${c.values_truncated}`)
})

test('unmatched claims are matched against the FULL grader set, then truncated', () => {
  // FAILS if the grader list is capped before the comparison: a number the
  // grader really did print would be reported as unmatched, and the field
  // would manufacture its own finding — exactly
  // `project_judge_truncation_manufactured_a_finding`.
  const graderText = Array.from({ length: 300 }, (_, i) => `${i}.5`).join(' ')
  const c = claimsFrom('my result was 299.5', graderText)
  assert.deepEqual(c.unmatched_numbers, [], 'the grader printed 299.5 at position 300 of its list')
  assert.equal(c.grader_numbers.length, MAX_CLAIM_NUMBERS)
  assert.equal(c.grader_numbers_total, 300)
})

// ── real artifacts ──────────────────────────────────────────────────────────
test('a real finished trial reproduces its grader value character for character', () => {
  // Skips cleanly when the corpus is not on this machine. When it IS, this is
  // the only case here that proves the readers agree with the real artifact
  // shapes rather than with the fixtures in this file.
  const dir = join(HERE, 'jobs', 'redo09131002-20260913-100556', 'sam-cell-seg__NvEy457')
  if (!existsSync(dir)) return
  const r = forensicsForTrial(dir, { write: false, index: false })
  assert.equal(r.reward, 0)
  assert.equal(r.checks.failed.length, 1)
  assert.ok(
    r.checks.failed[0].name.endsWith('test_mask_alignment'),
    `failed check was ${r.checks.failed[0].name}`,
  )
  assert.equal(r.checks.failed[0].values[0], '0.485378353934278')
  assert.equal(r.checks.failed[0].ordinal_semantics, 'first-failing')
  assert.deepEqual(r.errors, [])
})

/**
 * The benchmark's task identifiers, from whichever source this machine has.
 *
 * `all89.txt` is the campaign's own list; the task clone is the authority when
 * it is present. Neither is guaranteed on a CI runner, and asserting on their
 * absence would make this file pass or fail on which machine ran it.
 */
function taskNames() {
  const list = join(HERE, 'all89.txt')
  if (existsSync(list)) {
    const names = readFileSync(list, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (names.length) return names
  }
  const tasks = process.env.TB_TASKS_DIR || 'D:/Git/terminal-bench-2-1/tasks'
  try {
    return readdirSync(tasks).filter((d) => statSync(join(tasks, d)).isDirectory())
  } catch {
    return []
  }
}
