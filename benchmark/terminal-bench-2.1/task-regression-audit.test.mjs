/**
 * Tests for `task-regression-audit.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist.
 *
 * THE DEFECT IT EXISTS FOR, measured 2026-09-02: `extract-moves-from-video`
 * passed 11 of 33 trials — every pass before 2026-08-28 — then failed six times
 * running. `mteb-retrieve` did the same on the same date. Nothing noticed for
 * five days, because `bench-never-regress` is enforced on the HEADLINE, and a
 * headline is an average: one task dying is ~1.1pp, invisible while other tasks
 * are being fixed in the same window. I called the task a capability limit
 * before checking its history.
 *
 * Hermetic: array fixtures only. No job dirs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { findRegressions, agentRan } from './task-regression-audit.mjs'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const t = (task, date, reward) => ({ task, date, reward, root: 'jobs' })

test('a task that passed then failed a streak is reported', () => {
  const trials = [
    t('alpha', '20260820', 1),
    t('alpha', '20260821', 1),
    t('alpha', '20260829', 0),
    t('alpha', '20260830', 0),
    t('alpha', '20260831', 0),
  ]
  const [r] = findRegressions(trials, { minPasses: 2, streak: 3 })
  assert.equal(r.task, 'alpha')
  assert.equal(r.streak, 3)
  assert.equal(r.lastPassDate, '20260821')
  assert.equal(r.failingSince, '20260829')
})

test('a task that never passed is NOT a regression', () => {
  // filter-js-from-html is 0-for-50. It is a hard task, not a regression, and
  // reporting it would bury the two real ones.
  const trials = Array.from({ length: 8 }, (_, i) => t('never', `2026082${i}`, 0))
  assert.deepEqual(findRegressions(trials, { minPasses: 2, streak: 3 }), [])
})

test('a task still passing recently is NOT a regression', () => {
  const trials = [
    t('fine', '20260820', 1),
    t('fine', '20260821', 0),
    t('fine', '20260822', 0),
    t('fine', '20260823', 1),
    t('fine', '20260824', 0),
  ]
  assert.deepEqual(findRegressions(trials, { minPasses: 2, streak: 3 }), [])
})

test('a short failure streak is noise, not a regression', () => {
  // Trials are unevenly distributed across job dirs; two failures after two
  // passes is a coin flip on a ~50% task, and calling it a regression would
  // make the report an alarm an operator learns to ignore.
  const trials = [
    t('flaky', '20260820', 1),
    t('flaky', '20260821', 1),
    t('flaky', '20260822', 0),
    t('flaky', '20260823', 0),
  ]
  assert.deepEqual(findRegressions(trials, { minPasses: 2, streak: 3 }), [])
})

test('undated trials cannot be ordered and are excluded from the streak', () => {
  // A job dir whose name carries no date gives no position in the sequence.
  // Guessing one would invent a streak or destroy a real one.
  const trials = [
    t('alpha', '20260820', 1),
    t('alpha', '20260821', 1),
    { task: 'alpha', date: null, reward: 1, root: 'jobs' },
    t('alpha', '20260829', 0),
    t('alpha', '20260830', 0),
    t('alpha', '20260831', 0),
  ]
  const [r] = findRegressions(trials, { minPasses: 2, streak: 3 })
  assert.equal(r.streak, 3, 'the undated pass must not break the trailing streak')
  assert.equal(r.total, 5, 'and must not be counted in the dated total')
})

test('a streak is weighed against the task OWN base rate, not reported bare', () => {
  // ⛔ THE FALSE POSITIVE THIS PINS. The first version flagged mteb-retrieve —
  // 3 passes in 30 trials — as a regression on an 11-failure streak. Under its
  // own ~10% rate that streak has probability 0.9^11 = 31%: ordinary. Reporting
  // it bare sent me hunting a cause that need not exist.
  // mteb's REAL shape: 30 trials, 3 passes, and the LAST pass at position 19 so
  // the trailing streak is 11 — not 27. Two earlier versions of this fixture got
  // the shape wrong (3-of-14, then 3 passes followed by 27 straight failures)
  // and each scored ~6%, "proving" the opposite of what this test pins.
  const low = [
    t('rare', '20260801', 1),
    t('rare', '20260802', 1),
    ...Array.from({ length: 16 }, (_, i) => t('rare', `202608${String(3 + i).padStart(2, '0')}`, 0)),
    t('rare', '20260819', 1),
    ...Array.from({ length: 11 }, (_, i) => t('rare', `202609${String(1 + i).padStart(2, '0')}`, 0)),
  ]
  const [r] = findRegressions(low, { minPasses: 2, streak: 3 })
  assert.ok(r.streakProbability > 0.15, `a 21% task failing 11x is not surprising, got ${r.streakProbability}`)

  // A reliable task going dark IS surprising, and must score low.
  const reliable = [
    ...Array.from({ length: 9 }, (_, i) => t('solid', `2026080${i + 1}`, 1)),
    ...Array.from({ length: 5 }, (_, i) => t('solid', `202608${String(20 + i).padStart(2, '0')}`, 0)),
  ]
  const [s] = findRegressions(reliable, { minPasses: 2, streak: 3 })
  assert.ok(s.streakProbability < 0.05, `a 64% task failing 5x IS surprising, got ${s.streakProbability}`)
})

// ⛔ FAILS ON THE PRE-CHANGE TREE: `agentRan` did not exist, and findRegressions
// counted every graded 0 as a capability failure.
//
// MEASURED 2026-09-08. This file reported:
//   sam-cell-seg  13/18 passed (72%), failing 3x since 20260906, P(streak) = 2%
// Two of those three trials had `agent_result.n_output_tokens = 0` and ~6.5 KB
// agent logs — a 429 session limit and a 401 revoked OAuth token. Neither ran a
// turn. The remaining streak is 2 on a 72% task, p = 0.08, i.e. nothing. The
// 2% figure was about to send me bisecting three innocent judge commits.
test('a trial where the agent never ran is not a capability failure', () => {
  const nr = (task, date, reward, ran) => ({ task, date, reward, root: 'jobs', ran })
  const trials = [
    nr('beta', '20260901', 1, true),
    nr('beta', '20260902', 1, true),
    nr('beta', '20260903', 1, true),
    nr('beta', '20260904', 0, false), // 429: session limit, zero tokens
    nr('beta', '20260905', 0, false), // 401: revoked token, zero tokens
    nr('beta', '20260906', 0, true),
  ]
  assert.deepEqual(findRegressions(trials, { minPasses: 2, streak: 3 }), [])
})

test('the excluded trials are counted, not silently dropped', () => {
  const nr = (task, date, reward, ran) => ({ task, date, reward, root: 'jobs', ran })
  const trials = [
    nr('gamma', '20260901', 1, true),
    nr('gamma', '20260902', 1, true),
    nr('gamma', '20260903', 0, false),
    nr('gamma', '20260904', 0, true),
    nr('gamma', '20260905', 0, true),
    nr('gamma', '20260906', 0, true),
  ]
  const [r] = findRegressions(trials, { minPasses: 2, streak: 3 })
  assert.equal(r.streak, 3)
  assert.equal(r.nonRuns, 1)
  // and the excluded trial is out of the DENOMINATOR too, not just the streak
  assert.equal(r.total, 5)
})

test('agentRan fails safe: unreadable or fieldless results count as real runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tra-'))
  // A pass is a run, whatever the file says.
  assert.equal(agentRan(dir, 1), true)
  // No result.json at all -> do not delete a genuine failure.
  assert.equal(agentRan(dir, 0), true)
  const a = join(dir, 'a'); mkdirSync(a)
  writeFileSync(join(a, 'result.json'), 'not json')
  assert.equal(agentRan(a, 0), true)
  const b = join(dir, 'b'); mkdirSync(b)
  writeFileSync(join(b, 'result.json'), JSON.stringify({ agent_result: {} }))
  assert.equal(agentRan(b, 0), true)
  const c = join(dir, 'c'); mkdirSync(c)
  writeFileSync(join(c, 'result.json'), JSON.stringify({ agent_result: { n_output_tokens: 0 } }))
  assert.equal(agentRan(c, 0), false)
  const e = join(dir, 'e'); mkdirSync(e)
  writeFileSync(join(e, 'result.json'), JSON.stringify({
    agent_result: { n_output_tokens: 5000 },
    exception_info: { exception_type: 'ApiRateLimitError' },
  }))
  assert.equal(agentRan(e, 0), false, 'an API cutoff mid-run is not a capability answer')
  // ⛔ THE ONE THAT MUST STAY COUNTED. AgentTimeoutError is 35 of the 43
  // exception-carrying graded-0 trials in the corpus, and it means the agent
  // spent its whole budget without finishing — a capability failure.
  const f = join(dir, 'f'); mkdirSync(f)
  writeFileSync(join(f, 'result.json'), JSON.stringify({
    agent_result: { n_output_tokens: 5000 },
    exception_info: { exception_type: 'AgentTimeoutError' },
  }))
  assert.equal(agentRan(f, 0), true, 'running out of budget IS a capability failure')
  const d = join(dir, 'd'); mkdirSync(d)
  writeFileSync(join(d, 'result.json'), JSON.stringify({ agent_result: { n_output_tokens: 812 } }))
  assert.equal(agentRan(d, 0), true)
})
