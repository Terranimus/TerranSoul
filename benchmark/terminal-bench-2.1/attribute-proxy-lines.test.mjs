#!/usr/bin/env node
/**
 * Tests for per-trial attribution of a proxy log.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, and the
 * behaviour it replaces is `servedMemoryIds()` returning the union over the
 * whole job. The central test asserts two sequential trials get DIFFERENT id
 * sets; under the old code they got identical ones (30 ids credited to each of
 * 10 trials, measured).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProxyLog, trialWindows, firstOverlap, idsForTrial } from './attribute-proxy-lines.mjs'

const T = (min, sec = 0) =>
  `2026-09-03T09:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000Z`
const ms = (min, sec = 0) => Date.parse(T(min, sec))
const line = (o) => `[tb-proxy] ${JSON.stringify(o)}`
const trial = (name, s, e) => ({
  name,
  result: { agent_execution: { started_at: T(s), finished_at: T(e) } },
})

/** One worker running two trials back to back — the supported, attributable shape. */
const SEQUENTIAL = [trial('alpha', 40, 50), trial('beta', 51, 58)]
const SEQUENTIAL_LOG = [
  line({ tool: 'brain_search', allowed: true, at: T(41) }),
  line({ served: [100, 101], at: T(41, 5) }),
  line({ served: [102], at: T(49) }),
  line({ tool: 'brain_search', allowed: true, at: T(52) }),
  line({ served: [200], at: T(52, 5) }),
  line({ authored: [201], at: T(57) }),
].join('\n')

test('lines without a parseable timestamp are skipped, not crashed on', () => {
  const parsed = parseProxyLog(
    ['not json at all', line({ served: [1], at: T(10) }), '{"no":"at"}', ''].join('\n'),
  )
  assert.equal(parsed.length, 1)
})

test('TWO SEQUENTIAL TRIALS GET DIFFERENT IDS — the whole point', () => {
  // ⛔ THE REGRESSION. Under the old whole-log behaviour both returned the same
  // union {100,101,102,200,201}. Measured: 30 ids credited to each of 10 trials.
  const a = idsForTrial(SEQUENTIAL_LOG, 'alpha', SEQUENTIAL)
  const b = idsForTrial(SEQUENTIAL_LOG, 'beta', SEQUENTIAL)
  assert.equal(a.attributed, true)
  assert.equal(b.attributed, true)
  assert.deepEqual(a.ids, [100, 101, 102])
  assert.deepEqual(b.ids, [200, 201])
  assert.equal(a.ids.some((id) => b.ids.includes(id)), false)
})

test('OVERLAPPING windows are REFUSED, never guessed at', () => {
  // ⛔ THIS IS THE SAFETY PROPERTY, and it exists because of a MEASURED failure.
  // The first version of this module keyed on the peer address, on the theory
  // that each trial is its own container on its own compose network. Two
  // containers on two separate networks reaching the host through
  // `host.docker.internal` BOTH arrive as 127.0.0.1 — Docker Desktop NATs every
  // container to loopback, so the address is a constant.
  //
  // Under that scheme all lines joined one session, ONE trial took every id and
  // the other nine credited nothing: the feedback loop would have gone dark
  // while reporting success. There is no offline way to split concurrent trials
  // sharing a proxy, so the honest answer is to refuse.
  const concurrent = [trial('alpha', 40, 58), trial('beta', 42, 52)]
  const r = idsForTrial(SEQUENTIAL_LOG, 'alpha', concurrent)
  assert.equal(r.attributed, false)
  assert.deepEqual(r.ids, [])
  assert.match(r.reason, /overlap/)
  // The message must name the fix, not merely the symptom.
  assert.match(r.reason, /worker per proxy port/)
})

test('touching windows are not an overlap', () => {
  // A trial ending exactly when the next begins is sequential, not concurrent.
  // Treating it as overlap would refuse attribution on a perfectly ordinary run.
  assert.equal(firstOverlap(trialWindows([trial('a', 10, 20), trial('b', 20, 30)])), null)
  assert.notEqual(firstOverlap(trialWindows([trial('a', 10, 21), trial('b', 20, 30)])), null)
})

test('overlap is detected regardless of the order trials are listed in', () => {
  // `readSiblingTrials` returns directory order, which is not time order.
  const out = [trial('later', 42, 52), trial('earlier', 40, 58)]
  assert.notEqual(firstOverlap(trialWindows(out)), null)
})

test('lines outside every window belong to no trial', () => {
  // Setup, teardown and the proxy's own deferred-write flush all land outside
  // the agent windows. Folding them into the nearest trial would credit a trial
  // for memories written after it finished.
  const log = [
    line({ served: [1], at: T(39) }),
    line({ served: [2], at: T(45) }),
    line({ authored: [3], at: T(59) }),
  ].join('\n')
  assert.deepEqual(idsForTrial(log, 'alpha', SEQUENTIAL).ids, [2])
})

test('a trial absent from the window set is refused, not silently empty', () => {
  const r = idsForTrial(SEQUENTIAL_LOG, 'ghost', SEQUENTIAL)
  assert.equal(r.attributed, false)
  assert.match(r.reason, /ghost/)
})

test('the agent window is preferred over the trial window', () => {
  // The trial window includes image setup and the verifier run, during which no
  // agent call can occur. Using it would manufacture overlaps between trials
  // that never ran at the same time — and this module refuses on overlap, so a
  // wider window turns attributable runs into refusals.
  const w = trialWindows([
    {
      name: 'x',
      result: {
        started_at: T(0),
        finished_at: T(59),
        agent_execution: { started_at: T(20), finished_at: T(30) },
      },
    },
  ])
  assert.equal(w[0].start, ms(20))
  assert.equal(w[0].end, ms(30))
})

test('a trial with no usable window is dropped rather than given a bogus one', () => {
  assert.deepEqual(trialWindows([{ name: 'x', result: {} }]), [])
  assert.deepEqual(
    trialWindows([
      { name: 'x', result: { agent_execution: { started_at: T(30), finished_at: T(10) } } },
    ]),
    [],
  )
})

test('no windows at all is a refusal, not an empty success', () => {
  const r = idsForTrial(SEQUENTIAL_LOG, 'alpha', [{ name: 'alpha', result: {} }])
  assert.equal(r.attributed, false)
  assert.match(r.reason, /usable agent window/)
})
