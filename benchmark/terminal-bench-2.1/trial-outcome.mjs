/**
 * `trial-outcome.mjs` — ONE place that decides what a trial's outcome was.
 *
 * ⛔ THE DEFECT THIS CLOSES: A TRIAL CAN BE BOTH PASSING AND ERRORED, AND
 * READING ONLY `reward` COUNTS IT AS A CLEAN PASS.
 *
 * MEASURED 2026-09-03 on `caffe-cifar-10`:
 *
 *     verifier_result.rewards.reward = 1
 *     exception_info.exception_type  = "AgentTimeoutError"
 *                                      ("timed out after 3600.0 seconds")
 *
 * The agent exceeded the harness's own one-hour cap; harbor then ran the
 * verifier against whatever was on disk, and it passed. Both facts are true,
 * and a reader that stops at `reward` records a clean success for a run that
 * broke the time limit.
 *
 * That is not a hypothetical: an ad-hoc accounting script reported the campaign
 * as 46/46 = 100% at k=1 while `merge-sweep.sh` — which does check
 * `exception_info` — reported 45 of 46. The rule this campaign runs under is
 * explicit (rules/, and merge-sweep.sh's own SUBMISSION REQUIREMENTS block):
 * errored trials count as reward 0 and are NEVER excluded. So the honest figure
 * was 45/46, and the difference was one field.
 *
 * The lesson generalises past this field: `reference_run_that_never_happened_is_not_a_failure`
 * records the mirror case, where 20 trials scored 0 with zero completion tokens
 * after a revoked token, and counting them as capability failures was equally
 * wrong. A trial's outcome is a JOINT reading of what the grader said and
 * whether the run was sound. Neither field alone is the answer, so neither is
 * read alone here.
 */

/** Errors that mean the RUN broke, not that the agent was wrong. */
export const INFRA_ERRORS = new Set([
  'AgentTimeoutError',
  'UnknownApiError',
  'NonZeroAgentExitCodeError',
])

/**
 * Exception types that mean the API stopped the run, not that the agent was
 * wrong.
 *
 * ⛔ AgentTimeoutError IS DELIBERATELY ABSENT. MEASURED 2026-09-08 over all 355
 * graded-zero trials on disk: 40 never ran (zero output tokens), and 43 more
 * carried an exception — but 35 of those 43 were AgentTimeoutError, which means
 * the agent spent its whole budget and did not finish. That is exactly a
 * capability failure. Excluding all 43 "because they errored" would have moved
 * 35 real failures off the books and felt like rigour.
 */
export const API_CUTOFFS = new Set([
  'UnknownApiError',
  'ApiRateLimitError',
  'ApiInternalServerError',
])

/**
 * Did this trial give the agent a fair run? A trial that never started, or that
 * the API cut off mid-flight, carries no signal about capability IN EITHER
 * DIRECTION — it must not be read as a failure, and it must not be credited as
 * one against the memories that were served to it.
 *
 * ⛔ THIS IS A DIFFERENT QUESTION FROM `outcomeOf().counted`, ON PURPOSE. The
 * campaign rule (merge-sweep.sh SUBMISSION REQUIREMENTS) is that errored trials
 * count as reward 0 and are NEVER excluded, because a published number must not
 * be flattered by dropping trials. `counted` implements that and stays as it is.
 * This predicate answers "was this a fair test of the agent", which is the right
 * question for a regression audit and for outcome crediting, and the wrong one
 * for a headline. Same trials, two questions, two denominators.
 *
 * FAILS SAFE TOWARDS COUNTING IT: anything unreadable, unparsable or missing the
 * field reads as a real run, so this can never silently delete a genuine
 * failure.
 *
 * ⛔ "A PASS IS ALWAYS A REAL RUN" WAS FALSE, AND ONE TRIAL PROVED IT.
 * MEASURED 2026-09-12 on `sam-cell-seg__c9CHYJ2`: `verifier/reward.txt` holds
 * `1`, while the trial's own `result.json` records `verifier_result: null`,
 * `agent_result: null`, and a RuntimeError — "Docker compose command failed …
 * Return code: 3221225794", the Windows spawn failure this campaign has already
 * named (the process never ran). The container never came up, no agent ever
 * executed, the verifier produced nothing, and a stale `reward.txt` said it
 * passed. Every other trial of that task has `reward.txt` and `verifier_result`
 * in agreement; this is the only one where they contradict.
 *
 * So the reward short-circuit now comes SECOND. When the harness recorded no
 * agent result at all AND an exception, nothing ran — and a phantom pass is
 * more dangerous than a phantom failure, because it PROMOTES a memory
 * (`confidence_buckets` ranks a clean success above everything untested).
 */
export function runWasSound(result, reward = null) {
  if (result && result.agent_result == null && result.exception_info != null) return false
  if (typeof reward === 'number' && reward > 0) return true
  const out = result?.agent_result?.n_output_tokens
  if (typeof out === 'number' && out === 0) return false
  return !API_CUTOFFS.has(result?.exception_info?.exception_type)
}

/**
 * @param {object} result a trial's parsed `result.json`
 * @returns {{reward: number|null, errored: boolean, exceptionType: string|null,
 *            counted: number|null, graded: boolean}}
 *
 * `counted` is the number this trial contributes to a pass rate: the graded
 * reward normally, and 0 when the trial errored no matter what the verifier
 * said. `reward` is kept alongside it deliberately — collapsing them would hide
 * that a trial both passed and broke, which is the only way to tell an
 * infrastructure problem from a capability one.
 */
export function outcomeOf(result) {
  const raw = result?.verifier_result?.rewards?.reward
  const reward = typeof raw === 'number' ? raw : null
  const exceptionType = result?.exception_info?.exception_type ?? null
  const errored = Boolean(exceptionType)
  return {
    reward,
    errored,
    exceptionType,
    // An ungraded trial contributes nothing rather than a zero: it is an
    // infrastructure failure, and scoring it as a capability failure is the
    // mirror mistake to the one above.
    graded: reward !== null,
    counted: reward === null ? null : errored ? 0 : reward,
  }
}

/** True when the trial passed AND the run was sound — the only clean success. */
export function isCleanPass(result) {
  const o = outcomeOf(result)
  return o.counted !== null && o.counted > 0
}

/**
 * Split a set of trials into the three categories any honest report needs.
 *
 * Kept separate rather than folded into one rate, because "passed", "failed on
 * capability" and "broke on infrastructure" have three different fixes and
 * pooling them is how an infra tax gets reported as a capability ceiling.
 */
export function tally(results) {
  const t = { pass: 0, fail: 0, errored: 0, ungraded: 0, byError: {} }
  for (const r of results) {
    const o = outcomeOf(r)
    if (o.errored) {
      t.errored++
      t.byError[o.exceptionType] = (t.byError[o.exceptionType] ?? 0) + 1
      // An errored trial is still counted as a non-pass in the rate below; it is
      // reported separately as well so it is never silently dropped.
      if (o.graded) t.fail++
      else t.ungraded++
      continue
    }
    if (!o.graded) t.ungraded++
    else if (o.counted > 0) t.pass++
    else t.fail++
  }
  return t
}
