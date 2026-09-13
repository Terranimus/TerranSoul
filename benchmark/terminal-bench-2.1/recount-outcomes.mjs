#!/usr/bin/env node
/**
 * `recount-outcomes.mjs` — recompute ONE memory's graded-outcome counters from
 * the artefacts, and write the answer back through MCP.
 *
 *   usage: node recount-outcomes.mjs <memory-id> [--apply] [--root DIR]
 *          [--source LABEL] [--task NAME]
 *
 * `--task NAME` scopes the fold to one task, matched on the BARE task name
 * (`taskKey`) so the namespaced `terminal-bench/<task>` in `result.json` and the
 * bare name the watch prints both select the same cohort. A scope that selects
 * no rows REFUSES (exit 6) instead of recounting to zero.
 *
 * ⛔ THE DEFECT THIS REPAIRS: A WRONG CREDITING RULE CANNOT BE FIXED BY MORE
 * CREDITING.
 *
 * Until OUTCOME-VISIBLE-2 the bench credited every memory a trial had been
 * SHOWN — every row of every `brain_search` result — with that trial's graded
 * outcome. `credit-trial-outcome.mjs` now credits only what a trial USED
 * (opened via `brain_get_entry`, or written via `brain_ingest_lesson` /
 * `brain_append`), but the counters already in the store were produced by the
 * old rule, and every increment it made is wrong. No sequence of further
 * increments reaches the right number; the only honest repair is to recompute
 * from the artefacts and SET the result.
 *
 * MEASURED 2026-09-12 on memory 26809, a MobileSAM notebook. Nineteen trials
 * touched it. Twelve were its own task: 3 passes and 9 failures, every one of
 * which authored it. The other seven belonged to unrelated tasks
 * (caffe-cifar-10 twice, mteb-retrieve, bn-fit-modify, video-processing,
 * winning-avg-corewars, pytorch-model-cli); all seven passed and all seven had
 * merely seen the row in a search result. The stored ledger read 9 successes /
 * 6 failures, so the agent reading it was told the entry was mostly working —
 * when on its own task it is 3 of 12 with four consecutive failures, i.e.
 * REFUTED under the rule the server instructions state.
 *
 * ORDER MATTERS AND IS THE REASON THIS IS NOT A GROUP-BY. `consecutive_failures`
 * and `last_outcome` are positional facts: they depend on the SEQUENCE of
 * graded results, not their totals. Trials are therefore sorted by when they
 * finished before the counters are folded.
 *
 * DRY BY DEFAULT, like every other tool in this directory that mutates ranking
 * state.
 *
 * ── OUTCOME-VISIBLE-6: A READ OF A REFUTED ENTRY IS EXPOSURE, NOT USE ────────
 *
 * ⛔ THE DEFECT: A SUCCESS EARNED BY A READER WHO WAS NEVER SHOWN THE BODY
 * RELEASED THE BODY.
 *
 * Since OUTCOME-VISIBLE-5 a refuted entry's text is QUARANTINED on every tool
 * surface: `brain_search` and `brain_get_entry` return the `[REFUTED …]` verdict
 * plus a graded index of the entry's own update blocks, and no call returns the
 * construction itself. So a trial that opens a refuted memory receives a
 * WARNING and a table of contents — not the advice.
 *
 * MEASURED 2026-09-13. Entry 26809 was refuted (10 consecutive graded failures)
 * and quarantined. Trial `redo09130830` read it, got the quarantined view,
 * authored 27007 and PASSED 9/9. `credit-trial-outcome.mjs` then logged
 * `[credit] reward=1 -> success for 2 used memories: 26809, 27007`, because USED
 * was `authored ∪ read` — so 26809 went to graded_successes 3 /
 * consecutive_failures 0 / last_outcome success, `MemoryOutcome::is_refuted`
 * answered no, and the brain served the full body again.
 *
 * That is a loop, not a repair: release → the next reader builds from the body →
 * loses twice → re-quarantined → a reader of the index passes → released again.
 * The reader that released it had never seen the construction it was crediting.
 *
 * THE RULE, folded here and applied by every consumer: a read of a memory that
 * was REFUTED AT THE TIME OF THE READ credits NEITHER success nor failure to
 * that memory. It is reported as `exposed-while-refuted` with the id. Authored
 * appends are unaffected — an author who appends to a refuted entry is still
 * crediting it (though OUTCOME-VISIBLE-3's banner tells authors to record a NEW
 * entry instead, which is what 27007 is).
 *
 * ⛔ CONSEQUENCE, AND IT IS THE POINT: A REFUTED ENTRY IS RELEASED ONLY BY A
 * GRADED SUCCESS CREDITED THROUGH AUTHORSHIP — somebody appended to it and
 * passed — OR BY AN EXPLICIT RECOUNT (this tool, with `--apply`). Nothing a
 * reader of the quarantined index can do will hand the body back.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { idsForTrial } from './attribute-proxy-lines.mjs'
import { runWasSound } from './trial-outcome.mjs'
import {
  readReward,
  trialWindow,
  usedMemoryIds,
  servedMemoryIds,
  exposedWhileRefutedIds,
  USED_KEYS,
  EXPOSED_KEYS,
} from './credit-trial-outcome.mjs'

/**
 * The label every surface prints for a read that happened while the memory was
 * already refuted. One string, so the credit log, this tool, the watch's alert
 * rows and the sweep audit cannot name the same fact three ways.
 */
export const EXPOSED_WHILE_REFUTED = 'exposed-while-refuted'

/**
 * What the compiled serving layer falls back to when the store carries no
 * `outcome.refuted.min_consecutive_failures` row
 * (`crates/memory/src/outcome_stamp.rs::RefutationConfig::default`).
 */
export const REFUTATION_THRESHOLD_FALLBACK = 2

let THRESHOLD_CACHE = null

/**
 * The refutation threshold THE SERVING LAYER USES, read from the product's own
 * seeded config row.
 *
 * ⛔ NOT A CONSTANT IN THIS FILE, AND THE COUPLING IS THE WHOLE POINT. This fold
 * decides which rows are exposure rather than use, and "exposure" means exactly
 * "the reader got the `[REFUTED …]` verdict and the quarantined index instead of
 * the body". That is a property of the SERVING layer, whose threshold is a
 * seeded `memories` row — the same row `refutation-watch.test.mjs`'s
 * `the_watch_threshold_is_READ_FROM_the_products_seeded_refutation_rule` reads.
 * A number written here instead would let the harness drop rows the product
 * still serves in full (or count rows it quarantines), which is the same
 * label-contradicts-the-bytes defect the whole OUTCOME-VISIBLE line exists to
 * close.
 *
 * A non-positive seeded value means the annotation is OFF
 * (`render_served_content` reads it that way before the predicate ever runs), so
 * nothing is exposure and every read counts — which is what this fold then does,
 * because `partitionExposureWhileRefuted` guards on `threshold > 0`.
 *
 * Memoised: the fold runs per memory per trial and the seed is a 7 MB file.
 */
export function seededRefutationThreshold(seedPath = null) {
  if (seedPath === null && THRESHOLD_CACHE !== null) return THRESHOLD_CACHE
  const path =
    seedPath ?? join(import.meta.dirname, '..', '..', 'mcp-data', 'shared', 'seed-config.sql')
  let value = REFUTATION_THRESHOLD_FALLBACK
  try {
    const m = readFileSync(path, 'utf8').match(
      /outcome\.refuted\.min_consecutive_failures\s*\|\s*(-?\d+)\s*\|/,
    )
    if (m) value = Number(m[1])
  } catch {
    // An unreadable seed keeps the compiled fallback, exactly as the product
    // does — a harness that refused here would be unrunnable outside a checkout.
  }
  if (seedPath === null) THRESHOLD_CACHE = value
  return value
}

/**
 * Split rows THAT ARE ALREADY IN ORDER into the ones the fold counts and the
 * ones that are EXPOSURE — a READ that landed while the running streak had
 * already reached the refutation threshold.
 *
 * @param {Array<{reward:number, how?:string}>} orderedRows
 * @returns {{kept: object[], exposed: object[]}}
 *
 * ⛔ THE STREAK IS THE RUNNING ONE, NOT THE FINAL ONE. "Refuted at the time of
 * the read" is a positional fact about the prefix of the history that existed
 * when that trial ran; the final counters cannot answer it. So this walks and
 * carries the streak, and an exposure row neither counts nor advances it — it is
 * not evidence about the construction in either direction.
 *
 * ⛔ A ROW WITH NO `how` IS COUNTED. Only callers that can distinguish authorship
 * set it (`recountRows`, `cohortForMemory`, `usedRowsForMemory`); a row whose
 * provenance is unknown is not evidence of a read, and dropping it would delete
 * real verdicts on a guess. The two directions are not symmetric: a miscounted
 * row is visible in the printed table, a silently deleted one is not.
 *
 * ⛔ AND `how === EXPOSED_WHILE_REFUTED` IS EXPOSURE UNCONDITIONALLY, streak or
 * no streak. That value comes from the proxy's own `read_refuted` row, written
 * with the served bytes in hand: the brain HAD the refutation banner on that
 * view, whatever this corpus's artefacts reconstruct. The two can legitimately
 * disagree — the ledger counts trials from every corpus, this fold sees the jobs
 * on one disk — and where they do, the row that observed the actual response
 * wins. Deriving it from the streak instead would silently re-credit a read the
 * brain had already quarantined.
 */
export function partitionExposureWhileRefuted(
  orderedRows,
  threshold = seededRefutationThreshold(),
) {
  const kept = []
  const exposed = []
  let streak = 0
  for (const r of orderedRows ?? []) {
    const observed = r?.how === EXPOSED_WHILE_REFUTED
    const derived = r?.how === 'read' && threshold > 0 && streak >= threshold
    if (observed || derived) {
      exposed.push(r)
      continue
    }
    kept.push(r)
    if (r?.reward > 0) streak = 0
    else streak += 1
  }
  return { kept, exposed }
}

/**
 * Every job directory under `root` that carries a proxy log — the ones whose
 * parent is named with the `jobs` prefix this campaign uses.
 *
 * (The glob is described in words on purpose: written literally it contains a
 * comment-closing sequence and would end this block early, which is exactly
 * how the first version of `credit-trial-outcome.mjs` failed to parse.)
 */
export function collectJobDirs(root) {
  const out = []
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries) {
    if (!name.startsWith('jobs')) continue
    const jobsRoot = join(root, name)
    let jobs
    try {
      if (!statSync(jobsRoot).isDirectory()) continue
      jobs = readdirSync(jobsRoot)
    } catch {
      continue
    }
    for (const job of jobs) {
      const dir = join(jobsRoot, job)
      const log = join(dir, 'terransoul-proxy-calls.jsonl')
      try {
        if (statSync(dir).isDirectory() && existsSync(log)) out.push(dir)
      } catch {
        // A directory that vanished mid-walk is not an error worth aborting on.
      }
    }
  }
  return out
}

/** One job read off disk as `{logText, trials}` — the shape `recountRows` takes. */
export function readJob(jobDir) {
  const logPath = join(jobDir, 'terransoul-proxy-calls.jsonl')
  let logText
  try {
    logText = readFileSync(logPath, 'utf8')
  } catch {
    return null
  }
  const trials = []
  let entries
  try {
    entries = readdirSync(jobDir)
  } catch {
    return null
  }
  for (const name of entries) {
    const dir = join(jobDir, name)
    const resultPath = join(dir, 'result.json')
    try {
      if (!statSync(dir).isDirectory() || !existsSync(resultPath)) continue
      trials.push({
        name,
        dir,
        result: JSON.parse(readFileSync(resultPath, 'utf8')),
        reward: readReward(dir),
      })
    } catch {
      // A trial killed mid-write carries no usable verdict; skip it rather than
      // abandoning the whole job.
    }
  }
  return { job: jobDir, logText, trials }
}

/**
 * Ids attributable to ONE trial, by window — or, when the job holds exactly one
 * trial, the whole log.
 *
 * ⛔ WHY THE SOLE-TRIAL CASE IS EXACT RATHER THAN A GUESS. `idsForTrial`
 * refuses whenever it cannot bound a trial's window, because its normal job is
 * to SPLIT a log shared by several trials. A job with one trial has nothing to
 * split: `run-dg.sh` runs one proxy per job, so every line in that log — the
 * setup calls, the agent's calls, and the deferred-write flush that happens
 * after the agent exits — belongs to that trial and to nothing else.
 *
 * MEASURED 2026-09-12: three single-trial jobs were dropped entirely because
 * their trial had no readable `agent_execution` window (the container failed to
 * start, or the API cut the run off), which meant they vanished from the recount
 * INSTEAD OF appearing in its excluded list with a reason. Silence is the one
 * outcome a forensic tool must never produce.
 *
 * Returns null when the log genuinely cannot be attributed.
 */
function attribute(job, trial, siblings, keys, jobWide) {
  // The sole-trial case is checked FIRST, not as a fallback. Windowing a log
  // that needs no splitting can only LOSE lines, and it silently did: all three
  // trials below produced calls OUTSIDE their own recorded window — two whose
  // container died and were retried, one whose proxy traffic belongs to an
  // earlier attempt of the same job. `idsForTrial` reported `attributed: true`
  // with an EMPTY id list, so they were neither counted nor excluded nor
  // exposed. They simply were not there.
  if (job.trials.length === 1 && job.trials[0].name === trial.name) {
    return { ids: jobWide(job.logText), via: 'sole-trial' }
  }
  const r = idsForTrial(job.logText, trial.name, siblings, keys)
  if (r.attributed) return { ids: r.ids, via: 'window' }
  return null
}

/** Job-wide authored ids, for the sole-trial path. */
function authoredJobWide(logText) {
  const ids = new Set()
  for (const line of String(logText || '').split(String.fromCharCode(10))) {
    const b = line.indexOf('{')
    if (b < 0) continue
    let o
    try {
      o = JSON.parse(line.slice(b))
    } catch {
      continue
    }
    if (Array.isArray(o?.authored)) for (const id of o.authored) if (Number.isInteger(id)) ids.add(id)
  }
  return [...ids]
}

/**
 * Every graded row this memory earned, across all jobs, in trial order.
 *
 * @returns {{rows: object[], exposed: object[], skipped: object[]}}
 *   `rows`     — trials that USED the memory and produced a fair verdict.
 *   `exposed`  — trials that were shown it and never opened or wrote it. Never
 *                counted; reported so the narrowing stays visible.
 *   `skipped`  — trials excluded with the reason (not a fair test, no verdict,
 *                or a job whose log cannot be split per trial).
 */
export function recountRows(jobs, memoryId) {
  const rows = []
  const exposed = []
  const skipped = []
  for (const job of jobs) {
    if (!job) continue
    const siblings = job.trials.map((t) => ({ name: t.name, result: t.result }))
    for (const trial of job.trials) {
      const used = attribute(job, trial, siblings, USED_KEYS, usedMemoryIds)
      const served = attribute(job, trial, siblings, ['served'], servedMemoryIds)
      // ⛔ AN UNATTRIBUTABLE JOB IS EXCLUDED, NOT GUESSED AT. Concurrent trials
      // share one proxy log and no property of the log can separate them; a
      // union here would rebuild the very over-attribution being repaired.
      if (!used) {
        if (job.logText.includes(String(memoryId))) {
          skipped.push({ trial: trial.name, why: 'the job log cannot be split per trial' })
        }
        continue
      }
      const isUsed = used.ids.includes(memoryId)
      const isServed = served ? served.ids.includes(memoryId) : false
      // ⛔ OUTCOME-VISIBLE-6. `read_refuted` is outside `USED_KEYS`, so a trial
      // that OPENED a quarantined entry produces no used id — and would otherwise
      // land in `exposed` ("shown, never opened"), which is a different fact. It
      // becomes a row labelled `exposed-while-refuted`: named in the table,
      // totalled in the disclosure, and dropped by the fold.
      const refutedRead = attribute(job, trial, siblings, EXPOSED_KEYS, exposedWhileRefutedIds)
      const isExposedRefuted = !isUsed && Boolean(refutedRead?.ids.includes(memoryId))
      if (!isUsed && !isExposedRefuted) {
        if (isServed) exposed.push({ trial: trial.name, reward: trial.reward })
        continue
      }
      if (trial.reward === null) {
        skipped.push({ trial: trial.name, why: 'no graded verdict' })
        continue
      }
      if (!runWasSound(trial.result, trial.reward)) {
        skipped.push({
          trial: trial.name,
          why: `not a fair test (${trial.result?.exception_info?.exception_type ?? 'the agent never ran'})`,
        })
        continue
      }
      const window = trialWindow(trial.result)
      const authored = attribute(job, trial, siblings, ['authored'], (t) =>
        usedMemoryIds(t).filter((id) => authoredJobWide(t).includes(id)),
      )
      rows.push({
        trial: trial.name,
        // Normalised at the source: every consumer of a row's `task` — this
        // tool's own scope, the watch's cohort key, the printed table — then
        // reads the same spelling.
        task: taskKey(trial.result?.task_name ?? trial.name.split('__')[0]),
        reward: trial.reward,
        how: isExposedRefuted
          ? EXPOSED_WHILE_REFUTED
          : authored && authored.ids.includes(memoryId)
            ? 'authored'
            : 'read',
        via: (isExposedRefuted ? refutedRead?.via : used.via) ?? used.via,
        at: window?.to_ms ?? null,
      })
    }
  }
  // Positional, not aggregate: the streak and the last verdict depend on the
  // sequence. A row with no readable window sorts last rather than first, so a
  // missing timestamp can never masquerade as the oldest evidence.
  rows.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER))
  return { rows, exposed, skipped }
}

/**
 * A task's BARE key — the last path segment of whatever the run record spells.
 *
 * ⛔ `task_name` IS NAMESPACED AND NOTHING ELSE IS. A real `result.json` carries
 * `task_name: "terminal-bench/sam-cell-seg"`, while the trial directory, the
 * online watch's cohort key (`trialName.split("__")[0]`), its `[refute] ALARM`
 * line and its alert row's `task` field all carry the bare `sam-cell-seg`. A
 * strict-equality scope on the raw field therefore matched nothing for the one
 * value an operator would ever type, folded to a perfectly self-consistent
 * 0/0/0 — which the gateway's contradiction guard cannot refuse — and with
 * `--apply` would have written that over the very refutation this tool exists to
 * record. Normalised where the row is BUILT and again on both sides of the
 * filter, so either spelling names the same scope.
 */
export function taskKey(name) {
  const parts = String(name ?? '')
    .split('/')
    .filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * THE ONE FOLD. Scope, order, then count.
 *
 * ⛔ TWO WRITERS OF ONE LEDGER FIELD MUST NOT ANSWER DIFFERENTLY. This tool
 * and `refutation-watch.mjs` both call `brain_recount_outcome`; if they folded
 * with different ordering or different scoping the counters would ping-pong
 * between whichever ran last, and `consecutive_failures` — a POSITIONAL fact —
 * is exactly the field that would disagree. So the ordering and the scoping live
 * here, in one exported function, and both callers call it.
 *
 * ⛔ CALL SITE 2 OF 2: THE LEDGER ROW IS PER-MEMORY, NOT PER-TASK, AND BOTH
 * WRITERS NOW SCOPE THE SAME WAY. `brain_recount_outcome` SETs one outcome row
 * per memory, so a payload folded from a single task's cohort overwrites the
 * verdicts every other task earned. An earlier design had the online watch fold
 * its SAME-TASK cohort — the cohort its control arm and streak are computed over
 * — and said so here; for a multi-task memory that write was wrong by
 * construction (memory 26809 was used on seven other tasks, all passing). It was
 * corrected: the watch's ALARM is still a same-task statistic, but the recount it
 * sends folds every task the memory was used on, through this function,
 * unscoped — the same answer this tool writes.
 *
 * `--task NAME` still scopes THIS CLI, which is an operator's tool for asking
 * what one task's rows say; it is not what either writer sends to the store.
 *
 * `at` is each row's own ordering timestamp. A row with no timestamp sorts LAST,
 * so a missing window can never masquerade as the oldest evidence.
 *
 * THE ONE REMAINING DIFFERENCE, stated rather than hidden: this tool passes the
 * trial's FINISH time (it has the full result), the watch passes its START (the
 * key its streak is read in, so that the counters it writes and the streak it
 * fired on cannot disagree). The two orders differ only if two trials of the
 * SAME TASK overlap in time, which one-trial-per-job sweeps do not produce; the
 * fold itself — the part that was worth sharing — is identical either way.
 *
 * ⛔ OUTCOME-VISIBLE-6 IS FOLDED HERE, WHICH IS WHY IT REACHES BOTH WRITERS AT
 * ONCE. A row whose `how` is `read` and whose position sits inside an existing
 * refutation streak is EXPOSURE — see [`partitionExposureWhileRefuted`] and this
 * file's header. Consequence to state where the counters are produced: the only
 * things that can clear `consecutive_failures` on a refuted memory are a graded
 * success credited through AUTHORSHIP and an explicit recount, because a reader
 * of the quarantined index never saw the construction it would be crediting.
 *
 * @param {Array<{reward:number, at:number|null, task?:string, how?:string}>} rows
 * @param {{task?: string|null, threshold?: number}} [opts]
 */
export function foldOrderedRows(rows, { task = null, threshold = undefined } = {}) {
  return summarise(orderRows(rows, task), threshold)
}

/** Scope, then order — the half of the fold both public entry points share. */
function orderRows(rows, task) {
  return [...scopeRows(rows, task)].sort(
    (a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER),
  )
}

/**
 * The rows [`foldOrderedRows`] DROPPED as exposure, in the same order and under
 * the same scope — so a narrowed count can always say how much it narrowed.
 *
 * Separate from the fold rather than a second return value: [`buildRecount`]
 * spreads the fold's result straight into `brain_recount_outcome`'s arguments,
 * so a new key on that object becomes an unknown tool argument.
 */
export function exposureWhileRefuted(rows, { task = null, threshold = undefined } = {}) {
  return partitionExposureWhileRefuted(
    orderRows(rows, task),
    threshold ?? seededRefutationThreshold(),
  ).exposed
}

/**
 * The rows a `--task` scope selects — normalised on BOTH sides, so the
 * namespaced spelling the runner records and the bare one every other surface
 * uses name the same cohort. Exported because the CLI has to be able to tell
 * "this scope selected nothing" from "this memory has no rows", and a scope
 * that selected nothing must refuse rather than recount.
 */
export function scopeRows(rows, task) {
  if (task === null || task === undefined) return rows ?? []
  const want = taskKey(task)
  return (rows ?? []).filter((r) => taskKey(r.task) === want)
}

/**
 * Fold rows that are ALREADY in order into the counters the recount op takes.
 *
 * Exposure rows (OUTCOME-VISIBLE-6) are removed first, by the one walk in
 * [`partitionExposureWhileRefuted`], so no counter this returns can be moved by
 * a trial that was served a quarantined index instead of the construction.
 */
export function summarise(rows, threshold = undefined) {
  const { kept } = partitionExposureWhileRefuted(
    rows,
    threshold ?? seededRefutationThreshold(),
  )
  let graded_successes = 0
  let graded_failures = 0
  let consecutive_failures = 0
  let last_outcome = null
  let last_outcome_at = null
  for (const r of kept) {
    if (r.reward > 0) {
      graded_successes += 1
      consecutive_failures = 0
      last_outcome = 'success'
    } else {
      graded_failures += 1
      consecutive_failures += 1
      last_outcome = 'failure'
    }
    if (r.at !== null) last_outcome_at = r.at
  }
  return {
    graded_successes,
    graded_failures,
    consecutive_failures,
    last_outcome,
    last_outcome_at,
  }
}

/** The call this would make. Separated from the doing, like `buildObservation`. */
export function buildRecount(memoryId, counts, source) {
  const args = { id: memoryId, source, ...counts }
  if (args.last_outcome === null) {
    // Omitted, never sent as null: "never graded" and "graded and passed" are
    // different facts and the schema keeps them apart by absence.
    delete args.last_outcome
    delete args.last_outcome_at
  }
  if (args.last_outcome_at === null) delete args.last_outcome_at
  return { name: 'brain_recount_outcome', arguments: args }
}

function isoDate(ms) {
  return ms === null || ms === undefined ? '?' : new Date(ms).toISOString().slice(0, 10)
}

async function main() {
  const argv = process.argv.slice(2)
  const memoryId = Number(argv[0])
  if (!Number.isInteger(memoryId)) {
    console.error('usage: recount-outcomes.mjs <memory-id> [--apply] [--root DIR] [--source LABEL] [--task NAME]')
    process.exit(2)
  }
  const apply = argv.includes('--apply')
  const rootAt = argv.indexOf('--root')
  const root = rootAt >= 0 ? argv[rootAt + 1] : dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const srcAt = argv.indexOf('--source')
  const source =
    srcAt >= 0 ? argv[srcAt + 1] : `recount:jobs ${new Date().toISOString().slice(0, 10)}`

  const taskAt = argv.indexOf('--task')
  // ⛔ `--task` IS AN OPERATOR'S LENS, NOT WHAT EITHER WRITER SENDS. The default
  // (unscoped) fold is the one that matches the store: ONE outcome row per
  // memory, every task the memory was used on — and it is the same scope the
  // online watch's applied recount now uses, through the same `foldOrderedRows`.
  // With `--task NAME` this CLI answers the narrower question "what do this one
  // task's rows say", which is the cohort the watch's ALARM is computed over;
  // applying it writes one task's verdicts over every other task's, so use it to
  // LOOK, and drop it to REPAIR. NAME is matched on the BARE task (`taskKey`), so
  // the namespaced `terminal-bench/<task>` the runner records and the bare name
  // every other surface prints both work.
  const task = taskAt >= 0 ? argv[taskAt + 1] : null

  const jobs = collectJobDirs(root).map(readJob).filter(Boolean)
  const { rows, exposed, skipped } = recountRows(jobs, memoryId)
  const scoped = scopeRows(rows, task)
  const counts = foldOrderedRows(rows, { task })
  // OUTCOME-VISIBLE-6: the rows the fold DROPPED because the memory was already
  // refuted when they read it. Named in the table and totalled below, never
  // silently absent — the whole reason this tool exists is that a counter nobody
  // can re-derive is a counter nobody can trust.
  const quarantinedReads = exposureWhileRefuted(rows, { task })
  const droppedTrials = new Set(quarantinedReads.map((r) => r.trial))

  console.log(`[recount] memory ${memoryId} — ${jobs.length} job(s) scanned under ${root}`)
  if (!rows.length) {
    console.log('[recount] no trial USED this memory; nothing to recount')
  } else {
    console.log(
      `${'date'.padEnd(12)}${'task'.padEnd(26)}${'how'.padEnd(22)}${'via'.padEnd(12)}reward  trial`,
    )
    for (const r of rows) {
      const how = droppedTrials.has(r.trial) ? EXPOSED_WHILE_REFUTED : r.how
      console.log(
        `${isoDate(r.at).padEnd(12)}${String(r.task).slice(0, 25).padEnd(26)}${how.padEnd(22)}${String(r.via).padEnd(12)}${String(r.reward).padEnd(8)}${r.trial}`,
      )
    }
  }
  console.log(
    `[recount] USED: ${counts.graded_successes} success / ${counts.graded_failures} failure, ` +
      `consecutive_failures ${counts.consecutive_failures}, last ${counts.last_outcome ?? 'none'} ` +
      `${isoDate(counts.last_outcome_at)}`,
  )
  // The disclosure. A narrowed count that hides how much it dropped is the same
  // class of defect as the over-count it replaces.
  console.log(
    `[recount] exposed, not counted: ${exposed.length}` +
      (exposed.length ? ` (${[...new Set(exposed.map((e) => e.trial.split('__')[0]))].join(', ')})` : ''),
  )
  console.log(
    `[recount] ${EXPOSED_WHILE_REFUTED}: ${quarantinedReads.length}` +
      (quarantinedReads.length
        ? ` (${quarantinedReads.map((r) => r.trial).join(', ')}) — read at a point where the ` +
          `entry was already refuted at threshold ${seededRefutationThreshold()}, so the tool ` +
          `surface served the verdict and a graded index, not the construction. Neither success ` +
          `nor failure is credited; only an AUTHORED graded success or this recount releases it.`
        : ''),
  )
  if (skipped.length) {
    console.log(`[recount] excluded: ${skipped.length}`)
    for (const s of skipped) console.log(`  - ${s.trial}: ${s.why}`)
  }

  if (!rows.length) return
  // ⛔ A SCOPE THAT SELECTED NOTHING IS A REFUSAL, NEVER A RECOUNT. The early
  // return above tests the UNSCOPED rows, so a `--task` that matches nothing
  // used to fall through with a perfectly self-consistent 0 success / 0 failure
  // / streak 0 — internally consistent, so the gateway's contradiction guard
  // passes it — and `--apply` would have overwritten a real ledger with zeros,
  // removing the serving layer's REFUTED banner from the one row that earned it.
  if (task !== null && !scoped.length) {
    console.error(
      `[recount] --task ${task} matched no USED rows for memory ${memoryId} ` +
        `(rows are scoped on the bare task name; this memory was used on: ` +
        `${[...new Set(rows.map((r) => r.task))].join(', ') || 'nothing'}). ` +
        `Refusing to recount: a zeroed ledger is indistinguishable from a real one once written.`,
    )
    process.exit(6)
  }
  const call = buildRecount(memoryId, counts, source)
  console.log(`[recount] would set: ${JSON.stringify(call.arguments)}`)
  if (!apply) {
    console.log('[recount] DRY RUN — pass --apply to write it')
    return
  }

  const url = process.env.TERRANSOUL_MCP_URL
  const token = process.env.TERRANSOUL_MCP_TOKEN
  if (!url || !token) {
    console.error('[recount] TERRANSOUL_MCP_URL / TERRANSOUL_MCP_TOKEN unset — refusing to guess')
    process.exit(3)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call }),
  })
  const text = await res.text()
  if (!res.ok || text.includes('"isError":true')) {
    console.error(`[recount] FAILED (${res.status}): ${text.slice(0, 300)}`)
    process.exit(4)
  }
  // Hold the response to its own claim, exactly as the credit step does: a
  // call that succeeds while writing nothing is the defect class this
  // directory keeps rediscovering.
  let inner = null
  try {
    inner = JSON.parse(JSON.parse(text)?.result?.content?.[0]?.text ?? '{}')
  } catch {
    // Shape drift is itself a reason not to claim success.
  }
  if (!inner || typeof inner.memory_id !== 'number') {
    console.error(`[recount] UNVERIFIED — no memory_id in the response: ${text.slice(0, 300)}`)
    process.exit(5)
  }
  console.log(
    `[recount] applied — ${inner.outcome?.graded_successes}/${inner.outcome?.graded_failures}` +
      `, trail ${inner.trail_recorded ? 'written' : 'already present'}` +
      (inner.previous
        ? ` (was ${inner.previous.graded_successes}/${inner.previous.graded_failures})`
        : ''),
  )
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('recount-outcomes.mjs')) {
  main().catch((e) => {
    console.error(`[recount] ${e?.message ?? e}`)
    process.exit(1)
  })
}
