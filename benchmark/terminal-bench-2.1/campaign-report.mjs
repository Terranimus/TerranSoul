#!/usr/bin/env node
/**
 * `campaign-report.mjs` — the honest standing of the k=1 campaign.
 *
 *   usage: node campaign-report.mjs [jobs-dir] [--tasks <dir>] [--json]
 *
 * ⛔ WHY THIS IS A TOOL AND NOT A ONE-LINER. I computed this standing by
 * ad-hoc `node -e` three times and got it wrong once, reporting 46/46 = 100%
 * where the truth was 45/46: the script read `verifier_result.rewards.reward`
 * and never looked at `exception_info`, so a trial that blew its wall-clock cap
 * and was graded anyway counted as a clean pass. `merge-sweep.sh`, which does
 * check, disagreed. An accounting that is retyped each time is an accounting
 * that drifts, so this one is written down and tested.
 *
 * THREE POPULATIONS, AND CONFLATING THEM IS THE USUAL ERROR:
 *
 *   k=1        one fresh trial per task, from the corrected-identity campaign
 *              prefixes. This is the only population that can support a k=1
 *              claim.
 *   historical passed at some point across repeated attempts. That is
 *              best-of-N, NOT k=1, and quoting it as k=1 overstates the result.
 *   unattempted never run under the TerranSoul identity at all.
 *
 * AND WITHIN k=1, THREE OUTCOMES, because pooling them publishes an
 * infrastructure tax as a capability ceiling:
 *
 *   pass        graded > 0 with no exception
 *   capability  the agent had its run and did not solve it — including
 *               AgentTimeoutError, which run-sweep.sh's measured policy calls
 *               terminal: "the AGENT ran out of time: a legitimate 0.0 that
 *               will reproduce on every attempt" (caffe-cifar-10 went
 *               42m -> 1h06 -> 1h02, never once succeeding)
 *   infra       the run broke AROUND the agent and a retry recovers it.
 *               UnknownApiError / AgentSetupTimeoutError by that same policy,
 *               plus anything that burned ZERO tokens — a run that never
 *               happened is not a failure
 *               (`reference_run_that_never_happened_is_not_a_failure`: 20
 *               trials scored 0 with zero completion tokens after a revoked
 *               token, and reading them as capability failures was wrong).
 *
 * READ-ONLY. Parses result.json files and prints. Writes nothing.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { outcomeOf } from './trial-outcome.mjs'

/**
 * Job-name prefixes of the CURRENT k=1 campaign — one fresh trial per task,
 * under one configuration.
 *
 * ⛔ ONE CONFIGURATION, NOT ALL OF THEM. The `tsb0903*` / `ts09032141w` sweep
 * ran with TB_STOP_HOOK unset, so its 66 trials had no stop gate and no
 * wall-clock guards (see `run-dg.sh`'s enforcement refusal). The `ts0904*`
 * sweep is the first with enforcement on. Pooling them would average two
 * different harnesses into one rate and call it k=1 — the same overstatement
 * as pooling best-of-N with single trials, one level up.
 *
 * So this names the ENFORCEMENT-ERA sweep only. Override with
 * TB_K1_PREFIX to report on an earlier one; the historical sweeps remain
 * readable, they are just not the current measurement.
 */
export const K1_PREFIX = new RegExp(process.env.TB_K1_PREFIX ?? '^ts0904\\d{4}w')

/** The pre-enforcement campaign, kept addressable for comparison. */
export const K1_PREFIX_PRE_ENFORCEMENT = /^(tsb0903(17|18|19|20)|ts09032141w)/

/**
 * Errors that mean the RUN broke rather than the agent failing.
 *
 * Classified by NAME because run-sweep.sh measured these two taxonomies apart
 * and acts on the distinction; not a guess about a vendor's error space.
 */
export const RETRYABLE_ERRORS = new Set(['UnknownApiError', 'AgentSetupTimeoutError'])

/**
 * Did this trial's run actually happen?
 *
 * Zero tokens is a stronger and more general signal than any error name: it
 * says the agent was never given its turn. An API 529 surfaces as a shell exit
 * 1 with `terminal_reason: "api_error"` and n_output_tokens 0 — measured on
 * rstan-to-pystan, 2026-09-04.
 */
export function neverRan(result) {
  const a = result?.agent_result
  if (!a) return false
  const inTok = a.n_input_tokens ?? 0
  const outTok = a.n_output_tokens ?? 0
  return inTok === 0 && outTok === 0
}

/** 'pass' | 'capability' | 'infra' | 'ungraded' */
export function classify(result) {
  const o = outcomeOf(result)
  if (o.counted !== null && o.counted > 0) return 'pass'
  if (neverRan(result)) return 'infra'
  if (o.exceptionType && RETRYABLE_ERRORS.has(o.exceptionType)) return 'infra'
  if (!o.graded) return o.errored ? 'infra' : 'ungraded'
  return 'capability'
}

/** Every terransoul-identity trial under a jobs dir, with its job name. */
export function collect(jobsDir) {
  const out = []
  if (!existsSync(jobsDir)) return out
  for (const job of readdirSync(jobsDir)) {
    const jobDir = join(jobsDir, job)
    let st
    try {
      st = statSync(jobDir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    for (const trial of readdirSync(jobDir)) {
      const p = join(jobDir, trial, 'result.json')
      if (!existsSync(p)) continue
      let r
      try {
        r = JSON.parse(readFileSync(p, 'utf8'))
      } catch {
        continue
      }
      if (!String(r?.agent_info?.name ?? '').includes('terransoul')) continue
      out.push({
        job,
        trial,
        task: String(r?.task_name ?? trial).replace(/^terminal-bench\//, ''),
        k1: K1_PREFIX.test(job),
        class: classify(r),
        exceptionType: r?.exception_info?.exception_type ?? null,
      })
    }
  }
  return out
}

/**
 * Roll trials up to TASKS.
 *
 * A task is a k=1 pass only when its k=1 trial passed. Deliberately NOT
 * best-of-N: taking the best across repeated attempts is exactly the
 * overstatement this file exists to prevent.
 */
export function report(rows, allTasks) {
  const k1 = new Map()
  const historical = new Set()
  for (const r of rows) {
    if (r.k1) {
      // Keep the best class per task, so a retried infra failure followed by a
      // pass reads as a pass rather than as two separate verdicts.
      const rank = { pass: 3, capability: 2, infra: 1, ungraded: 0 }
      const prev = k1.get(r.task)
      if (!prev || rank[r.class] > rank[prev.class]) k1.set(r.task, r)
    }
    if (r.class === 'pass') historical.add(r.task)
  }
  const of = (c) => [...k1.values()].filter((r) => r.class === c)
  const pass = of('pass')
  const capability = of('capability')
  const infra = of('infra')
  const measured = k1.size
  return {
    measured,
    pass: pass.length,
    capability: capability.length,
    infra: infra.length,
    ungraded: of('ungraded').length,
    rate: measured ? pass.length / measured : 0,
    // The rate a clean re-run of the infra failures could reach — stated as a
    // CEILING, never as the result, because those trials have not happened.
    ceilingAfterRetry: measured ? (pass.length + infra.length) / measured : 0,
    capabilityTasks: capability.map((r) => `${r.task}${r.exceptionType ? ` (${r.exceptionType})` : ''}`),
    infraTasks: infra.map((r) => `${r.task}${r.exceptionType ? ` (${r.exceptionType})` : ''}`),
    historicalOnly: allTasks.filter((t) => !k1.has(t) && historical.has(t)).length,
    unattempted: allTasks.filter((t) => !k1.has(t) && !historical.has(t)),
    total: allTasks.length,
  }
}

function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const ti = argv.indexOf('--tasks')
  const tasksDir = ti >= 0 ? argv[ti + 1] : 'D:/Git/terminal-bench-2-1/tasks'
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== ti + 1)
  const jobsDir = positional[0] ?? join(process.cwd(), 'jobs')

  const allTasks = existsSync(tasksDir)
    ? readdirSync(tasksDir).filter((d) => statSync(join(tasksDir, d)).isDirectory())
    : []
  const r = report(collect(jobsDir), allTasks)
  if (json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  const pct = (n) => `${(n * 100).toFixed(1)}%`
  console.log(`[campaign] ${r.total} tasks in the suite\n`)
  console.log(`  k=1 MEASURED       ${r.measured} task(s)`)
  console.log(`    pass             ${r.pass}   -> ${pct(r.rate)}`)
  console.log(`    capability fail  ${r.capability}${r.capabilityTasks.length ? '   ' + r.capabilityTasks.join(', ') : ''}`)
  console.log(`    infra (retry)    ${r.infra}${r.infraTasks.length ? '   ' + r.infraTasks.join(', ') : ''}`)
  if (r.ungraded) console.log(`    ungraded         ${r.ungraded}`)
  if (r.infra) {
    console.log(`    ceiling if the infra failures are re-run: ${pct(r.ceilingAfterRetry)} — a CEILING, not a result`)
  }
  console.log('')
  console.log(`  best-of-N only     ${r.historicalOnly} task(s) passed historically but NOT at k=1`)
  console.log(`  unattempted        ${r.unattempted.length} task(s)`)
  if (r.unattempted.length && r.unattempted.length <= 25) {
    console.log(`    ${r.unattempted.join(', ')}`)
  }
  console.log('')
  console.log(`  k=1 COVERAGE       ${r.measured}/${r.total} — the other ${r.total - r.measured} cannot support a k=1 claim`)
}

if (process.argv[1]?.endsWith('campaign-report.mjs')) main()
