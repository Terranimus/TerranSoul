#!/usr/bin/env node
/**
 * `task-regression-audit.mjs` — which tasks USED TO PASS and stopped?
 *
 *   usage: node task-regression-audit.mjs [--base <dir>] [--min-passes N] [--streak N]
 *
 * ⛔ THE GAP THIS CLOSES: A TASK CAN DIE AND NOTHING NOTICES.
 *
 * `rules/bench-never-regress.md` says every published number is a FLOOR. It is
 * enforced on the HEADLINE — and a headline is an average, so one task going
 * from reliably-passing to never-passing is worth ~1.1pp and vanishes into
 * noise, especially while other tasks are being fixed in the same window.
 *
 * MEASURED 2026-09-02 on `extract-moves-from-video`, which prompted this file.
 * Across 53 trials on disk it passed 11 times, including six consecutive job
 * dirs between 2026-08-23 and 2026-08-28. From 2026-08-29 it has failed SIX
 * times running, and no gate, sweep report or merge ever said so. I spent a
 * tick calling it a capability limit — on a task with eleven recorded passes —
 * because nothing surfaced its history and I did not think to ask for it.
 *
 * WHY PER-TASK AND NOT PER-HEADLINE: the headline moved for many reasons in
 * that window (poisoned memories purged, a wall-clock guard added, an install
 * retry). A per-task before/after split isolates the one signal a headline
 * cannot: this task was fine, and then it was not, and the date says where to
 * look.
 *
 * ⛔ IT REPORTS, IT DOES NOT DIAGNOSE. A date boundary is where to start, not a
 * cause: harness changes, memory writes and model changes all cluster in the
 * same windows. Trials are also unevenly distributed, so a task with two
 * historical passes and one recent failure is noise — hence `--min-passes`.
 *
 * READ-ONLY. Reads reward.txt and directory names; writes nothing.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { runWasSound } from './trial-outcome.mjs'

import { join, basename } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const BASE = flag('--base', 'D:/Git/TerranSoulApp/benchmark/terminal-bench-2.1')
const MIN_PASSES = Number.parseInt(flag('--min-passes', '2'), 10) || 2
const STREAK = Number.parseInt(flag('--streak', '3'), 10) || 3

/**
 * Did the AGENT actually run in this trial?
 *
 * ⛔ A RUN THAT NEVER HAPPENED IS NOT A CAPABILITY FAILURE, AND THIS FILE WAS
 * COUNTING IT AS ONE. Measured 2026-09-08: `sam-cell-seg` was reported here as
 * "13/18 passed (72%), failing 3x since 20260906, P(streak) = 2%" — a signal
 * strong enough that the next step was to bisect the three judge commits that
 * landed in that window. Two of the three trials in that streak had ~6.5 KB
 * agent logs and `agent_result.n_output_tokens = 0`:
 *
 *   api_error_status 429 — "You've hit your session limit"
 *   api_error_status 401 — "OAuth access token has been revoked"
 *
 * Neither trial ran a single turn. Excluding them leaves a 2-failure streak on
 * a ~72% task, p = 0.08 — ordinary. The regression did not exist, and three
 * innocent commits were one step from being bisected for it.
 *
 * THIS IS A DIFFERENT QUESTION FROM THE HEADLINE, deliberately. The campaign
 * rule (merge-sweep.sh SUBMISSION REQUIREMENTS) is that errored trials count as
 * reward 0 and are NEVER excluded, and that stays true: a sweep number must not
 * be flattered by dropping trials. But this file does not compute a headline.
 * It asks "did this task's CAPABILITY change", and a revoked OAuth token is not
 * an answer to that question. Same trials, two questions, two denominators.
 *
 * FAIL-SAFE TOWARDS COUNTING IT: a trial is treated as a real run unless the
 * evidence positively says otherwise, so an unreadable or older `result.json`
 * never silently deletes a genuine failure. A pass is always a real run.
 */
export function agentRan(trialDir, reward) {
  if (reward > 0) return true
  let raw
  try {
    raw = readFileSync(join(trialDir, 'result.json'), 'utf8')
  } catch {
    return true
  }
  let result
  try {
    result = JSON.parse(raw)
  } catch {
    return true
  }
  // ONE definition, in trial-outcome.mjs. A second copy here would drift, and
  // the whole point of this fix is that the rule lives where every consumer of
  // a trial outcome can reach it.
  return runWasSound(result, reward)
}

/** Every graded trial on disk, as {task, date, reward}. */
export function collectTrials(base) {
  const trials = []
  let roots = []
  try {
    roots = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('jobs'))
      .map((d) => join(base, d.name))
  } catch {
    return trials
  }
  for (const root of roots) {
    let jobs = []
    try {
      jobs = readdirSync(root)
    } catch {
      continue
    }
    for (const job of jobs) {
      const jp = join(root, job)
      try {
        if (!statSync(jp).isDirectory()) continue
      } catch {
        continue
      }
      // The job dir name carries the date: <prefix>-YYYYMMDD-HHMMSS
      const m = job.match(/-(20\d{6})-/)
      const date = m ? m[1] : null
      let entries = []
      try {
        entries = readdirSync(jp)
      } catch {
        continue
      }
      for (const t of entries) {
        const rp = join(jp, t, 'verifier', 'reward.txt')
        if (!existsSync(rp)) continue // ungraded carries no pass/fail signal
        let reward
        try {
          reward = Number(readFileSync(rp, 'utf8').trim())
        } catch {
          continue
        }
        if (!Number.isFinite(reward)) continue
        trials.push({
          task: t.split('__')[0],
          date,
          reward,
          root: basename(root),
          ran: agentRan(join(jp, t), reward),
        })
      }
    }
  }
  return trials
}

/**
 * Tasks that passed at least `minPasses` times and then failed `streak` times
 * in a row, most recent last.
 */
export function findRegressions(trials, { minPasses = 2, streak = 3 } = {}) {
  const byTask = new Map()
  for (const t of trials) {
    if (!byTask.has(t.task)) byTask.set(t.task, [])
    byTask.get(t.task).push(t)
  }
  const out = []
  for (const [task, list] of byTask) {
    // Trials where the agent never ran carry no capability signal in either
    // direction — see agentRan(). They are dropped BEFORE the base rate as well
    // as the streak, because leaving them in the denominator would depress the
    // rate and make the streak look MORE surprising than it is.
    // Undated trials cannot be ordered; keep them out of the streak logic
    // rather than guessing a position for them.
    const nonRuns = list.filter((x) => x.ran === false).length
    const dated = list.filter((x) => x.ran !== false).filter((t) => t.date).sort((a, b) => a.date.localeCompare(b.date))
    if (dated.length < minPasses + streak) continue
    const passes = dated.filter((t) => t.reward > 0)
    if (passes.length < minPasses) continue

    // Trailing failure streak.
    let tail = 0
    for (let i = dated.length - 1; i >= 0 && dated[i].reward <= 0; i--) tail++
    if (tail < streak) continue

    const lastPass = passes[passes.length - 1]

    // ⛔ A STREAK IS NOT EVIDENCE ON ITS OWN, AND THIS TOOL SAID IT WAS.
    //
    // The first version reported any trailing failure streak. It flagged
    // mteb-retrieve — 3 passes in 30 trials, a ~10% task — as a regression on
    // an 11-failure streak. Under its OWN base rate that streak has
    // probability 0.9^11 = 31%: entirely ordinary. Reporting it as a
    // regression sent me looking for a cause that need not exist, which is the
    // "cry wolf" failure this campaign keeps re-learning.
    //
    // So report the probability of the observed streak given the task's
    // historical rate, and let the reader weigh it. A low-base-rate task needs
    // a very long streak before it means anything; a task that passed 11 of 33
    // does not.
    //
    // Even this is only a prior. extract-moves-from-video scored 4% here — not
    // damning by itself — and was nonetheless a REAL regression, proven by a
    // controlled A/B that traced it to this harness's own deadline stop. The
    // statistic ranks candidates; a counterfactual run settles them.
    const rate = passes.length / dated.length
    const streakProbability = Math.pow(1 - rate, tail)

    out.push({
      task,
      passes: passes.length,
      total: dated.length,
      failingSince: dated[dated.length - tail].date,
      lastPassDate: lastPass.date,
      streak: tail,
      nonRuns,
      rate,
      streakProbability,
    })
  }
  return out.sort((a, b) => b.streak - a.streak || b.passes - a.passes)
}

if (process.argv[1]?.endsWith('task-regression-audit.mjs')) {
  const trials = collectTrials(BASE)
  const regressions = findRegressions(trials, { minPasses: MIN_PASSES, streak: STREAK })
  console.log(`graded trials scanned : ${trials.length}`)
  console.log(`distinct tasks        : ${new Set(trials.map((t) => t.task)).size}`)
  console.log('')
  console.log(`REGRESSED — passed >= ${MIN_PASSES}x, now failing >= ${STREAK}x in a row:`)
  if (!regressions.length) console.log('  none')
  for (const r of regressions) {
    const pct = (100 * r.streakProbability).toFixed(0)
    const weight = r.streakProbability > 0.15 ? '  [LIKELY NOISE]' : ''
    console.log(
      `  ${r.task.padEnd(32)} ${r.passes}/${r.total} passed (${(100 * r.rate).toFixed(0)}%), ` +
        `last pass ${r.lastPassDate}, failing ${r.streak}x since ${r.failingSince}`,
    )
    console.log(
      `      P(streak | own base rate) = ${pct}% ${weight}`,
    )
    // NO SILENT CAPS: if trials were dropped, say so on the same row. A rate
    // computed over a filtered denominator that does not announce the filter
    // reads as "this is every trial", which is how the excluded ones become
    // invisible a second time.
    if (r.nonRuns) {
      console.log(
        `      (${r.nonRuns} trial(s) excluded: the agent never ran — zero output tokens)`,
      )
    }
  }
  console.log('')
  console.log('A date boundary is WHERE TO LOOK, not a cause — harness changes, memory')
  console.log('writes and model changes cluster in the same windows.')
  console.log('')
  console.log('And a STREAK IS NOT EVIDENCE on its own: a 10% task failing 11 times running')
  console.log('is ordinary. Weigh P(streak) above, then settle it with a counterfactual run —')
  console.log('extract-moves-from-video scored only 4% here and WAS a real regression.')
}
