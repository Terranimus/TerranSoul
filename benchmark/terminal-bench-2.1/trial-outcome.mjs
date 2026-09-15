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
 *
 * `classifyTrial` (bottom of this file) extends the same joint reading to the
 * trial's DIRECTORY — the agent's evidence of work and the verifier's own
 * output — and names exactly one outcome class per trial. The evidence readers
 * live in `trial-evidence.mjs`; the decision lives here, beside the pass
 * definition it must never contradict.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentProducedWork,
  agentOutput,
  exceptionEvidence,
  readVerifierEvidence,
  pytestSignals,
  clipEvidence,
} from './trial-evidence.mjs'

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

// ── OUTCOME CLASSES ─────────────────────────────────────────────────────────

/**
 * The seven things a finished trial can be. EXACTLY one applies.
 *
 * ⛔ WHY A CLASS, NOT ANOTHER BOOLEAN — MEASURED 2026-09-15 (workflow
 * wf_dba5b1f9-a84, critic verdict). A taxonomy of 102 "the agent's own last
 * check passed but the grader failed" trials ranked 17 proposed gates by how
 * many trials each covered. Six of the 102 had EVERY grader test passing and
 * were zeroed by AgentTimeoutError (5) or UnknownApiError (1); a seventh never
 * executed its tests ("uvx: command not found" in the verifier's own output,
 * then `reward.txt = 0`). `outcomeOf` already held the facts for the six —
 * `reward: 1, counted: 0` — but nothing turned them into a label a taxonomy
 * can filter on, so every count was polluted the same way, and
 * `campaign-report.mjs`'s `classify` still files that shape under 'capability'
 * (outcome-class.test.mjs pins the contrast).
 *
 * ⛔ ONE CLASS, ONE MEANING — MEASURED 2026-09-15 (adversarial review, 1383
 * in-scope trials). 'verifier-never-ran' held 17 trials and only ONE was a
 * verifier that failed before its tests (a tool/network failure in its own
 * output). Thirteen were agent runs cut off by ApiRateLimitError (12) or
 * UnknownApiError (1) with no grade, and three were AddTestsDirError. Meanwhile
 * 22 graded zeros under the same two cut-offs sat in 'ungraded-other'. So one
 * cause was split across two classes, and one of those classes also held a
 * different cause. The cut-offs now share one class under one rule, and
 * 'verifier-never-ran' needs evidence that the verifier started.
 *
 * THE ORDER IS THE DEFINITION, so it is written down once, here:
 *
 *   1. clean-pass                      `isCleanPass`, the campaign's pass, unchanged
 *   2. non-run                         no agent work (merge-sweep's three evidence
 *                                      sources) AND no grade or an explicit
 *                                      zero-token count
 *   3. exception-zeroed-grader-passed  reward > 0, and an exception scores it 0
 *   4. api-cutoff-ungraded             an exception in RUN_BROKE_AROUND_AGENT and
 *                                      no usable grade: a zero, or none at all
 *   5. verifier-never-ran              the verifier STARTED and failed before any
 *                                      test ran: a tool/network failure in its own
 *                                      output, no tests collected, or a harness
 *                                      exception raised in that window
 *                                      (VERIFIER_SETUP_ERRORS) with no verifier file
 *   6. capability-fail                 graded 0, tests ran, some failed, no
 *                                      exception that broke the run around the agent
 *   7. ungraded-other                  everything else, with its reason
 *
 * When result.json cannot be read at all, `classifyUnreadable` decides instead,
 * from what survives without it; it can only say clean-pass, non-run or
 * ungraded-other.
 *
 * `counted`, `isCleanPass` and `tally` are NOT changed by any of this: the
 * headline rule (errored trials score 0 and are never excluded) stands. A class
 * answers a different question — what KIND of non-pass was it — for the readers
 * that rank causes and measure a gate's reach.
 */
export const OUTCOME_CLASS = Object.freeze({
  CLEAN_PASS: 'clean-pass',
  CAPABILITY_FAIL: 'capability-fail',
  EXCEPTION_ZEROED_GRADER_PASSED: 'exception-zeroed-grader-passed',
  VERIFIER_NEVER_RAN: 'verifier-never-ran',
  API_CUTOFF_UNGRADED: 'api-cutoff-ungraded',
  NON_RUN: 'non-run',
  UNGRADED_OTHER: 'ungraded-other',
})

/**
 * Exceptions after which a graded zero says nothing about capability, because
 * the run broke AROUND the agent: the API cut-offs `runWasSound` already
 * excludes, plus a setup timeout, which `campaign-report.mjs`'s
 * RETRYABLE_ERRORS and run-sweep.sh's measured policy both treat as a retry.
 *
 * ⛔ AgentTimeoutError IS ABSENT, for the reason written on API_CUTOFFS: 35 of 43
 * errored graded zeros (2026-09-08) were the agent spending its whole budget,
 * which is a capability failure. The class says so and the reason discloses the
 * exception (`…:with-AgentTimeoutError`), so a reader can still split it out.
 */
export const RUN_BROKE_AROUND_AGENT = new Set([...API_CUTOFFS, 'AgentSetupTimeoutError'])

/**
 * Harness exceptions raised INSIDE the verifier step and BEFORE its test script
 * executes. With no verifier file on disk, one of these shows that the verifier
 * started and that no test ran.
 *
 * Read from harbor's source, not inferred from outcomes: `Verifier.verify`
 * (harbor/verifier/verifier.py) uploads the tests directory, raises
 * AddTestsDirError when that fails, and only after that executes the test
 * script. DownloadVerifierDirError and RewardFileNotFoundError are raised AFTER
 * the script ran, so they are deliberately absent: their tests may have run.
 */
export const VERIFIER_SETUP_ERRORS = new Set(['AddTestsDirError'])

/** How long result.json says the verifier phase lasted, as one evidence line. */
function verifierPhase(result) {
  const ms = (t) => Date.parse(String(t ?? '').replace(/(\.\d{3})\d+/, '$1'))
  const s = ms(result?.verifier?.started_at)
  const f = ms(result?.verifier?.finished_at)
  return Number.isFinite(s) && Number.isFinite(f)
    ? `verifier phase lasted ${((f - s) / 1000).toFixed(3)} s`
    : 'no verifier phase timing in result.json'
}

const NO_VERIFIER = Object.freeze({
  stdoutPresent: false,
  rewardTxtPresent: false,
  rewardTxt: null,
  ctrf: null,
  pytest: pytestSignals(''),
  toolFailures: [],
  outputFiles: [],
})

function testsRan(v) {
  if (v.ctrf && v.ctrf.total > 0) return true
  if ((v.pytest.collected ?? 0) > 0) return true
  const c = v.pytest.counts
  return c.passed + c.failed + c.errors > 0
}

function failedTests(v) {
  return Math.max(v.ctrf ? v.ctrf.failed : 0, v.pytest.counts.failed + v.pytest.counts.errors)
}

function describeTests(v) {
  if (v.ctrf && v.ctrf.total > 0) return `ctrf ${v.ctrf.passed}/${v.ctrf.total} passed`
  if (v.pytest.summary) return `pytest summary: ${v.pytest.summary}`
  if (v.pytest.collected !== null) return `pytest collected ${v.pytest.collected} items`
  return v.stdoutPresent ? 'verifier/test-stdout.txt has no pytest session' : 'no verifier/test-stdout.txt'
}

/**
 * The class decision over facts already read. Pure — `classifyTrial` gathers
 * the facts; this is exported so a reader holding them need not re-read disk.
 *
 * @param {{result: object|null, work?: {worked: boolean, evidence: string},
 *          verifier?: ReturnType<typeof readVerifierEvidence>|null}} facts
 * @returns {{class: string, reason: string, evidence: string[],
 *            exceptionType: string|null, reward: number|null}}
 */
export function classifyFacts({ result, work, verifier }) {
  const o = outcomeOf(result)
  const v = verifier ?? NO_VERIFIER
  const w = work ?? { worked: false, evidence: 'no agent-work evidence supplied' }
  const exc = o.exceptionType
  const excLine = exc ? `exception ${exc}: ${String(result?.exception_info?.exception_message ?? '')}` : null
  const tokens = result?.agent_result?.n_output_tokens
  const rewardLine = `verifier_result reward ${o.reward ?? 'absent'}`
  const make = (cls, reason, evidence) => ({
    class: cls,
    reason,
    evidence: evidence.filter((e) => e != null && e !== '').map(clipEvidence),
    exceptionType: exc,
    reward: o.reward,
  })
  const C = OUTCOME_CLASS

  if (isCleanPass(result)) return make(C.CLEAN_PASS, 'graded-pass-no-exception', [rewardLine, describeTests(v)])

  // A GRADED trial needs an explicit zero count to be a non-run: an ABSENT
  // count is not a count of zero, and a trial with no evidence files at all
  // must not be deleted from the capability column on absence alone — the same
  // fail-safe direction `runWasSound` takes.
  if (!w.worked && (o.reward === null || tokens === 0)) {
    return make(C.NON_RUN, 'no-output-tokens-no-agent-step', [
      w.evidence,
      `agent_result.n_output_tokens ${tokens ?? 'absent'}`,
      rewardLine,
      excLine,
    ])
  }

  if (o.reward !== null && o.reward > 0 && o.errored) {
    return make(C.EXCEPTION_ZEROED_GRADER_PASSED, `grader-passed-exception-zeroed:${exc}`, [
      rewardLine,
      describeTests(v),
      excLine,
    ])
  }

  // 4. AN API CUT-OFF WITH NO USABLE GRADE. Checked BEFORE the verifier
  // branches on purpose: the run broke around the agent first, so whatever the
  // verifier did afterwards does not name the trial (its tool failures stay in
  // the evidence). A reward.txt > 0 that result.json did not record is not
  // called unusable here; the branches below report it.
  if (
    exc &&
    RUN_BROKE_AROUND_AGENT.has(exc) &&
    (o.reward === null || o.reward === 0) &&
    !(typeof v.rewardTxt === 'number' && v.rewardTxt > 0)
  ) {
    let reason = `no-grade-under-run-breaking-exception:${exc}`
    if (o.reward === 0) reason = `graded-zero-under-run-breaking-exception:${exc}`
    else if (!v.stdoutPresent && !v.rewardTxtPresent) reason = `no-test-output-and-no-reward:after-${exc}`
    return make(C.API_CUTOFF_UNGRADED, reason, [rewardLine, describeTests(v), excLine, w.evidence, ...v.toolFailures])
  }

  const ran = testsRan(v)
  if (!ran) {
    if (v.toolFailures.length && !v.pytest.session && v.pytest.collected === null) {
      return make(C.VERIFIER_NEVER_RAN, 'tool-or-network-failure-before-tests', [
        ...v.toolFailures,
        'no pytest session banner',
        'no collected-items line',
        rewardLine,
      ])
    }
    if (v.pytest.collected === 0 || v.pytest.noTestsRan) {
      return make(C.VERIFIER_NEVER_RAN, 'no-tests-collected', [describeTests(v), rewardLine])
    }
    if (!v.stdoutPresent && o.reward === null && !v.rewardTxtPresent) {
      if (exc && VERIFIER_SETUP_ERRORS.has(exc) && !v.ctrf && !(v.outputFiles ?? []).length) {
        return make(C.VERIFIER_NEVER_RAN, 'harness-setup-before-tests', [
          excLine,
          verifierPhase(result),
          'verifier/ holds no file',
          'no reward in result.json or verifier/reward.txt',
        ])
      }
      // No verifier output, and no exception that places the failure inside the
      // verifier step: nothing shows the verifier started, so this is NOT
      // verifier-never-ran.
      return make(
        C.UNGRADED_OTHER,
        exc ? `no-test-output-and-no-reward:after-${exc}` : 'no-test-output-and-no-reward',
        ['no verifier/test-stdout.txt', 'no reward in result.json or verifier/reward.txt', excLine, w.evidence],
      )
    }
  }

  if (o.graded && o.reward === 0) {
    if (ran && failedTests(v) > 0) {
      return make(
        C.CAPABILITY_FAIL,
        exc ? `grader-ran-tests-some-failed:with-${exc}` : 'grader-ran-tests-some-failed',
        [rewardLine, describeTests(v), w.evidence, excLine],
      )
    }
    if (ran) return make(C.UNGRADED_OTHER, 'graded-zero-no-failed-test-recorded', [rewardLine, describeTests(v)])
    return make(C.UNGRADED_OTHER, 'graded-zero-without-test-evidence', [rewardLine, describeTests(v), w.evidence])
  }

  if (!o.graded) {
    if (ran) {
      return make(C.UNGRADED_OTHER, 'tests-ran-but-no-reward-recorded', [
        describeTests(v),
        v.rewardTxtPresent ? `verifier/reward.txt ${v.rewardTxt}` : 'no verifier/reward.txt',
        excLine,
      ])
    }
    return make(C.UNGRADED_OTHER, exc ? `ungraded-after-exception:${exc}` : 'ungraded-no-exception', [
      describeTests(v),
      w.evidence,
      excLine,
    ])
  }
  return make(C.UNGRADED_OTHER, 'unrecognised-reward', [rewardLine])
}

/**
 * The class of a trial whose result.json could not be read, decided from what
 * survives without it. Pure: `classifyTrial` gathers the facts.
 *
 * ⛔ THE DEFECT THIS CLOSES — MEASURED 2026-09-15 (adversarial review of this
 * layer, full corpus). classifyTrial returned 'result-json-unreadable' before
 * opening any other file of the trial. 33 in-scope trials have no result.json
 * (every one ENOENT). Two of them carry a graded pass: verifier/reward.txt 1
 * with every pytest test passing, 2/2 and 7/7. Eighteen left no agent output
 * and no verifier output at all. All 33 were filed as ungraded-other, so two
 * passes and eighteen non-runs sat in the class a reader skips.
 *
 * NEVER A GUESS. Three rules, in order:
 *
 *   1. GRADED-PASS EVIDENCE is verifier/reward.txt > 0 CORROBORATED by a test
 *      run in which no test failed. A lone reward.txt is not enough, because a
 *      stale one is a measured shape (`runWasSound`: reward.txt 1 left behind by
 *      a container that never came up). It is a clean pass only when there is
 *      no exception evidence (`exceptionEvidence`). With exception evidence it
 *      is ungraded-other, and the reason says so.
 *   2. NO AGENT OUTPUT AND NO VERIFIER OUTPUT is a non-run. Agent output is
 *      `agentOutput`, which counts the agent's raw stdout, so a run that wrote
 *      anything is never removed from the record on absence alone.
 *   3. Everything else is ungraded-other, reason 'result-json-unreadable'. That
 *      includes a graded zero: with no result.json there is nothing to say
 *      whether the run was sound, so it is never read as a capability failure.
 *
 * `reward` here is verifier/reward.txt, the only grade left to read.
 *
 * @param {{why?: string|null, agent?: {present: boolean, evidence: string},
 *          verifier?: ReturnType<typeof readVerifierEvidence>|null,
 *          exceptions?: string[]}} facts
 */
export function classifyUnreadable({ why = null, agent, verifier, exceptions = [] }) {
  const v = verifier ?? NO_VERIFIER
  const a = agent ?? { present: false, evidence: 'no agent-output evidence supplied' }
  const whyLine = `result.json unreadable${why ? `: ${why}` : ''}`
  const rewardLine = v.rewardTxtPresent ? `verifier/reward.txt ${v.rewardTxt ?? 'unparseable'}` : 'no verifier/reward.txt'
  const reward = typeof v.rewardTxt === 'number' ? v.rewardTxt : null
  const make = (cls, reason, evidence) => ({
    class: cls,
    reason,
    evidence: evidence.filter((e) => e != null && e !== '').map(clipEvidence),
    exceptionType: null,
    reward,
  })
  const C = OUTCOME_CLASS

  if (reward !== null && reward > 0 && testsRan(v) && failedTests(v) === 0) {
    if (!exceptions.length) {
      return make(C.CLEAN_PASS, 'graded-pass-no-exception:result-json-unreadable', [
        rewardLine,
        describeTests(v),
        'no exception.txt and no failed agent command in the host capture',
        a.evidence,
        whyLine,
      ])
    }
    return make(C.UNGRADED_OTHER, 'result-json-unreadable:graded-pass-with-exception-evidence', [
      rewardLine,
      describeTests(v),
      ...exceptions,
      whyLine,
    ])
  }

  const verifierFiles = v.outputFiles ?? []
  if (!a.present && !verifierFiles.length) {
    return make(C.NON_RUN, 'result-json-unreadable:no-agent-output-no-verifier-output', [
      a.evidence,
      'no non-empty file in verifier/',
      ...exceptions,
      whyLine,
    ])
  }

  return make(C.UNGRADED_OTHER, 'result-json-unreadable', [
    whyLine,
    a.evidence,
    verifierFiles.length ? `verifier/ holds ${verifierFiles.join(', ')}` : 'no non-empty file in verifier/',
    rewardLine,
    describeTests(v),
    ...exceptions,
  ])
}

/**
 * The outcome class of one finished trial.
 *
 * @param {string|{result?: object, trialDir?: string, verifierDir?: string}} input
 *   a trial directory, or a parsed result.json plus where its verifier output
 *   and agent evidence live. Reads files under that ONE trial only.
 */
export function classifyTrial(input) {
  let trialDir = null
  let result
  let verifierDir = null
  if (typeof input === 'string') {
    trialDir = input.replace(/[/\\]+$/, '')
  } else if (input && typeof input === 'object') {
    trialDir = input.trialDir ?? null
    result = input.result
    verifierDir = input.verifierDir ?? null
  }
  if (result === undefined) {
    let readError = null
    if (trialDir) {
      try {
        result = JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'))
      } catch (e) {
        readError = String(e?.message ?? e)
      }
    }
    if (result === undefined) {
      if (!trialDir) {
        return {
          class: OUTCOME_CLASS.UNGRADED_OTHER,
          reason: 'result-json-unreadable',
          evidence: [clipEvidence('no trial directory and no parsed result')],
          exceptionType: null,
          reward: null,
        }
      }
      // ⛔ NOT A SHORT-CIRCUIT: the rest of the trial still speaks (classifyUnreadable).
      return classifyUnreadable({
        why: readError,
        agent: agentOutput(trialDir),
        verifier: readVerifierEvidence(verifierDir ?? join(trialDir, 'verifier')),
        exceptions: exceptionEvidence(trialDir),
      })
    }
  }
  if (!verifierDir && trialDir) verifierDir = join(trialDir, 'verifier')
  return classifyFacts({
    result,
    work: agentProducedWork(trialDir, result),
    verifier: verifierDir ? readVerifierEvidence(verifierDir) : null,
  })
}
