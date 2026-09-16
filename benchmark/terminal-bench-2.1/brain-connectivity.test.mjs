/**
 * brain-connectivity.mjs must tell "never connected" apart from "connected
 * but unused" and "dropped mid-trial" — the distinction the 22-trial corpus
 * forensics found nothing recorded (fix F5, TBENCH-BRAIN-CONNECT-1).
 *
 * FAILS ON THE PRE-CHANGE TREE: brain-connectivity.mjs did not exist, so
 * every import below throws MODULE_NOT_FOUND. The distinction it draws did
 * not exist either: check-terransoul-used.sh's own fallback message calls
 * EVERY zero-call trial "may have connected, but was never called" — which
 * is provably wrong for a trial whose proxy log has literally nothing in it,
 * because Claude Code's MCP client always sends `initialize` the instant a
 * connection succeeds (that file's own header states this as fact).
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyBrainStatus, BRAIN_STATUS } from './brain-connectivity.mjs'
import { classifyTrial } from './trial-outcome.mjs'

// Resolved from THIS file's own location, not process.cwd() -- a test that
// shells out to a sibling script must find it regardless of the directory
// the test runner was invoked from (`node --test` from the repo root vs.
// from this directory), or an unrelated MODULE_NOT_FOUND crash produces an
// exit code that can accidentally match what a test expects.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'brain-conn-'))
}

test('neither evidence file exists — genuinely predates instrumentation: UNKNOWN', () => {
  const dir = sandbox()
  try {
    const r = classifyBrainStatus({ trialDir: dir })
    assert.equal(r.status, BRAIN_STATUS.UNKNOWN)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the calls log EXISTS but holds nothing — THE 22-trial shape: NEVER_CONNECTED, not "predates instrumentation"', () => {
  const dir = sandbox()
  try {
    writeFileSync(join(dir, 'terransoul-proxy-calls.jsonl'), '')
    const r = classifyBrainStatus({ trialDir: dir })
    assert.equal(r.status, BRAIN_STATUS.NEVER_CONNECTED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an initialize line in the log — the handshake completed: CONNECTED', () => {
  const dir = sandbox()
  try {
    writeFileSync(
      join(dir, 'terransoul-proxy-calls.jsonl'),
      '{"method":"initialize","allowed":true,"at":"x"}\n{"method":"notifications/initialized","allowed":true,"at":"x"}\n',
    )
    const r = classifyBrainStatus({ trialDir: dir })
    assert.equal(r.status, BRAIN_STATUS.CONNECTED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tool call with no literal "initialize" line still counts as connected (the fallback)', () => {
  const dir = sandbox()
  try {
    writeFileSync(join(dir, 'terransoul-proxy-calls.jsonl'), '{"tool":"brain_search","allowed":true,"at":"x"}\n')
    const r = classifyBrainStatus({ trialDir: dir })
    assert.equal(r.status, BRAIN_STATUS.CONNECTED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handshake completed, then a crash was recorded: DROPPED_MID_TRIAL', () => {
  const dir = sandbox()
  try {
    writeFileSync(join(dir, 'terransoul-proxy-calls.jsonl'), '{"method":"initialize","allowed":true,"at":"x"}\n')
    writeFileSync(
      join(dir, 'terransoul-proxy-status.jsonl'),
      '{"event":"ready","at":"x"}\n{"event":"crash","reason":"listen error: EADDRINUSE","at":"y"}\n',
    )
    const r = classifyBrainStatus({ trialDir: dir })
    assert.equal(r.status, BRAIN_STATUS.DROPPED_MID_TRIAL)
    assert.match(r.evidence.join(' '), /EADDRINUSE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handshake completed, ready recorded, no crash: CONNECTED (a crash file existing is not itself a crash)', () => {
  const dir = sandbox()
  try {
    writeFileSync(join(dir, 'terransoul-proxy-calls.jsonl'), '{"method":"initialize","allowed":true,"at":"x"}\n')
    writeFileSync(join(dir, 'terransoul-proxy-status.jsonl'), '{"event":"ready","at":"x"}\n{"event":"exit","reason":"signal","at":"y"}\n')
    const r = classifyBrainStatus({ trialDir: dir })
    assert.equal(r.status, BRAIN_STATUS.CONNECTED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classifyTrial (trial-outcome.mjs) attaches brainStatus, reading it from the PARENT (job) directory', () => {
  const jobDir = sandbox()
  const trialDir = join(jobDir, 'some-task__abc123__env-main-1')
  mkdirSync(trialDir)
  try {
    writeFileSync(
      join(trialDir, 'result.json'),
      JSON.stringify({ exception_info: null, agent_result: { n_output_tokens: 50 }, verifier_result: { rewards: { reward: 0 } } }),
    )
    // Proxy evidence lives at the JOB level, not inside the trial subdir --
    // exactly what run-dg.sh's own `cp ... "$JOB_DIR/terransoul-proxy-calls.jsonl"` does.
    writeFileSync(join(jobDir, 'terransoul-proxy-calls.jsonl'), '')
    const out = classifyTrial(trialDir)
    assert.equal(out.brainStatus.status, BRAIN_STATUS.NEVER_CONNECTED, JSON.stringify(out))
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

// ── CLI: the F4 requeue predicate ───────────────────────────────────────────

function runCli(jobDir) {
  try {
    const out = execFileSync('node', [join(SCRIPT_DIR, 'brain-connectivity.mjs'), 'never-connected-and-not-passed', jobDir], {
      encoding: 'utf8',
      cwd: SCRIPT_DIR,
    })
    return { rc: 0, out }
  } catch (e) {
    return { rc: e.status, out: e.stdout ?? '' }
  }
}

test('CLI: a never-connected, NOT-passed trial is flagged for requeue (exit 0)', () => {
  const jobDir = sandbox()
  const trialDir = join(jobDir, 'raman-fitting__x1__env-main-1')
  mkdirSync(trialDir)
  try {
    writeFileSync(
      join(trialDir, 'result.json'),
      JSON.stringify({ exception_info: null, agent_result: { n_output_tokens: 0 }, verifier_result: { rewards: { reward: 0 } } }),
    )
    writeFileSync(join(jobDir, 'terransoul-proxy-calls.jsonl'), '')
    const { rc, out } = runCli(jobDir)
    assert.equal(rc, 0, out)
    assert.match(out, /never-connected/)
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('CLI: a never-connected trial that ALREADY PASSED is not requeued (exit 1) — a real pass is not thrown away', () => {
  const jobDir = sandbox()
  const trialDir = join(jobDir, 'raman-fitting__x2__env-main-1')
  mkdirSync(trialDir)
  try {
    writeFileSync(
      join(trialDir, 'result.json'),
      JSON.stringify({ exception_info: null, agent_result: { n_output_tokens: 500 }, verifier_result: { rewards: { reward: 1 } } }),
    )
    writeFileSync(join(jobDir, 'terransoul-proxy-calls.jsonl'), '')
    const { rc } = runCli(jobDir)
    assert.equal(rc, 1)
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('CLI: a CONNECTED trial that failed is not this shape (exit 1) — it is an ordinary capability failure', () => {
  const jobDir = sandbox()
  const trialDir = join(jobDir, 'raman-fitting__x3__env-main-1')
  mkdirSync(trialDir)
  try {
    writeFileSync(
      join(trialDir, 'result.json'),
      JSON.stringify({ exception_info: null, agent_result: { n_output_tokens: 400 }, verifier_result: { rewards: { reward: 0 } } }),
    )
    writeFileSync(join(jobDir, 'terransoul-proxy-calls.jsonl'), '{"method":"initialize","allowed":true,"at":"x"}\n')
    const { rc } = runCli(jobDir)
    assert.equal(rc, 1)
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})
