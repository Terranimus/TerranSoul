#!/usr/bin/env node
/**
 * `refutation-watch.mjs` — notice that a memory has been REFUTED while the
 * sweep is still running, and act on it through MCP, with no human in the loop.
 *
 *   usage: node refutation-watch.mjs <trial-dir> [--apply] [--base DIR] [--memory ID]
 *
 * ⛔ THE GAP THIS CLOSES (H4). TWO DETECTORS ALREADY EXIST AND BOTH ARE
 * RETROSPECTIVE.
 *
 * `memory-outcome-audit.mjs` and `served-memory-audit.mjs` are read-only,
 * human-invoked CLIs that walk the finished corpus. Nothing reads a memory's
 * recent record DURING a sweep, so the only repair that has ever happened was a
 * hand recount on 2026-09-12 — six days and six graded losses after the
 * collapse was already detectable in the artefacts.
 *
 * Replayed in `started_at` order over the campaign's sound graded trials, the
 * rule below fires at the credit step of `jobs/redo09080317-20260908-031848`
 * (2026-09-07, p = 0.0083 against the live 10/11 control arm): five days and six
 * graded losses earlier, and before the 0.117-IoU loss.
 *
 * ⛔ WHAT THIS DOES **NOT** CLAIM, AND THE DISCONFIRMING DATUM. It would not
 * have saved redo09120251. That trial started ~7 minutes AFTER a hand recount
 * had already been applied: its agent was served the corrected head line, the
 * per-block GRADED stamps and the `outcome` object, read all of it, used the
 * notebook as its plan anyway and lost at IoU 0.117. So a corrected counter is
 * demonstrably not sufficient on its own. What the watch contributes is
 * TIMING AND AUTONOMY — the counters flip on the SECOND used-cohort loss with no
 * human in the loop, five days earlier than the only repair that has ever
 * happened — and the served consequence is produced by the product path (the
 * REFUTED banner the serving layer renders from those counters, plus the Stop
 * hook's refuted-read rider), never by this file. Whether that banner changes
 * behaviour is the serving workstream's measurement, not a claim made here.
 *
 * ── WHY A CONTROL ARM AND NOT A COUNTER ────────────────────────────────────
 *
 * `consecutive_failures` is a counter over the trials that were SHOWN a row. A
 * counter cannot tell "this entry is refuted" from "this task is hard", because
 * it never sees the trials that did NOT use the memory. This watch computes the
 * SAME TASK's not-used pass rate p0 and asks for the probability of the observed
 * failure streak under it:
 *
 *     p = (1 - p0)^r,  fires iff r >= minStreak AND p <= alpha
 *
 * On a task with p0 = 0.857 (12 of 14 not-used trials passed) a streak of 2 has
 * p = 0.0204 and fires. On a p0 = 0.5 task the same rule needs r = 5. On a
 * p0 = 0.3 task a 3-streak scores p = 0.343 and does NOT fire — the confound
 * guard, and the reason a bare counter would have cried wolf there.
 *
 * ── THE KEY IS USE, NOT EXPOSURE ───────────────────────────────────────────
 *
 * MEASURED: same-task USE gives 10/12 = 83.3% precision, and the two false
 * positives are both structurally unreachable by a streak test (the creating
 * trial, and the pre-streak confirmation). The unscoped served-only alternative
 * collapses to 10/19 = 52.6%, 7 of its 9 false positives being PASSING trials on
 * unrelated tasks that merely saw the row in a search result. So the treatment
 * arm is [`USED_KEYS`] — opened (`brain_get_entry`) or written
 * (`brain_ingest_lesson` / `brain_append`) — imported, never re-declared: that
 * constant IS the 30.7-point distinction.
 *
 * ── THRESHOLDS, AND WHY THESE NUMBERS ──────────────────────────────────────
 *
 *   TB_REFUTE_MIN_STREAK  default 2   consecutive used-cohort graded failures
 *   TB_REFUTE_ALPHA       default 0.05  the streak's probability under p0
 *   TB_REFUTE_MIN_BASE    default 4   not-used trials needed for a base rate
 *
 * `minStreak` is deliberately the SAME number as the product's seeded
 * `outcome.refuted.min_consecutive_failures`. The watch must never mark
 * something the serving layer will not annotate: a watch at 3 would recount rows
 * the reader is never warned about, and a watch at 1 would warn on rows the
 * product does not consider refuted.
 *
 * WINDOW CHOICE, re-measured 2026-09-12 by a PREFIX REPLAY of this file's own
 * `refutationAlarm` over the whole corpus — 2,130 sound, graded, attributable
 * trials across 89 tasks and 304 distinct used memories, as the replay reported.
 * Each (task, memory) pair is walked in `started_at` order and the control arm at
 * every step is restricted to trials that had already STARTED, so no base rate is
 * borrowed from the future:
 *
 *   window   candidate pairs   pairs with >=2 used   FIRES   post-fire exposures
 *     2            313                 123             2        7  (6 fail / 1 pass)
 *     3            313                 123             2        6  (5 fail / 1 pass)
 *     4            313                 123             1        4  (4 fail / 0 pass)
 *
 * ⛔ A CORPUS COUNT IS A READING WITH A DATE, NOT A CONSTANT, AND THE FIGURE
 * THAT USED TO SIT IN THE LINE ABOVE HAD NO DEFINITION. It said "1,968 job
 * directories" and named no primitive, so it could not be reproduced — and the
 * two shipped walkers disagree with it and with each other: re-derived
 * 2026-09-12 in this checkout, `jobsWithTask`'s walk (a directory under a `jobs*`
 * root) sees 1,992 job directories across 39 roots, while
 * `recount-outcomes.mjs`'s `collectJobDirs` (the same walk, plus a
 * `terransoul-proxy-calls.jsonl` requirement) sees 1,926. Both move with every
 * sweep and every cleanup. The denominator that the table below actually rests on
 * is the TRIAL count, which the replay reports itself; re-derive a directory count
 * from `collectJobDirs` when one is wanted rather than trusting a number in a
 * comment.
 *
 * Window 2 and window 3 find the SAME two rows (sam-cell-seg / 26809 and
 * video-processing / 26805); window 2 reaches the first of them on
 * 2026-09-07T17:18:49Z against a 10/11 control arm (p = 0.0083) and window 3
 * only on 2026-09-08T11:38:59Z. Same rows, one exposure earlier, and the single
 * post-fire PASS is the same trial under both. Window 4 loses the second row
 * entirely. That is the whole case for 2, and it costs one false-positive
 * exposure.
 *
 * ⛔ NUMBERS THAT DID NOT REPRODUCE ARE NOT KEPT. An earlier draft of this
 * header claimed 3 firing pairs out of 606 memories with 12 post-fire exposures,
 * and 10 firing pairs on the SERVED key; neither survives the replay above. On
 * the SERVED key the same replay gives 1,407 candidate pairs (495 with >= 2
 * exposures) and exactly ONE firing row with 6 post-fire exposures — the served
 * key does not fire MORE here, it multiplies the candidate population 4.5x while
 * adding nothing, and the precision case for USE rests on the 10/12 vs 10/19
 * keying measurement above, not on this replay.
 *
 * BLAST RADIUS, and the two numbers are NOT the same number. The STREAK this
 * watch fires on is computed from the same-task USED COHORT on disk — trials,
 * rewards and proxy rows — and is recomputed from scratch at every credit step.
 * `memories.consecutive_failures` is the STORE'S counter, the thing the watch
 * repairs, and it was produced by the old credit-everything-served rule. The
 * blast radius is a fact about the second: across the whole bench DB exactly ONE
 * memory has ever reached `consecutive_failures >= 2` (the same count at K = 2,
 * 3, 5 and 7), so whatever the serving layer annotates today, it annotates one
 * row. The corpus-wide prefix replay of THIS rule, whose table is above, is the
 * other half of the same picture: 313 (task, memory) candidate pairs, 123 with
 * at least two used trials, exactly two that ever fire — so the rule's reach and
 * the store's current annotation are both single-digit, and neither figure is an
 * estimate of the other.
 *
 * ── THE ACTION IS ONE MCP CALL, AND NOTHING ELSE ───────────────────────────
 *
 * With `--apply` a firing alarm calls `brain_recount_outcome` with the memory's
 * used trials folded in `started_at` order — ACROSS EVERY TASK, not just the one
 * the alarm fired on, because the store holds ONE outcome row per memory and a
 * payload built from one task's cohort would overwrite the verdicts every other
 * task earned (for memory 26809: seven passing trials on SIX unrelated tasks —
 * caffe-cifar-10 twice, per `recount-outcomes.mjs`'s measurement).
 * The alarm stays a same-task statistic; the write is per-memory, like the field
 * it writes. That tool already exists
 * (mcp/tools.rs:425-443 schema, :2978 handler, gateway.rs:5780 impl) and in ONE
 * call sets the counters, writes a `[RECOUNTED ...]` provenance line into the
 * entry's own head, saves a version snapshot and invalidates SEARCH_CACHE. So
 * the served consequence is produced entirely by the PRODUCT path — never by
 * bench-only injection into a prompt.
 *
 * Nothing else: no content rewrite, no delete, no demote, no hint. The cost of a
 * false positive is therefore one banner line, roughly 90 tokens, on a trial
 * that runs exactly as it would have.
 *
 * DRY BY DEFAULT, like every other tool here that moves ranking state: without
 * `--apply` it decides, records and prints, and calls nothing.
 *
 * ⛔ SCOPE LIMIT: ONE TASK PER JOB. The cohort is built by scanning job
 * directories for entries named `<task>__*`, and attribution falls back to the
 * whole job log only when the job holds exactly one trial. A job running several
 * trials of the same task shares one proxy log that no field can split, so those
 * trials land in `excluded` rather than in either arm — on the live corpus that
 * is 1 of 22 sam-cell-seg trials. The cross-task scan the applied recount uses
 * (`usedRowsForMemory`) applies the SAME rule and drops the same trials, so the
 * payload can never contain a trial the alarm refused to classify. `run-dg.sh`
 * produces one trial per job, which is what makes the attribution exact; a future
 * many-trials-per-job sweep would shrink both arms rather than corrupt them.
 *
 * WHAT A SWEEP CAN SEE OF THAT, precisely: the alert row carries `scanned_jobs`
 * and both arms' totals, and `stop-gate-audit.mjs` prints all three, so arms far
 * below the scan count is visible there. The `excluded` list itself is returned
 * by `cohortForMemory` and asserted by the suite; it is NOT carried into the row,
 * so the sweep summary shows the shortfall, not the per-trial reasons for it.
 *
 * PURITY. The inputs are a task directory name used as an opaque grouping key,
 * the trial's graded outcome (`outcomeOf(result).counted`, falling back to
 * `verifier/reward.txt` when the result carries no verifier row — the campaign's
 * own definition, so an errored pass counts as 0 here exactly as it does in
 * `stop-gate-audit.mjs`), the soundness flag (`agentRan`, which delegates to
 * `runWasSound`), a memory id and [`USED_KEYS`].
 * It never opens `instruction.md`, `tests/`, `solution/` or any reference
 * output; it holds no task names, no memory ids and no threshold derived from an
 * answer — every id it acts on comes from the run record
 * (`rules/bench-agi-purity.md`). It writes only through MCP, against the port
 * the caller resolved (the isolated bench brain), never to `memory.db` and never
 * to the production tray (`rules/mcp-single-source-of-truth.md`).
 */
import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { idsForTrial } from './attribute-proxy-lines.mjs'
import { agentRan } from './task-regression-audit.mjs'
import { USED_KEYS, EXPOSED_KEYS, readReward, trialBasename } from './credit-trial-outcome.mjs'
import { outcomeOf } from './trial-outcome.mjs'
import {
  foldOrderedRows,
  buildRecount,
  taskKey,
  partitionExposureWhileRefuted,
  exposureWhileRefuted,
  EXPOSED_WHILE_REFUTED,
} from './recount-outcomes.mjs'
// Re-exported so a test can assert the ONE-FOLD invariant by identity rather
// than by reading two implementations and hoping they agree.
export { foldOrderedRows } from './recount-outcomes.mjs'

/** The alert log's name, beside the trials in the job that produced it. */
export const ALERT_FILE = 'memory-refutation-alerts.jsonl'

/**
 * The thresholds, and the env vars that override them.
 *
 * Not hardcoded decisions: the numbers are documented with the table they came
 * from in this file's header and every one of them is overridable at run time
 * (`rules/brain-driven-self-improvement.md`).
 */
export const BASE_DEFAULTS = Object.freeze({ alpha: 0.05, minStreak: 2, minBase: 4 })

/**
 * The thresholds in force, after the env overrides.
 *
 * ⛔ `BASE_DEFAULTS` IS WHAT THE THRESHOLD TEST READS, and the separation is the
 * point: `DEFAULTS` is computed from the environment at import, so a test that
 * asserted against it would fail inside any sweep shell that set
 * `TB_REFUTE_MIN_STREAK` — a test whose verdict depends on who ran it measures
 * the shell, not the code.
 */
export const DEFAULTS = Object.freeze({
  alpha: numFromEnv('TB_REFUTE_ALPHA', BASE_DEFAULTS.alpha),
  minStreak: intFromEnv('TB_REFUTE_MIN_STREAK', BASE_DEFAULTS.minStreak),
  minBase: intFromEnv('TB_REFUTE_MIN_BASE', BASE_DEFAULTS.minBase),
})

function numFromEnv(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function intFromEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Memory ids under `keys` anywhere in a job's proxy log.
 *
 * The job-wide twin of `idsForTrial`, used only for the sole-trial case below.
 * `credit-trial-outcome.mjs` keeps its scanner private and hardcodes
 * [`USED_KEYS`]; this one takes the keys, which is what a control arm needs.
 */
export function jobWideIds(logText, keys) {
  const ids = new Set()
  for (const line of String(logText || '').split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let obj
    try {
      obj = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    for (const key of keys) {
      if (!Array.isArray(obj?.[key])) continue
      for (const id of obj[key]) if (Number.isInteger(id)) ids.add(id)
    }
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * Every job directory under `base` holding at least one trial of `task`, with
 * that task's trials named.
 *
 * ⛔ SCOPED ON PURPOSE, AND THE SCOPE IS THE DIFFERENCE BETWEEN A WATCH AND A
 * WEDGED MACHINE. A corpus-wide grep over the corpus's job directories (1,992 of
 * them across 39 `jobs*` roots, re-derived 2026-09-12) measured 36 s, and a
 * corpus-wide `find` over two minutes while saturating this machine's D: drive.
 * This runs at the credit step of EVERY trial, so it reads directory entries
 * only, and opens a file only under a matching trial.
 */
const SCAN_CACHE = new Map()
let SCANS = 0

/** How many directory walks have happened. Test-only; see the scan-once test. */
export function __scanCounter() {
  return SCANS
}

// ⛔ THERE IS NO CACHE-RESET EXPORT, AND THAT IS DELIBERATE. One used to live
// here, documented for "a long-lived process that outlives a sweep". No such
// process exists: every caller — `credit-trial-outcome.mjs` at the credit step,
// and this file's own `main()` — is a short-lived node process that exits before
// the next trial starts, so the cache could never be stale. An exported
// primitive with no caller is advertisement, not capability
// (`reference_advertisement_is_not_use`), and the suite now asserts its absence.
// If a resident caller ever appears, add the reset AND the caller in one change.

export function jobsWithTask(base, task) {
  // ⛔ ONE WALK PER (base, task) PER RUN. A real trial credits several memory
  // ids and the watch used to re-walk the corpus for each one — 87 ms of pure
  // directory reads over the 1,011 job directories in the main `jobs/` root (the
  // whole corpus is 1,992 across 39 roots, both re-derived 2026-09-12), on the D:
  // drive this machine already saturates, multiplied by the number of ids. The scan's answer cannot
  // change inside one credit step: the trials on disk are the same for every id.
  const key = `${base} :: ${task}`
  const cached = SCAN_CACHE.get(key)
  if (cached) return cached
  SCANS += 1
  const prefix = `${task}__`
  const out = []
  let roots
  try {
    roots = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('jobs'))
      .map((d) => join(base, d.name))
  } catch {
    SCAN_CACHE.set(key, out)
    return out
  }
  for (const root of roots) {
    let jobs
    try {
      jobs = readdirSync(root)
    } catch {
      continue
    }
    for (const job of jobs) {
      const jobDir = join(root, job)
      let entries
      try {
        if (!statSync(jobDir).isDirectory()) continue
        entries = readdirSync(jobDir)
      } catch {
        continue
      }
      const mine = entries.filter((e) => e.startsWith(prefix))
      if (!mine.length) continue
      out.push({ jobDir, trials: mine, siblingNames: entries })
    }
  }
  SCAN_CACHE.set(key, out)
  return out
}

/**
 * The ids ONE trial used, or null when its job's log cannot be attributed.
 *
 * The sole-trial case is checked first and is exact rather than a guess:
 * `run-dg.sh` runs one proxy per job, so when a job holds one trial every line
 * in that log belongs to it — including the setup calls and the deferred-write
 * flush that happens after the agent exits, both of which fall OUTSIDE the
 * agent window `idsForTrial` uses. Windowing a log that needs no splitting can
 * only lose lines, and it measurably did (`recount-outcomes.mjs`).
 *
 * Returns null — never an empty list — when attribution genuinely fails, so a
 * trial that cannot be classified lands in neither arm instead of silently
 * padding the control one.
 */
function usedIdsFor(job, trialName, keys, logText) {
  if (logText === null) return null
  const siblings = []
  for (const name of job.siblingNames) {
    const result = readJson(join(job.jobDir, name, 'result.json'))
    if (result) siblings.push({ name, result })
  }
  if (siblings.length === 1 && siblings[0].name === trialName) {
    return jobWideIds(logText, keys)
  }
  const r = idsForTrial(logText, trialName, siblings, keys)
  return r.attributed ? r.ids : null
}

/**
 * ONE trial's grade, or the reason it belongs in neither arm.
 *
 * @returns {{startedAt: number, reward: number, task: string} | {why: string}}
 *
 * ⛔ ONE DEFINITION OF "PASSED", AND IT IS THE CAMPAIGN'S. `reward.txt` is the
 * raw verifier number; `outcomeOf(...).counted` is what a trial CONTRIBUTES to a
 * pass rate, which is 0 whenever the trial errored no matter what the verifier
 * said (caffe-cifar-10 scored reward 1 after blowing the 3600 s agent cap).
 * Reading the raw number here while `stop-gate-audit.mjs` reads the counted one
 * would put two readers of the same question in the same directory at odds, and
 * it biases in the dangerous direction: an errored-but-passing trial in the
 * control arm inflates p0 and makes the alarm MORE trigger-happy. Measured on
 * this corpus the two disagree on 29 of 2,435 graded trials (1.2%) and on 0 of
 * the 25 sam-cell-seg trials, so the worked counterfactual is unchanged.
 *
 * The raw number is still what SOUNDNESS is judged on: `agentRan` uses it to
 * separate "the agent never ran" from "the agent ran and lost", and an errored
 * trial that produced a graded verdict is a non-pass, never an exclusion.
 *
 * ⛔ ONE GRADER FOR BOTH SCANS. The same-task cohort (the ALARM's control arm)
 * and the cross-task used rows (the RECOUNT's payload) call this one function,
 * so the payload can never be folded under a different notion of "passed" than
 * the arm that fired.
 */
function gradeTrial(jobDir, trialName) {
  const trialDir = join(jobDir, trialName)
  const result = readJson(join(trialDir, 'result.json'))
  const startedAt = Date.parse(result?.started_at ?? result?.agent_execution?.started_at ?? '')
  if (!Number.isFinite(startedAt)) return { why: 'no readable started_at' }
  const rawReward = readReward(trialDir)
  const o = outcomeOf(result)
  const reward = o.graded ? o.counted : rawReward
  if (reward === null) return { why: 'no graded verdict' }
  if (!agentRan(trialDir, rawReward)) return { why: 'not a fair test (the agent never ran)' }
  // Normalised at the source, exactly as `recountRows` does it: `task_name` is
  // namespaced (`terminal-bench/<task>`) and nothing else is.
  return { startedAt, reward, task: taskKey(result?.task_name ?? trialName.split('__')[0]) }
}

/**
 * The two arms, for ONE memory on ONE task, in `started_at` order.
 *
 * @returns {{used: Array, notUsed: Array, excluded: Array}} each arm's entries
 *   being `{trial, startedAt, reward}`.
 *
 * ⛔ NEVER-RAN TRIALS ARE DROPPED FROM BOTH ARMS. The zero-token 429/401 shape
 * is not a failure — the agent was never allowed to run
 * (`reference_windows_spawn_failure_is_a_first_attempt`) — and counting those
 * moves the base rate by about 10 pp, which is the whole margin the alarm reads.
 *
 * ⛔ SORTED BY `started_at`, NEVER BY DIRECTORY NAME. Job names carry a
 * timestamp but redo jobs, retries and two-worker sweeps interleave, so name
 * order and time order differ — and a streak read in the wrong order is a
 * different fact.
 */
export function cohortForMemory(base, task, memoryId, keys = USED_KEYS) {
  const used = []
  const notUsed = []
  const excluded = []
  const jobs = jobsWithTask(base, task)
  for (const job of jobs) {
    const logPath = join(job.jobDir, 'terransoul-proxy-calls.jsonl')
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : null
    for (const trialName of job.trials) {
      const graded = gradeTrial(job.jobDir, trialName)
      if (graded.why) {
        excluded.push({ trial: trialName, why: graded.why })
        continue
      }
      const ids = usedIdsFor(job, trialName, keys, logText)
      if (ids === null) {
        // A job whose log cannot be split, or has no log at all. "Did not use"
        // is not the same as "we cannot tell", and pretending otherwise would
        // pad the control arm with trials that may well have used the row.
        excluded.push({ trial: trialName, why: 'the job log cannot be attributed per trial' })
        continue
      }
      const row = { trial: trialName, startedAt: graded.startedAt, reward: graded.reward }
      if (ids.includes(memoryId)) {
        // OUTCOME-VISIBLE-6 needs to know HOW, and only for the treatment arm —
        // the control arm's trials touched the row not at all, so authorship
        // cannot arise there and the extra attribution pass is not paid for it.
        row.how = authoredMemory(job, trialName, memoryId, logText) ? 'authored' : 'read'
        used.push(row)
      } else if (exposedMemory(job, trialName, memoryId, logText)) {
        // ⛔ A `read_refuted` ROW IS NOT A CONTROL TRIAL. `EXPOSED_KEYS` is
        // deliberately outside `USED_KEYS`, so such a trial produces no used id at
        // all — and without this branch it fell straight through to `notUsed`,
        // padding the base rate with a trial that HAD been shown the refutation
        // verdict. Pushed into the treatment list and moved out by the one
        // partition below, so the proxy-marked and the fold-derived cases cannot
        // be classified by two different mechanisms.
        row.how = EXPOSED_WHILE_REFUTED
        used.push(row)
      } else notUsed.push(row)
    }
  }
  const byTime = (a, b) => a.startedAt - b.startedAt
  used.sort(byTime)
  notUsed.sort(byTime)
  // ── OUTCOME-VISIBLE-6 ──────────────────────────────────────────────────────
  //
  // ⛔ A READ THAT LANDED WHILE THE ROW WAS ALREADY REFUTED IS IN NEITHER ARM.
  // It is not treatment: since OUTCOME-VISIBLE-5 the tool surface served that
  // reader the `[REFUTED …]` verdict plus a graded index, never the construction,
  // so its verdict is not evidence about the construction. And it is not control
  // either — the trial DID see the warning, so padding `notUsed` with it would
  // move the base rate the treatment arm is judged against using a trial that
  // was partly treated.
  //
  // MEASURED 2026-09-13: `redo09130830` read quarantined 26809, authored 27007
  // and passed. Counted as treatment it cleared a 10-failure streak on a body
  // nobody had read; counted as control it would have raised p0 on the same
  // datum. It belongs in its own bucket, which is reported.
  //
  // The split is positional and therefore runs AFTER the sort, through the ONE
  // fold `recount-outcomes.mjs` owns — so the arm the alarm reads and the rows
  // the recount writes drop exactly the same trials.
  const split = partitionExposureWhileRefuted(used)
  // `scannedJobs` travels with the cohort so the alarm can tell an empty corpus
  // from an unreachable one.
  return {
    used: split.kept,
    notUsed,
    excluded,
    exposedWhileRefuted: split.exposed,
    scannedJobs: jobs.length,
  }
}

/**
 * Did this trial AUTHOR (create or append to) `memoryId`?
 *
 * The `authored` half of [`USED_KEYS`], asked separately because the two halves
 * are now credited differently: an append is still an endorsement of the entry
 * it lands in, while a read of a quarantined entry is exposure to its verdict
 * (OUTCOME-VISIBLE-6). Same attribution path as the use question, so the two
 * answers cannot come from differently-windowed views of one log.
 */
function authoredMemory(job, trialName, memoryId, logText) {
  const ids = usedIdsFor(job, trialName, ['authored'], logText)
  return Boolean(ids?.includes(memoryId))
}

/**
 * Did the proxy record this trial as having read `memoryId` WHILE IT WAS REFUTED?
 *
 * `EXPOSED_KEYS` (`read_refuted`) is written by `mcp-auth-proxy.mjs` with the
 * served bytes in hand, so it is the observation rather than a reconstruction —
 * and it is outside `USED_KEYS` by design, which is why it has to be asked for
 * separately here rather than falling out of the use question.
 */
function exposedMemory(job, trialName, memoryId, logText) {
  const ids = usedIdsFor(job, trialName, EXPOSED_KEYS, logText)
  return Boolean(ids?.includes(memoryId))
}

/**
 * Every job directory under `base`, with the trial-shaped entries it holds —
 * the cross-task twin of `jobsWithTask`.
 *
 * ⛔ UNSCOPED, AND THEREFORE ONLY EVER CALLED ON A FIRING ALARM. `jobsWithTask`
 * is scoped for cost: it runs at the credit step of EVERY trial. This one walks
 * the whole corpus (re-derived 2026-09-12: 1,992 job directories under 39 `jobs*`
 * roots in this checkout), so it is reached from exactly one place — the recount
 * an alarm has already decided to send, which over the whole replayed corpus is
 * two (task, memory) pairs (the table in this file's header). Memoised in the
 * same cache as the scoped scan, so a trial that fires on several ids walks once.
 */
export function allJobsWithTrials(base) {
  const key = `${base} :: *`
  const cached = SCAN_CACHE.get(key)
  if (cached) return cached
  SCANS += 1
  const out = []
  let roots
  try {
    roots = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('jobs'))
      .map((d) => join(base, d.name))
  } catch {
    SCAN_CACHE.set(key, out)
    return out
  }
  for (const root of roots) {
    let jobs
    try {
      jobs = readdirSync(root)
    } catch {
      continue
    }
    for (const job of jobs) {
      const jobDir = join(root, job)
      let entries
      try {
        if (!statSync(jobDir).isDirectory()) continue
        entries = readdirSync(jobDir)
      } catch {
        continue
      }
      // A trial directory is `<task>__<suffix>`; the job's own files (the proxy
      // log, the alert jsonl) carry no `__`.
      const trials = entries.filter((e) => e.includes('__'))
      if (!trials.length) continue
      out.push({ jobDir, trials, siblingNames: entries })
    }
  }
  SCAN_CACHE.set(key, out)
  return out
}

/**
 * EVERY graded trial that USED `memoryId`, across ALL tasks, in `started_at`
 * order — the rows the ledger's single row is folded from.
 *
 * @returns {Array<{trial: string, task: string, reward: number, at: number}>}
 *
 * ⛔ THE LEDGER ROW IS PER-MEMORY, NOT PER-TASK. `brain_recount_outcome` SETs
 * one row per memory (`gateway.rs`), so a payload folded from one task's cohort
 * would overwrite the verdicts every other task earned. The ALARM stays a
 * same-task statistic — that is the control arm the streak is judged against and
 * the keying the 10/12-vs-10/19 precision measurement rests on — while what is
 * WRITTEN spans every task, which is what the field it writes actually means.
 *
 * Grades come from `gradeTrial`, the same function the alarm's cohort uses, so
 * the payload cannot be folded under a different notion of "passed" than the arm
 * that fired.
 */
export function usedRowsForMemory(base, memoryId, keys = USED_KEYS) {
  const rows = []
  const needle = String(memoryId)
  for (const job of allJobsWithTrials(base)) {
    const logPath = join(job.jobDir, 'terransoul-proxy-calls.jsonl')
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : null
    // ⛔ REJECT THE JOB ON ITS LOG BEFORE OPENING ANY RESULT. Every id this
    // function can return came from a parsed line of this log, so a log that does
    // not contain the id's digits cannot yield it — and a job with no log at all
    // is unattributable, which is not "used". That turns a corpus-wide walk into
    // one file read per job plus real work only under the handful of jobs that
    // ever touched this memory (`recountRows` narrows the same way).
    if (logText === null || !logText.includes(needle)) continue
    for (const trialName of job.trials) {
      const ids = usedIdsFor(job, trialName, keys, logText)
      // null is "cannot be attributed", which is not "used" — the same rule the
      // cohort applies, and for the same reason.
      const isUsed = Boolean(ids?.includes(memoryId))
      // ⛔ EXPOSURE ROWS ARE CARRIED, NOT SKIPPED, and the difference is only
      // visible in the audit. The fold drops them either way; carrying them makes
      // `recount_scope.trials` the number of trials that TOUCHED the row and
      // `exposed_while_refuted` the number the fold refused, so a reader can see
      // why the payload is smaller instead of suspecting a lost job.
      const isExposed = !isUsed && exposedMemory(job, trialName, memoryId, logText)
      if (!isUsed && !isExposed) continue
      const graded = gradeTrial(job.jobDir, trialName)
      if (graded.why) continue
      rows.push({
        trial: trialName,
        task: graded.task,
        reward: graded.reward,
        at: graded.startedAt,
        // OUTCOME-VISIBLE-6: the fold drops a READ that landed inside an
        // existing refutation streak, so the payload has to carry which kind of
        // use this was. Absent it, `foldOrderedRows` would count a reader of the
        // quarantined index as a graded success and release the body.
        how: !isUsed
          ? EXPOSED_WHILE_REFUTED
          : authoredMemory(job, trialName, memoryId, logText)
            ? 'authored'
            : 'read',
      })
    }
  }
  rows.sort((a, b) => a.at - b.at)
  return rows
}

/**
 * The Wilson score interval for a proportion — the honest one at these sample
 * sizes, where the normal approximation puts bounds outside [0, 1].
 */
export function wilson(pass, total, z = 1.96) {
  if (!total) return { rate: null, lo: 0, hi: 1 }
  const p = pass / total
  const d = 1 + (z * z) / total
  const centre = (p + (z * z) / (2 * total)) / d
  const half = (z / d) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  return { rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

/**
 * A probability, printed so a reader can judge it.
 *
 * ⛔ `toFixed(4)` PRINTS THE INTERESTING CASE AS ZERO. The strongest alarm this
 * rule can raise is also the one it renders worst: p = (1 - p0)^r on a 0.95 base
 * rate with a 6-streak is 1.6e-8, and `toFixed(4)` makes that `0.0000` — a
 * string that reads like a rounding artefact rather than like eight orders of
 * magnitude below alpha, and one that is indistinguishable from any other tiny p
 * in the audit trail. Below 1e-3 the exponent form is the honest rendering.
 *
 * ONE FORMATTER, TWO SURFACES: the ALARM line and the recount's provenance label
 * here, and `stop-gate-audit.mjs`'s sweep summary imports this same function, so
 * the number an operator reads live and the number the audit prints later cannot
 * disagree.
 */
export function formatP(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'n/a'
  if (p === 0) return '0'
  return p < 1e-3 ? p.toExponential(2) : p.toFixed(4)
}

/**
 * Trailing consecutive graded failures in `started_at` order.
 *
 * Recency, not lifetime. An entry with a long passing history that has stopped
 * working is exactly the shape the existing lifetime-zero suspect rule cannot
 * see, and exactly the shape that cost this campaign six days.
 */
export function trailingFailureStreak(rows) {
  let r = 0
  for (let i = rows.length - 1; i >= 0 && rows[i].reward <= 0; i--) r++
  return r
}

/**
 * The decision, with everything a reader needs to re-judge it later.
 *
 * @returns {{fires, p, streak, baseRate, usedPass, usedTotal, notUsedPass,
 *   notUsedTotal, lift, reason}}
 *
 * The lift is ALWAYS computed and reported and NEVER fires anything. It is an
 * observational contrast between two self-selected groups: a lesson created on
 * date D inherits everything else that changed on date D, so the lift describes
 * an association and the streak test is what bounds the claim.
 */
export function refutationAlarm(cohort, cfg = DEFAULTS) {
  // ⛔ "I FOUND NOTHING" AND "NOBODY ELSE RAN THIS TASK" ARE DIFFERENT FACTS.
  // `run-dg.sh` honours TB_JOBS_DIR, and the scan keeps only roots whose name
  // begins with `jobs`, so a sweep pointed somewhere else yields zero roots —
  // and the alarm used to report that as "no credible base rate", the same
  // sentence it prints for a task nobody has run twice. One is a measurement and
  // the other is a misconfiguration, and a detector whose silence is
  // indistinguishable from its absence cannot be audited.
  if (cohort?.scannedJobs === 0) {
    return {
      streak: 0,
      usedPass: 0,
      usedTotal: 0,
      notUsedPass: 0,
      notUsedTotal: 0,
      lift: { value: null, used: wilson(0, 0), notUsed: wilson(0, 0) },
      fires: false,
      p: null,
      baseRate: null,
      reason: 'scanned nothing — no jobs root under the base this trial was resolved to',
    }
  }
  const used = cohort?.used ?? []
  const notUsed = cohort?.notUsed ?? []
  const usedPass = used.filter((t) => t.reward > 0).length
  const notUsedPass = notUsed.filter((t) => t.reward > 0).length
  const usedW = wilson(usedPass, used.length)
  const notUsedW = wilson(notUsedPass, notUsed.length)
  const lift = {
    value: used.length && notUsed.length ? usedW.rate - notUsedW.rate : null,
    used: usedW,
    notUsed: notUsedW,
  }
  const streak = trailingFailureStreak(used)
  const base = {
    streak,
    usedPass,
    usedTotal: used.length,
    notUsedPass,
    notUsedTotal: notUsed.length,
    lift,
  }
  if (notUsed.length < cfg.minBase) {
    // ⛔ NO CONTROL ARM, NO ALARM. Firing here would make this a restatement of
    // the streak, which is the counter it exists to replace. Reported rather
    // than thrown away, so the non-decision is auditable too.
    return { ...base, fires: false, p: null, baseRate: null, reason: 'no credible base rate' }
  }
  const p0 = notUsedPass / notUsed.length
  const p = Math.pow(1 - p0, streak)
  const fires = streak >= cfg.minStreak && p <= cfg.alpha
  return {
    ...base,
    fires,
    p,
    baseRate: p0,
    reason: fires
      ? `${streak} consecutive used-cohort failures on a task whose not-used cohort passes ${notUsedPass}/${notUsed.length}`
      : streak < cfg.minStreak
        ? `streak ${streak} below minStreak ${cfg.minStreak}`
        : `p ${formatP(p)} above alpha ${cfg.alpha}`,
  }
}

/**
 * The `brain_recount_outcome` call a firing alarm implies.
 *
 * @param {number} memoryId
 * @param {Array<{reward:number, at:number, task:string}>} usedRows EVERY used
 *   trial of this memory, across ALL tasks — `usedRowsForMemory`'s output.
 * @param {object} alarm the same-task decision, for the provenance label only.
 *
 * ⛔ CALL SITE 1 OF 2: THE LEDGER ROW IS PER-MEMORY, NOT PER-TASK. The ALARM is
 * a same-task statistic (its control arm is the same task's not-used cohort, and
 * that keying is what the 10/12-vs-10/19 precision measurement rests on), but
 * `brain_recount_outcome` SETs the memory's single global row. Folding one task's
 * cohort into it would OVERWRITE the verdicts every other task earned — for
 * memory 26809 that is seven passing trials on six unrelated tasks. So the
 * alarm decides on one task and the payload counts them all. The widening is
 * reported in the alert row's `recount_scope`, and the sweep summary prints it.
 *
 * ⛔ THE FOLD IS `recount-outcomes.mjs`'s OWN `foldOrderedRows`, NOT A COPY OF
 * IT. Two writers of one ledger field that fold differently make the counters
 * ping-pong between whichever ran last, and `consecutive_failures` is positional
 * — exactly the field that would disagree. With the scope difference removed,
 * ONE difference remains and it is stated in both headers: this passes each
 * trial's START time (the key the streak was read in), the retrospective tool
 * passes its FINISH time (it has the full result). The two orders differ only if
 * two trials of the same task overlap, which one-trial-per-job sweeps do not
 * produce.
 */
export function buildRecountAcrossTasks(memoryId, usedRows, alarm) {
  // No `{task}` scope: unscoped is the whole point — see above.
  const counts = foldOrderedRows(usedRows)
  const tasks = new Set(usedRows.map((r) => r.task)).size
  // OUTCOME-VISIBLE-6: named in the provenance label because the payload is
  // SMALLER than the row count above it, and a reader comparing the two must be
  // able to see why rather than suspect a dropped job.
  const quarantined = exposureWhileRefuted(usedRows).length
  const source =
    `refutation-watch w=${alarm.streak} p=${formatP(alarm.p)} ` +
    `(${usedRows.length} used trial(s) across ${tasks} task(s)` +
    (quarantined ? `, ${quarantined} ${EXPOSED_WHILE_REFUTED}` : '') +
    `)`
  return buildRecount(memoryId, counts, source)
}

/** The transport `credit-trial-outcome.mjs` opens, as a callable.
 *
 * ⛔ BOUNDED, BECAUSE THE DEFAULT IS FIVE MINUTES PER CALL. undici's headers
 * timeout is 300 s, and the watch runs at the END of every trial against a
 * brain the trial may have just outlived — the MCP idle watchdog has shut the
 * brain down mid-trial before (measured 2026-09-01, filter-js-from-html). A
 * brain that stops answering rather than refusing would add minutes of dead
 * wait to every remaining trial of an unattended sweep. A timeout here is
 * non-fatal by design: the trial's result.json is already written, so the watch
 * loses one recount rather than the run.
 */
export function transportFor(url, token, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.TB_MCP_HTTP_TIMEOUT_MS) || 60_000)
  const label = opts.label ?? 'refute-watch'
  const doFetch = opts.fetchImpl ?? fetch
  let rpcId = 0
  return async (params) => {
    try {
      const r = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { res: r, text: await r.text() }
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : String(e?.message ?? e)
      console.error(`[${label}] MCP call ${params?.name ?? '?'} ${why} — skipping it, not failing the trial`)
      return { res: { ok: false, status: 0 }, text: `{"error":{"message":"${why}"}}` }
    }
  }
}

/**
 * Run the watch for one finished trial.
 *
 * @param {object} o
 * @param {string} o.base      the bench directory holding the `jobs*` roots
 * @param {string} o.trialDir  the trial just credited
 * @param {number[]} o.memoryIds ids this trial used — the watch's candidates
 * @param {boolean} [o.apply]  send the recount; default false (DRY)
 * @param {Function} [o.callTool] the MCP transport, injected for testing
 *
 * ⛔ ORDERING IS LOAD-BEARING. This must run AFTER the current trial's own
 * verdict has been credited, or the window is short by one and the alarm fires a
 * trial late — which on this corpus is the difference between catching the
 * collapse and watching another loss go by.
 */
export async function runRefutationWatch({
  base,
  trialDir,
  memoryIds,
  apply = false,
  callTool = null,
  cfg = DEFAULTS,
  log = console,
}) {
  const trialName = trialBasename(trialDir)
  const task = trialName.split('__')[0]
  const jobDir = dirname(trialDir.replace(/[/\\]+$/, ''))
  const rows = []
  for (const memoryId of memoryIds ?? []) {
    if (!Number.isInteger(memoryId)) continue
    const cohort = cohortForMemory(base, task, memoryId)
    const alarm = refutationAlarm(cohort, cfg)
    let applied = false
    // What the recount actually covered — wider than the alarm's cohort, on
    // purpose, because the ledger holds ONE row per memory. Null when nothing was
    // sent, so "dry" and "applied nothing" stay distinguishable in the row.
    let recountScope = null
    if (alarm.fires && apply && callTool) {
      // ⛔ THE ONLY UNSCOPED WALK IN THIS FILE, AND IT IS BEHIND A FIRING ALARM.
      // Two rows in the campaign's whole history have ever reached this line, so
      // a corpus-wide walk here costs what the scoped one costs per trial times
      // two, ever — and it is the only way to send the per-memory ledger a number
      // that is not wrong for every other task.
      const usedRows = usedRowsForMemory(base, memoryId)
      recountScope = {
        trials: usedRows.length,
        tasks: new Set(usedRows.map((r) => r.task)).size,
        // OUTCOME-VISIBLE-6: how many of those trials the fold DROPPED as
        // exposure. `trials` is what was scanned, this is what was not counted,
        // and the difference is the thing an auditor would otherwise have to
        // re-derive from the corpus.
        exposed_while_refuted: exposureWhileRefuted(usedRows).length,
      }
      const call = buildRecountAcrossTasks(memoryId, usedRows, alarm)
      try {
        const { res, text } = await callTool(call)
        // Held to its own claim, exactly as the credit step is: a call that
        // succeeds while writing nothing is the defect class this directory
        // keeps rediscovering.
        let inner = null
        try {
          inner = JSON.parse(JSON.parse(text)?.result?.content?.[0]?.text ?? '{}')
        } catch {
          // Shape drift is itself a reason not to claim the recount landed.
        }
        applied = Boolean(res?.ok) && !String(text).includes('"isError":true') && typeof inner?.memory_id === 'number'
        if (!applied) {
          log.error?.(
            `[refute] ⚠ RECOUNT UNVERIFIED for memory ${memoryId} (${res?.status ?? '?'}): ${String(text).slice(0, 200)}`,
          )
        }
      } catch (e) {
        // A bookkeeping write must never be able to fail a measured trial.
        log.error?.(`[refute] ⚠ RECOUNT FAILED for memory ${memoryId}: ${e?.message ?? e}`)
      }
    }
    const row = {
      at: new Date().toISOString(),
      memory_id: memoryId,
      task,
      streak: alarm.streak,
      p: alarm.p,
      base_rate: alarm.baseRate,
      used: { pass: alarm.usedPass, total: alarm.usedTotal },
      not_used: { pass: alarm.notUsedPass, total: alarm.notUsedTotal },
      // OUTCOME-VISIBLE-6. In NEITHER arm: the tool surface served these trials
      // the refutation verdict and a graded index, never the construction, so
      // their grades are evidence about neither. Recorded because a cohort that
      // shrank silently is indistinguishable from a corpus that was smaller, and
      // `stop-gate-audit.mjs` prints this back.
      exposed_while_refuted: (cohort.exposedWhileRefuted ?? []).length,
      lift: alarm.lift,
      trial: trialName,
      scanned_jobs: cohort.scannedJobs,
      fires: alarm.fires,
      applied,
      // The ledger row is per-memory: this says how many tasks' verdicts the
      // recount folded, which is what makes the widening auditable rather than
      // implied. Read by `stop-gate-audit.mjs`'s REFUTATION ALARMS block.
      recount_scope: recountScope,
      reason: alarm.reason,
    }
    rows.push(row)
    // (i) EVERY decision is recorded, firing or not — a detector whose silence
    // is indistinguishable from its absence cannot be audited afterwards.
    try {
      appendFileSync(join(jobDir, ALERT_FILE), `${JSON.stringify(row)}\n`)
    } catch (e) {
      log.error?.(`[refute] ⚠ could not write ${ALERT_FILE}: ${e?.message ?? e}`)
    }
    // (ii) One line for whoever is watching the sweep's own stdout — and ONLY
    // that.
    //
    // ⛔ THE READER NAMED HERE USED TO BE FICTION. This comment said the line
    // went "into the job log `check-terransoul-used.sh` already reads". That
    // script takes `<job-dir> <proxy-log>`; its witnesses grep the PROXY log for
    // `"tool":` and `"verdict":`, and the job dir recursively for exactly
    // `"name":"mcp__terransoul__…"` — a pattern no alert row and no line printed
    // here contains. This line never reaches a file it could read anyway:
    // `run-dg.sh` prints it to the sweep's stdout. So nothing parses it at all.
    // THE JSONL ABOVE IS THE CANONICAL RECORD — `stop-gate-audit.mjs`'s
    // `readRefutationDecisions` reads every row of it and its REFUTATION ALARMS
    // block prints the applied / not-applied split, both arms, the base rate, the
    // lift and the recount's scope. A claim about a reader is a claim like any
    // other, and this one was checked against the script.
    if (alarm.fires) {
      log.log?.(
        `[refute] ALARM memory ${memoryId} on ${task}: ${alarm.streak} consecutive used-cohort ` +
          `failures, not-used base ${alarm.notUsedPass}/${alarm.notUsedTotal} = ${alarm.baseRate.toFixed(3)}, ` +
          `p = ${formatP(alarm.p)} <= ${cfg.alpha}` +
          (alarm.lift.value === null ? '' : `, exposure lift ${alarm.lift.value.toFixed(3)}`) +
          ` — ${
            applied
              ? `RECOUNTED via brain_recount_outcome over ${recountScope.trials} used trial(s) ` +
                `across ${recountScope.tasks} task(s) — the ledger row is per-memory, not per-task`
              : apply
                ? 'recount NOT confirmed'
                : 'dry run'
          }`,
      )
    } else {
      log.log?.(
        `[refute] memory ${memoryId} on ${task}: no alarm (${alarm.reason}; used ` +
          `${alarm.usedPass}/${alarm.usedTotal}, not-used ${alarm.notUsedPass}/${alarm.notUsedTotal})` +
          (row.exposed_while_refuted
            ? `, ${row.exposed_while_refuted} ${EXPOSED_WHILE_REFUTED}`
            : ''),
      )
    }
  }
  return { rows, task, trial: trialName }
}

/**
 * The CLI's own argument parse, exported so it can be tested without spawning.
 *
 * ⛔ A BOOLEAN FLAG MUST NOT SWALLOW THE TRIAL DIRECTORY. The first version
 * treated the word after ANY flag as that flag's value, so
 * `refutation-watch.mjs --apply <trial-dir>` dropped the directory and the watch
 * ran on nothing — silently, because "no memory ids" is also what a trial that
 * used no memory looks like. Only the flags that TAKE a value consume the next
 * word, and that list is written down here rather than inferred.
 */
const VALUE_FLAGS = new Set(['--base', '--memory'])

export function parseArgs(argv) {
  const out = { trialDir: null, base: null, apply: false, memory: null }
  for (let i = 0; i < (argv ?? []).length; i++) {
    const a = argv[i]
    if (a === '--apply') {
      out.apply = true
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i]
      if (a === '--base') out.base = v ?? null
      else if (Number.isInteger(Number(v))) out.memory = Number(v)
      // ⛔ A MISTYPED ID IS NOT "NO ID". Discarding it left `memory: null`, which
      // main() reads as "watch whatever this trial used" — so the operator who
      // fat-fingered an id silently watched a different set and got an answer
      // that looks exactly like a correct run. Recorded here and REFUSED there.
      else out.badMemory = v ?? null
    } else if (!a.startsWith('--') && out.trialDir === null) {
      out.trialDir = a
    }
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)
  const trialDir = parsed.trialDir
  if (!trialDir) {
    console.error('usage: refutation-watch.mjs <trial-dir> [--apply] [--base DIR] [--memory ID]')
    process.exit(2)
  }
  const base = parsed.base ?? join(dirname(trialDir.replace(/[/\\]+$/, '')), '..', '..')
  const apply = parsed.apply
  if ('badMemory' in parsed) {
    console.error(
      `[refute] --memory ${parsed.badMemory} is not a memory id — refusing rather than falling ` +
        `back to auto-discovery, which would watch a different set of ids and look like a correct run`,
    )
    process.exit(2)
  }
  let memoryIds = parsed.memory === null ? [] : [parsed.memory]
  if (!memoryIds.length) {
    // The trial's own used ids, from its job's proxy log — the same set the
    // credit step attributes to it.
    const jobDir = dirname(trialDir.replace(/[/\\]+$/, ''))
    const logPath = join(jobDir, 'terransoul-proxy-calls.jsonl')
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const task = trialBasename(trialDir).split('__')[0]
    const job = jobsWithTask(base, task).find((j) => basename(j.jobDir) === basename(jobDir))
    memoryIds = job ? (usedIdsFor(job, trialBasename(trialDir), USED_KEYS, logText) ?? []) : []
  }
  if (!memoryIds.length) {
    console.log('[refute] this trial used no memory — nothing to watch')
    return
  }
  let callTool = null
  if (apply) {
    const url = process.env.TERRANSOUL_MCP_URL
    const token = process.env.TERRANSOUL_MCP_TOKEN
    if (!url || !token) {
      console.error('[refute] TERRANSOUL_MCP_URL / TERRANSOUL_MCP_TOKEN unset — refusing to guess')
      process.exit(3)
    }
    callTool = transportFor(url, token)
  }
  await runRefutationWatch({ base, trialDir, memoryIds, apply, callTool })
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('refutation-watch.mjs')) {
  main().catch((e) => {
    console.error(`[refute] ${e?.message ?? e}`)
    process.exit(1)
  })
}
