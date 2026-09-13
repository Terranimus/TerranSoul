/**
 * Tests for `triage-trial.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so the
 * import throws. Beyond that, each case pins a classification decision that
 * decides what a human does next — getting one wrong sends the reader at the
 * wrong layer, which is the entire cost this tool exists to remove.
 *
 * Hermetic: temp dirs and literals. No trial corpus, no brain, no docker.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readReward,
  readChecks,
  readException,
  splitDeliverables,
  classify,
  BRAIN_USAGE_SOURCE,
} from './triage-trial.mjs'

function trial({ reward, ctrf, exception }) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  mkdirSync(join(dir, 'verifier'), { recursive: true })
  if (reward !== undefined) writeFileSync(join(dir, 'verifier', 'reward.txt'), String(reward))
  if (ctrf) writeFileSync(join(dir, 'verifier', 'ctrf.json'), JSON.stringify({ results: { tests: ctrf } }))
  if (exception) writeFileSync(join(dir, 'exception.txt'), exception)
  return dir
}

test('a graded zero and a missing grade are different states', () => {
  // FAILS if reward.txt absence is coerced to 0: an errored trial would then be
  // reported as a capability failure, which is the single most expensive
  // misread in this campaign.
  const graded = trial({ reward: '0' })
  const errored = trial({ exception: 'NonZeroAgentExitCodeError: Command failed (exit 143): apt-get update' })
  assert.equal(readReward(graded), 0)
  assert.equal(readReward(errored), null)
  rmSync(graded, { recursive: true, force: true })
  rmSync(errored, { recursive: true, force: true })
})

test('an errored trial is classified as infrastructure, not capability', () => {
  const v = classify({
    reward: null,
    checks: [],
    exception: { kind: 'NonZeroAgentExitCodeError', exit: 143, line: 'apt-get update' },
  })
  assert.equal(v.case, 'errored')
  assert.match(v.look, /infrastructure/)
})

test('exit 137 and 143 both read as infrastructure', () => {
  for (const exit of [137, 143]) {
    const v = classify({ reward: null, checks: [], exception: { kind: 'X', exit, line: '' } })
    assert.match(v.look, /SIGKILL|SIGTERM/, `exit ${exit}`)
  }
})

test('a partial pass is called a half-solution and NAMES the failing half', () => {
  // The measured filter-js shape. FAILS on a classifier that only reports the
  // count: "1 of 2" is exactly the lossy signal that kept 50 trials switching
  // architecture wholesale instead of combining the halves.
  const v = classify({
    reward: 0,
    checks: [
      { name: 'test_filter_blocks_xss', status: 'passed' },
      { name: 'test_clean_html_unchanged', status: 'failed' },
    ],
    exception: null,
  })
  assert.equal(v.case, 'partial')
  assert.match(v.headline, /1 of 2/)
  assert.match(v.look, /test_clean_html_unchanged/)
  assert.match(v.look, /acceptance criterion/)
})

test('every check failing points at the approach, not a detail', () => {
  const v = classify({
    reward: 0,
    checks: [{ name: 'a', status: 'failed' }, { name: 'b', status: 'failed' }],
    exception: null,
  })
  assert.equal(v.case, 'all-checks-failed')
  assert.match(v.look, /approach/)
})

test('a pass needs no triage', () => {
  assert.equal(classify({ reward: 1, checks: [], exception: null }).case, 'passed')
})

test('readChecks returns status only, and survives a malformed report', () => {
  const good = trial({ reward: 0, ctrf: [{ name: 'x', status: 'passed' }] })
  assert.deepEqual(readChecks(good), [{ name: 'x', status: 'passed' }])
  const bad = mkdtempSync(join(tmpdir(), 'triage-'))
  mkdirSync(join(bad, 'verifier'), { recursive: true })
  writeFileSync(join(bad, 'verifier', 'ctrf.json'), '{not json')
  assert.deepEqual(readChecks(bad), [])
  rmSync(good, { recursive: true, force: true })
  rmSync(bad, { recursive: true, force: true })
})

test('readException takes the exception that PROPAGATED, not the first frame', () => {
  // A Python traceback lists the call path first and the real cause last.
  // FAILS on a first-match scan, which would report the wrapper.
  const dir = trial({
    exception: [
      'Traceback (most recent call last):',
      '  File "base.py", line 559, in _exec',
      '    raise self._classify_exec_error(command, result)',
      'harbor.agents.installed.base.NonZeroAgentExitCodeError: Command failed (exit 143): apt-get update',
    ].join('\n'),
  })
  const e = readException(dir)
  assert.match(e.kind, /NonZeroAgentExitCodeError$/)
  assert.equal(e.exit, 143)
  rmSync(dir, { recursive: true, force: true })
})

test('scratch rigs are separated from the deliverable', () => {
  const { product, scratch } = splitDeliverables([
    { path: '/app/filter.py', content: 'x' },
    { path: '/tmp/t/rig2.py', content: 'y' },
    { path: '/root/probe.py', content: 'z' },
  ])
  assert.deepEqual(product.map((f) => f.path), ['/app/filter.py'])
  assert.deepEqual(scratch.map((f) => f.path).sort(), ['/root/probe.py', '/tmp/t/rig2.py'])
})

test('brain usage is declared underivable rather than guessed', () => {
  // ⛔ THE REGRESSION THIS PINS. A first draft counted `brain_*` in the
  // trajectory and printed 0 for a trial that made 8 real calls, which would
  // report a fabricated infrastructure bug. Counting there is wrong in BOTH
  // directions (instruction text over-reports, structured scan under-reports),
  // so the honest answer is a pointer to the host-side proxy log.
  assert.match(BRAIN_USAGE_SOURCE, /not derivable/)
  const v = classify({ reward: 0, checks: [{ name: 'a', status: 'failed' }], exception: null })
  assert.doesNotMatch(v.look, /never called/)
})

// ⛔ FAILS ON THE PRE-CHANGE TREE: classify() branched on `reward === null` for
// the errored path, so a GRADED trial where the agent never ran fell through to
// 'all-checks-failed' and read as a capability result. That is the exact shape
// that produced a false 2% regression on 2026-09-08.
test('a graded trial where the agent never ran is not triaged as a failure', () => {
  const v = classify({
    reward: 0,
    checks: [{ status: 'failed' }, { status: 'failed' }],
    exception: null,
    soundness: { sound: false, why: 'the agent produced ZERO output tokens — it never ran' },
  })
  assert.equal(v.case, 'never-a-fair-test')
  assert.match(v.headline, /NOT A CAPABILITY RESULT/)
  assert.match(v.look, /Re-run it/)
})

test('a sound trial is still triaged normally', () => {
  const v = classify({
    reward: 0,
    checks: [{ status: 'passed' }, { status: 'failed' }],
    exception: null,
    soundness: { sound: true, why: null },
  })
  assert.notEqual(v.case, 'never-a-fair-test')
})

// ⛔ AND A PASS IS A PASS. If a trial scored 1, no soundness reading may take
// that away — otherwise the guard could erase a real success.
test('soundness never overrides a pass', () => {
  const v = classify({
    reward: 1,
    checks: [],
    exception: null,
    soundness: { sound: false, why: 'whatever' },
  })
  assert.equal(v.case, 'passed')
})

test('an INCOMPLETE reconstruction is never printed as the deliverable', async () => {
  // ⛔ THE CONFIDENT WRONG FILE, ONE LEVEL UP. `extract-deliverables.mjs` marks a
  // path `fidelity:'incomplete'` when the shell patched it in a window the
  // metadata replay cannot reconstruct — the exact shape of the two real
  // sam-cell-seg trials (2 and 10 unreconstructable self-patches). This tool is
  // the only other consumer of that record, and it printed the stale buffer
  // under the heading "deliverables the agent wrote" with no flag at all, which
  // is what sends a reader off to diff bytes the grader never saw.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'triage-trial.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'tb-triage-fidelity-'))
  mkdirSync(join(dir, 'verifier'), { recursive: true })
  mkdirSync(join(dir, 'agent'), { recursive: true })
  writeFileSync(join(dir, 'verifier', 'reward.txt'), '0')
  const meta = (m) => `File created successfully at: ${m.filePath}\n\n[metadata] ${JSON.stringify(m)}`
  writeFileSync(
    join(dir, 'agent', 'trajectory.json'),
    JSON.stringify({
      steps: [
        { step_id: 1, message: meta({ type: 'create', filePath: '/app/solve.py', content: 'v1\n' }) },
        {
          step_id: 2,
          extra: { cwd: '/app' },
          tool_calls: [
            {
              function_name: 'Bash',
              arguments: { command: "python3 - <<'PYX'\ns=open('solve.py').read()\nopen('solve.py','w').write(s+'patched')\nPYX" },
            },
          ],
        },
        { step_id: 3, message: `[metadata] ${JSON.stringify({ type: 'update', filePath: '/app/solve.py', oldString: 'v1', newString: 'v2' })}` },
      ],
    }),
  )

  const out = await run(process.execPath, [script, dir], { encoding: 'utf8' })
  assert.match(out.stdout, /deliverables the agent wrote/)
  assert.match(out.stdout, /solve\.py.*INCOMPLETE/)
  assert.match(out.stdout, /NOT the bytes the grader judged/)
  rmSync(dir, { recursive: true, force: true })
})

test('a cleanly replayed deliverable carries NO fidelity warning', async () => {
  // The other half: a warning that fires on every file is a warning nobody
  // reads, so the flag has to be absent when the replay is complete.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'triage-trial.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'tb-triage-clean-'))
  mkdirSync(join(dir, 'verifier'), { recursive: true })
  mkdirSync(join(dir, 'agent'), { recursive: true })
  writeFileSync(join(dir, 'verifier', 'reward.txt'), '0')
  const meta = (m) => `[metadata] ${JSON.stringify(m)}`
  writeFileSync(
    join(dir, 'agent', 'trajectory.json'),
    JSON.stringify({
      steps: [
        { step_id: 1, message: meta({ type: 'create', filePath: '/app/solve.py', content: 'v1\n' }) },
        { step_id: 2, message: meta({ type: 'update', filePath: '/app/solve.py', oldString: 'v1', newString: 'v2' }) },
      ],
    }),
  )
  const out = await run(process.execPath, [script, dir], { encoding: 'utf8' })
  assert.match(out.stdout, /solve\.py/)
  assert.doesNotMatch(out.stdout, /INCOMPLETE/)
  rmSync(dir, { recursive: true, force: true })
})
