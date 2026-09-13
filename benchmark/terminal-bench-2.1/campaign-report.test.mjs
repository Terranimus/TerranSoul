#!/usr/bin/env node
/**
 * Tests for the campaign standing.
 *
 * WHY THEY EXIST: this accounting was retyped as an ad-hoc `node -e` three
 * times and was wrong once, reporting 46/46 = 100% where the truth was 45/46.
 * The classification below is the part that was missing, so it is the part
 * that is pinned.
 *
 * FAILS ON THE PRE-CHANGE TREE: campaign-report.mjs did not exist.
 *
 * Fixtures throughout — asserting against the live jobs/ tree would make these
 * pass or fail on which benchmark ran last, and go green on an empty corpus.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, neverRan, report, K1_PREFIX, K1_PREFIX_PRE_ENFORCEMENT, RETRYABLE_ERRORS } from './campaign-report.mjs'

const tokens = (i, o) => ({ n_input_tokens: i, n_output_tokens: o })
const trial = (reward, { err = null, agent = tokens(1000, 500) } = {}) => ({
  verifier_result: reward === null ? {} : { rewards: { reward } },
  exception_info: err ? { exception_type: err } : null,
  agent_result: agent,
})

test('a clean pass is a pass', () => {
  assert.equal(classify(trial(1)), 'pass')
})

test('AgentTimeoutError is CAPABILITY, not infra — it reproduces on retry', () => {
  // ⛔ The measured policy in run-sweep.sh: "the AGENT ran out of time: a
  // legitimate 0.0 that will reproduce on every attempt" — caffe-cifar-10 went
  // 42m -> 1h06 -> 1h02, never once succeeding. Filing it as infra would let a
  // real failure be retried away.
  assert.equal(classify(trial(0, { err: 'AgentTimeoutError' })), 'capability')
  // And a timeout that the verifier nonetheless graded 1 is still not a pass.
  assert.equal(classify(trial(1, { err: 'AgentTimeoutError' })), 'capability')
})

test('UnknownApiError is INFRA — the run broke around the agent', () => {
  assert.equal(classify(trial(0, { err: 'UnknownApiError' })), 'infra')
  assert.equal(classify(trial(0, { err: 'AgentSetupTimeoutError' })), 'infra')
  assert.ok(RETRYABLE_ERRORS.has('UnknownApiError'))
  assert.ok(!RETRYABLE_ERRORS.has('AgentTimeoutError'))
})

test('ZERO TOKENS means the run never happened, whatever the error is called', () => {
  // ⛔ Stronger and more general than any error name. Measured on
  // rstan-to-pystan 2026-09-04: an API 529 surfaced as a shell exit 1 with
  // n_input_tokens 0 / n_output_tokens 0. And
  // reference_run_that_never_happened_is_not_a_failure records 20 trials scored
  // 0 with zero completion tokens after a revoked token — reading those as
  // capability failures was wrong.
  assert.equal(neverRan(trial(0, { agent: tokens(0, 0) })), true)
  assert.equal(neverRan(trial(0)), false)
  assert.equal(classify(trial(0, { err: 'SomeUnseenError', agent: tokens(0, 0) })), 'infra')
  // A trial that DID run and failed is capability even under an unknown error.
  assert.equal(classify(trial(0, { err: 'SomeUnseenError' })), 'capability')
})

test('an ordinary unsolved task is a capability failure', () => {
  assert.equal(classify(trial(0)), 'capability')
})

test('the k=1 prefix admits the ENFORCEMENT-ERA sweep and rejects the rest', () => {
  for (const j of ['ts09040258w0-x', 'ts09040258w1-x', 'ts09041200w0-x']) {
    assert.ok(K1_PREFIX.test(j), `${j} must count as k=1`)
  }
  // ⛔ redo* jobs are repeated attempts at hard tasks — the best-of-N
  // population. Admitting them would silently turn this into a best-of-N rate
  // reported as k=1, which is the overstatement the tool exists to prevent.
  for (const j of ['redo09021856-x', 'par008080438-x', 'sweep08060035-x', 'batch09030808-x']) {
    assert.ok(!K1_PREFIX.test(j), `${j} must NOT count as k=1`)
  }
})

test('the PRE-ENFORCEMENT sweep is excluded from the current rate', () => {
  // ⛔ Those 66 trials ran with TB_STOP_HOOK unset: no stop gate, no wall-clock
  // guards. Pooling them with the enforcement-era sweep would average two
  // different harnesses into one number and call it k=1 — the same
  // overstatement as pooling best-of-N with single trials, one level up.
  for (const j of ['tsb09031729-x', 'tsb09032033-x', 'ts09032141w0-x']) {
    assert.ok(!K1_PREFIX.test(j), `${j} is pre-enforcement and must not count`)
    assert.ok(K1_PREFIX_PRE_ENFORCEMENT.test(j), `${j} must stay addressable for comparison`)
  }
})

test('THE HEADLINE RATE COUNTS ONLY k=1 TRIALS, never best-of-N', () => {
  const rows = [
    { task: 'a', job: 'ts09040258w0-x', k1: true, class: 'pass', exceptionType: null },
    { task: 'b', job: 'ts09040258w0-x', k1: true, class: 'capability', exceptionType: 'AgentTimeoutError' },
    { task: 'c', job: 'ts09040258w1-x', k1: true, class: 'infra', exceptionType: 'UnknownApiError' },
    // 'd' passed only in a redo job: historical, NOT k=1.
    { task: 'd', job: 'redo09021856-x', k1: false, class: 'pass', exceptionType: null },
  ]
  const r = report(rows, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(r.measured, 3, 'only the three k=1 tasks are measured')
  assert.equal(r.pass, 1)
  assert.equal(r.capability, 1)
  assert.equal(r.infra, 1)
  assert.equal(r.rate, 1 / 3)
  // ⛔ 'd' must NOT lift the rate. It passed across repeated attempts, which is
  // a different claim.
  assert.equal(r.historicalOnly, 1)
  assert.deepEqual(r.unattempted, ['e'])
})

test('the post-retry number is reported as a CEILING, not as the result', () => {
  const rows = [
    { task: 'a', job: 'ts09040258w0-x', k1: true, class: 'pass', exceptionType: null },
    { task: 'b', job: 'ts09040258w0-x', k1: true, class: 'infra', exceptionType: 'UnknownApiError' },
  ]
  const r = report(rows, ['a', 'b'])
  assert.equal(r.rate, 0.5, 'the RESULT counts the infra failure as a non-pass')
  assert.equal(r.ceilingAfterRetry, 1, 'the CEILING assumes every retry succeeds')
  assert.notEqual(r.rate, r.ceilingAfterRetry, 'the two must never be the same number')
})

test('a task retried after an infra failure reads as one pass, not two verdicts', () => {
  const rows = [
    { task: 'a', job: 'ts09040258w0-x', k1: true, class: 'infra', exceptionType: 'UnknownApiError' },
    { task: 'a', job: 'ts09040258w1-x', k1: true, class: 'pass', exceptionType: null },
  ]
  const r = report(rows, ['a'])
  assert.equal(r.measured, 1)
  assert.equal(r.pass, 1)
  assert.equal(r.infra, 0)
})

test('an empty corpus reports zeroes rather than dividing by zero', () => {
  const r = report([], ['a', 'b'])
  assert.equal(r.measured, 0)
  assert.equal(r.rate, 0)
  assert.equal(r.ceilingAfterRetry, 0)
  assert.equal(r.unattempted.length, 2)
})
