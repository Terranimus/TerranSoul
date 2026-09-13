#!/usr/bin/env node
/**
 * Tests for `outcomeOf` — the joint reading of grader verdict and run soundness.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, and the
 * accounting it replaces read `verifier_result.rewards.reward` alone. The
 * central test below uses the REAL caffe-cifar-10 shape, which that accounting
 * scored as a clean pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outcomeOf, isCleanPass, tally, INFRA_ERRORS, runWasSound } from './trial-outcome.mjs'

const reward = (r) => ({ verifier_result: { rewards: { reward: r } } })
const errored = (type, r) => ({ ...reward(r), exception_info: { exception_type: type } })

test('A TRIAL CAN BE BOTH PASSING AND ERRORED — the case that broke the count', () => {
  // ⛔ REAL SHAPE, caffe-cifar-10, 2026-09-03: the agent blew the 3600s cap and
  // harbor then graded whatever was on disk, which passed. An ad-hoc script
  // reading `reward` alone reported the campaign as 46/46 = 100% while
  // merge-sweep.sh reported 45 of 46. The difference was this one field.
  const r = errored('AgentTimeoutError', 1)
  const o = outcomeOf(r)
  assert.equal(o.reward, 1, 'the grader verdict is preserved, not overwritten')
  assert.equal(o.errored, true)
  assert.equal(o.exceptionType, 'AgentTimeoutError')
  // The rule: errored trials count as reward 0 and are never excluded.
  assert.equal(o.counted, 0)
  assert.equal(isCleanPass(r), false)
})

test('both facts survive — collapsing them would hide the infra/capability split', () => {
  // Keeping `reward` beside `counted` is what lets a reader say "this broke on
  // infrastructure but the work was right", which has a different fix from
  // "the agent got it wrong".
  const o = outcomeOf(errored('AgentTimeoutError', 1))
  assert.notEqual(o.reward, o.counted)
})

test('an ordinary pass and an ordinary failure are unaffected', () => {
  assert.deepEqual(outcomeOf(reward(1)), {
    reward: 1, errored: false, exceptionType: null, graded: true, counted: 1,
  })
  assert.deepEqual(outcomeOf(reward(0)), {
    reward: 0, errored: false, exceptionType: null, graded: true, counted: 0,
  })
  assert.equal(isCleanPass(reward(1)), true)
  assert.equal(isCleanPass(reward(0)), false)
})

test('an UNGRADED trial contributes nothing, not a zero', () => {
  // ⛔ The mirror mistake, recorded as `reference_run_that_never_happened_is_not_a_failure`:
  // 20 trials scored 0 with zero completion tokens after a revoked token, and
  // counting them as capability failures was wrong. `counted:null` keeps them
  // out of the rate; `tally` reports them separately so they are never dropped.
  const o = outcomeOf({})
  assert.equal(o.reward, null)
  assert.equal(o.graded, false)
  assert.equal(o.counted, null)
  assert.equal(isCleanPass({}), false)
})

test('any exception type errors the trial, not just the ones we have seen', () => {
  // The set of infra errors is documentation, not a filter. A new harbor error
  // type must not silently become a clean pass because it is not in a list.
  const o = outcomeOf(errored('SomeFutureHarborError', 1))
  assert.equal(o.errored, true)
  assert.equal(o.counted, 0)
  assert.ok(!INFRA_ERRORS.has('SomeFutureHarborError'))
})

test('the tally keeps pass / fail / errored / ungraded apart', () => {
  // Pooling them is how an infra tax gets published as a capability ceiling —
  // measured in this campaign, where 80 of 120 ungraded trials died on apt-get
  // in the stock install, before the agent ran.
  const t = tally([
    reward(1),
    reward(1),
    reward(0),
    errored('AgentTimeoutError', 1), // passed the verifier, still errored
    errored('UnknownApiError'), // no reward at all
    {}, // ungraded
  ])
  assert.equal(t.pass, 2)
  // The errored-but-graded trial counts as a non-pass...
  assert.equal(t.fail, 2)
  // ...and is ALSO reported as errored, so it cannot be silently dropped.
  assert.equal(t.errored, 2)
  assert.equal(t.ungraded, 2)
  assert.deepEqual(t.byError, { AgentTimeoutError: 1, UnknownApiError: 1 })
})

test('an errored trial appears in BOTH the failure count and the error count', () => {
  // Deliberate double-entry: the rate must not flatter the run, and the cause
  // must stay visible. A reader that sees only `fail` would diagnose capability.
  const t = tally([errored('AgentTimeoutError', 1)])
  assert.equal(t.pass, 0)
  assert.equal(t.fail, 1)
  assert.equal(t.errored, 1)
})

test('A PASS IS NOT SELF-JUSTIFYING WHEN THE TRIAL NEVER RAN', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: `runWasSound` opened with
  // `if (reward > 0) return true`, on the stated premise that "a pass is always
  // a real run". This is the REAL shape that refutes it —
  // `sam-cell-seg__c9CHYJ2`, 2026-09-09, whose `verifier/reward.txt` holds 1:
  const neverStarted = {
    verifier_result: null,
    agent_result: null,
    exception_info: {
      exception_type: 'RuntimeError',
      exception_message:
        'Docker compose command failed for environment. Return code: 3221225794. Stdout: None. Stderr: None.',
    },
  }
  // The container never came up (3221225794 is the Windows spawn failure this
  // campaign has already named), no agent ever executed, and the harness
  // produced NO verifier result at all — while a stale reward file said 1.
  assert.equal(runWasSound(neverStarted, 1), false)
  assert.equal(runWasSound(neverStarted, 0), false)

  // A PHANTOM PASS IS WORSE THAN A PHANTOM FAILURE, which is why this matters
  // more than the symmetric case: crediting it PROMOTES the memory, and
  // confidence_buckets ranks a clean success above everything untested.

  // The ordinary pass is untouched: it has an agent result and no exception.
  assert.equal(runWasSound({ agent_result: { n_output_tokens: 9000 } }, 1), true)
  // A timeout still counts — the agent ran and ran out of budget, which IS a
  // capability failure and the largest group in the corpus.
  assert.equal(
    runWasSound(
      {
        agent_result: { n_output_tokens: 9000 },
        exception_info: { exception_type: 'AgentTimeoutError' },
      },
      0,
    ),
    true,
  )
  // And a trial that produced zero tokens is still excluded, as before.
  assert.equal(runWasSound({ agent_result: { n_output_tokens: 0 } }, 0), false)
  // Unreadable input still fails safe towards counting it.
  assert.equal(runWasSound(null, 0), true)
  assert.equal(runWasSound({}, 0), true)
})
