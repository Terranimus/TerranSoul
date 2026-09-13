#!/usr/bin/env node
/**
 * Tests for `buildVerifyLine` — the proxy-log line that records what the stop
 * gate DECIDED.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: `verify-verdict-line.mjs` did not
 * exist, and the proxy logged `{"tool":"brain_verify_completion","allowed":true}`
 * with no `op` and no verdict. Every assertion below is about a field that had
 * no producer, so the import itself fails before any assertion runs.
 *
 * These call the function with fixture responses rather than grepping the
 * proxy's source for a literal — the shape
 * `reference_tests_that_cannot_fail_include_str` records passing with the
 * behaviour deleted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildVerifyLine, REASON_MAX, COMMAND_MAX, buildJudgeInputLine } from './verify-verdict-line.mjs'

const j = (o) => JSON.stringify(o)

/**
 * Response bodies CAPTURED VERBATIM from a live brain on 2026-09-03, not
 * hand-written to match the implementation.
 *
 * ⛔ THE BUG THESE EXIST FOR. The first version of this module was written from
 * the two shapes named in `tools.rs`'s schema description and shipped green: it
 * handled `verify` and `state`, and every hand-authored fixture agreed with it.
 * Against a live batch it logged NOTHING across 6 gate calls, because the op
 * that actually fires is `record`, whose response carries neither field. A
 * fixture invented from the same reading as the code cannot catch that — only
 * a real body can.
 */
const REAL = {
  status:
    '{"changed_paths":[],"evidence":null,"op":"status","state":"unverified","verify_on_stop":null}',
  mark_edited: '{"id":3,"op":"mark_edited","state":"stale"}',
  record:
    '{"canonical_command":"pytest","evidence":"self_selected","id":2,"next":"Recorded. Note what this record is and is not: you chose this check, you ran it, and it agreed with you."}',
  // The SAME op on a later call, once the corroboration branch no longer fires.
  // Captured verbatim: it carries `scope` and `status` and NO `evidence`, which
  // is why building the logger from one sample of one op was not enough.
  record_classified:
    '{"canonical_command":"pytest -q","id":4,"op":"record","recorded":true,"scope":"full","status":"passed"}',
}

test('the judge verdict is recorded with its op, so it can be told from ledger bookkeeping', () => {
  const line = buildVerifyLine(j({ verified: false, reason: 'no test was run', method: 'llm' }), 'verify')
  assert.deepEqual(line, {
    verify: 'verify',
    verified: false,
    method: 'llm',
    reason: 'no test was run',
  })
})

test('a PASSING judge verdict is recorded too — the silent give-up population is made of these', () => {
  // This is the case the whole change exists for: 19 trials scored 0 having
  // never been blocked. Without this line they cannot be split into "the judge
  // confirmed and was wrong" and "the judge was never asked".
  const line = buildVerifyLine(j({ verified: true, method: 'objective' }), 'verify')
  assert.equal(line.verified, true)
  assert.equal(line.method, 'objective')
})

test('a ledger op records its resolved state, not a verdict', () => {
  const line = buildVerifyLine(j({ state: 'stale' }), 'status')
  assert.deepEqual(line, { verify: 'status', state: 'stale' })
  // The op must be preserved verbatim — collapsing every op to 'verify' would
  // recreate the exact ambiguity this change removes.
  assert.notEqual(line.verify, 'verify')
})

test('a missing op defaults to verify, because that is the tool default', () => {
  // `brain_verify_completion`'s schema says op defaults to 'verify', so a
  // request that omits it IS a judge call and must not be logged as unknown.
  assert.equal(buildVerifyLine(j({ verified: true }), undefined).verify, 'verify')
  assert.equal(buildVerifyLine(j({ verified: true }), '').verify, 'verify')
})

test('a response with nothing recognisable yields NO line', () => {
  // A line carrying only the op name would be counted by an audit as evidence
  // the gate decided something, while holding no decision at all.
  assert.equal(buildVerifyLine(j({ unrelated: 1 }), 'verify'), null)
  assert.equal(buildVerifyLine(j({}), 'verify'), null)
})

test('malformed input is survivable — a trial must never be disturbed by logging', () => {
  assert.equal(buildVerifyLine('not json at all', 'verify'), null)
  assert.equal(buildVerifyLine(undefined, 'verify'), null)
  assert.equal(buildVerifyLine(null, 'verify'), null)
  assert.equal(buildVerifyLine(j(['an', 'array']), 'verify'), null)
  // `JSON.parse("null")` succeeds and yields null — the typeof check must catch
  // it, or the field reads below would throw inside a live proxy.
  assert.equal(buildVerifyLine('null', 'verify'), null)
})

test('EVERY real ledger response yields a line — the op that fires is `record`', () => {
  // This is the regression. `record` was the uncovered shape and it is the one
  // the stop hook actually calls: 6 of 6 gate calls in a live batch, all
  // logging nothing. A null here means the gate goes dark again.
  for (const [op, body] of Object.entries(REAL)) {
    assert.notEqual(buildVerifyLine(body, op), null, `op=${op} must produce a line`)
  }
})

test('the ledger CLASSIFICATION of a recorded check is captured', () => {
  // `status` (passed/failed) and `scope` (targeted/full) are the ledger's
  // structural verdict on the proof. Without them a failing trial's evidence
  // trail is a call count; with them it is a diagnosis.
  const line = buildVerifyLine(REAL.record_classified, 'record')
  assert.deepEqual(line, {
    verify: 'record',
    status: 'passed',
    scope: 'full',
    command: 'pytest -q',
  })
})

test('a `record` response carries the ledger judgement of PROOF QUALITY', () => {
  const line = buildVerifyLine(REAL.record, 'record')
  assert.deepEqual(line, {
    verify: 'record',
    evidence: 'self_selected',
    command: 'pytest',
  })
  // `next` is static advice returned verbatim on every call — hundreds of
  // identical bytes and no information. It must not reach the log.
  assert.equal(line.next, undefined)
  assert.ok(!JSON.stringify(line).includes('you chose this check'))
})

test('a null `evidence` is not logged as if it were a classification', () => {
  // The real `status` body carries `evidence: null`. Recording that as a value
  // would put a JSON null into a field an audit groups by.
  const line = buildVerifyLine(REAL.status, 'status')
  assert.deepEqual(line, { verify: 'status', state: 'unverified' })
  assert.equal('evidence' in line, false)
})

test('the recorded command is bounded like the reason', () => {
  const line = buildVerifyLine(
    j({ evidence: 'self_selected', canonical_command: 'x'.repeat(COMMAND_MAX + 200) }),
    'record',
  )
  assert.equal(line.command.length, COMMAND_MAX)
})

test('the reason is bounded — the audit tools read this log in full', () => {
  const long = 'x'.repeat(REASON_MAX + 500)
  const line = buildVerifyLine(j({ verified: false, reason: long }), 'verify')
  assert.equal(line.reason.length, REASON_MAX)
})

test('non-string / non-boolean fields are dropped rather than logged raw', () => {
  // A brain that answers `verified: "true"` must not be recorded as a boolean
  // verdict — that would put an unparsed string into a field an audit sums.
  const line = buildVerifyLine(j({ verified: 'true', method: 7, reason: { a: 1 } }), 'verify')
  assert.equal(line, null)
})

// ── the judge's INPUT, not merely its verdict ────────────────────────────────
//
// FAILS ON THE PRE-CHANGE TREE: `buildJudgeInputLine` did not exist, so the
// import is undefined and every case throws.
//
// ⛔ MEASURED 2026-09-05. The judge returned verified:true on a trial the
// grader scored 0. A reconstruction of that evidence probed against the same
// live brain returned verified:FALSE three times of three, so the real
// snapshot differed in some way that mattered -- and which way is unknowable,
// because `actions_snapshot` appears nowhere in the trial's artefacts.
test('buildJudgeInputLine records what the judge was shown', () => {
  const line = buildJudgeInputLine({
    op: 'verify',
    goal: 'extract at least 75% of the reference values',
    actions_snapshot: 'coverage: 93.1% of file-backed values, 0 mismatches',
  })
  assert.ok(line, 'a verify call must produce a line')
  assert.match(line.judgeInput.goal, /75%/)
  assert.match(line.judgeInput.actions, /93\.1%/)
  assert.equal(line.judgeInput.actionsChars, 51)
})

// The ledger ops share the tool name and must NOT produce a judge-input line —
// one forwarded call must keep producing exactly one of each key, which is why
// the verdict line's own comment insists on a distinct key.
test('buildJudgeInputLine ignores every op that is not the judge', () => {
  for (const op of ['record', 'status', 'mark_edited', undefined]) {
    assert.equal(buildJudgeInputLine({ op, goal: 'g', actions_snapshot: 'a' }), null, `op=${op}`)
  }
  assert.equal(buildJudgeInputLine(undefined), null)
  // A verify call carrying neither field says nothing worth a line.
  assert.equal(buildJudgeInputLine({ op: 'verify' }), null)
})

// ⛔ HEAD-ONLY TRUNCATION IS THE BUG THIS MUST NOT REPEAT. A verdict line lives
// at the END of a command's output, and a `slice(0, n)` is exactly what once
// hid it from the verifier. A log that repeats that mistake is useless for the
// case it exists to diagnose.
test('a long snapshot keeps its tail, and reports its true length', () => {
  const actions = 'HEAD-MARKER' + 'x'.repeat(20000) + 'TAIL-VERDICT: 2 of 3 found'
  const line = buildJudgeInputLine({ op: 'verify', goal: 'g', actions_snapshot: actions })
  assert.match(line.judgeInput.actions, /HEAD-MARKER/)
  assert.match(line.judgeInput.actions, /TAIL-VERDICT: 2 of 3 found/)
  assert.ok(line.judgeInput.actions.length < actions.length, 'must actually be bounded')
  // The untruncated length is the measurement: it says how blind the judge was.
  assert.equal(line.judgeInput.actionsChars, actions.length)
})
