#!/usr/bin/env node
/**
 * Tests for `refutation-watch.mjs` — the ONLINE detector that fires on the
 * second used-cohort loss.
 *
 * ⛔ WHY EVERY ONE OF THESE FAILS ON THE PRE-CHANGE TREE. `refutation-watch.mjs`
 * does not exist, so the import throws. That is the trivial sense. The
 * load-bearing sense is that NOTHING in the harness computes a used-vs-not-used
 * same-task cohort at all:
 *
 *   - `memory-outcome-audit.mjs` exports `servedFromProxyLog` /
 *     `servedFromTrajectory` — SERVED, not used, and with no control arm.
 *   - `served-memory-audit.mjs`'s `collect` / `rank` are retrospective,
 *     human-invoked CLIs whose suspect rule is lifetime-zero-shaped: it cannot
 *     flag a memory that has ever passed, which is why the hand audit of
 *     2026-09-12 printed four other ids and never the one that mattered.
 *   - `task-regression-audit.mjs` asks whether a TASK regressed, never whether a
 *     MEMORY did, and has no notion of exposure.
 *
 * So there is no pre-change function these tests could have been written
 * against, and no pre-change code path that reaches the alarm's decision.
 *
 * Hermetic: every fixture is a throwaway directory tree in the OS temp dir. No
 * brain, no docker, no bench corpus, and nothing in `jobs*` is read — a test
 * that asserted against the live corpus would pass or fail on which sweep ran
 * last, and would go green on an empty tree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cohortForMemory,
  refutationAlarm,
  runRefutationWatch,
  BASE_DEFAULTS,
  transportFor,
} from './refutation-watch.mjs'

/** The repo root, for the seeded config the threshold is calibrated against. */
const REPO = join(import.meta.dirname, '..', '..')

/** A newline, spelled so no heredoc or editor can fold it into the source. */
const NL = String.fromCharCode(10)

const TASK = 'sample-seg-task'
const MEMORY = 4242

// ⛔ EVERY CASE PINS `BASE_DEFAULTS`, NOT `DEFAULTS`. The latter is read from
// TB_REFUTE_ALPHA / TB_REFUTE_MIN_STREAK / TB_REFUTE_MIN_BASE at import, so a
// suite asserting against it would go red inside any sweep shell that overrode a
// threshold — a test whose verdict depends on who ran it measures the shell.

/**
 * Build a corpus of one-trial jobs.
 *
 * One trial per job is the shape `run-dg.sh` actually produces (one proxy per
 * job), and it makes the attribution exact rather than a guess.
 *
 * @param {Array<{used?: boolean, reward: number, sound?: boolean, task?: string}>} rows
 *   in the order they should be READ BACK by started_at. The fixture
 *   deliberately writes them to disk in REVERSE, so directory-name order is the
 *   opposite of time order and a reader that sorts by name gets the streak
 *   backwards.
 */
function corpus(rows, { task = TASK, memoryId = MEMORY } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'refute-'))
  const jobsRoot = join(base, 'jobs')
  mkdirSync(jobsRoot, { recursive: true })
  const made = []
  const indexed = rows.map((r, i) => ({ r, i }))
  for (const { r, i } of [...indexed].reverse()) {
    const day = String(1 + Math.floor(i / 24)).padStart(2, '0')
    const hour = String(i % 24).padStart(2, '0')
    const started = `2026-09-${day}T${hour}:00:00Z`
    const finished = `2026-09-${day}T${hour}:30:00Z`
    // The job name counts DOWN while time counts UP.
    const job = `j${String(rows.length - i).padStart(3, '0')}-20260901-000000`
    const jobDir = join(jobsRoot, job)
    const trialName = `${r.task ?? task}__t${String(i).padStart(3, '0')}`
    const trialDir = join(jobDir, trialName)
    mkdirSync(join(trialDir, 'verifier'), { recursive: true })
    const sound = r.sound !== false
    writeFileSync(
      join(trialDir, 'result.json'),
      JSON.stringify({
        task_name: r.task ?? task,
        started_at: started,
        finished_at: finished,
        agent_execution: { started_at: started, finished_at: finished },
        // The zero-token shape: the agent never ran (429/401), which
        // `runWasSound` reads as "not a fair test".
        agent_result: { n_output_tokens: sound ? 4096 : 0 },
        verifier_result: { rewards: { reward: r.reward } },
      }),
    )
    writeFileSync(join(trialDir, 'verifier', 'reward.txt'), `${r.reward}\n`)
    // The proxy row. `authored` / `read` are USE; `served` alone is exposure and
    // must land in the control arm, not the treatment one.
    const key = r.used ? 'authored' : 'served'
    const row = { at: `2026-09-${day}T${hour}:10:00Z` }
    row[key] = [memoryId]
    writeFileSync(
      join(jobDir, 'terransoul-proxy-calls.jsonl'),
      `[tb-proxy] ${JSON.stringify(row)}\n`,
    )
    made.push({ trialDir, trialName, jobDir })
  }
  made.reverse()
  return { base, trials: made }
}

/** 14 not-used (12 passing) + 12 used whose tail is pass, pass, fail, fail. */
function twentySixTrialCorpus(usedTail = [1, 1, 0, 0]) {
  const rows = []
  for (let i = 0; i < 12; i++) rows.push({ used: false, reward: 1 })
  rows.push({ used: false, reward: 0 })
  rows.push({ used: false, reward: 0 })
  // The used cohort, in time order. Its head does not reach the alarm and is
  // deliberately not all-failing, so nothing here can pass by accident on a
  // lifetime-zero rule.
  for (let i = 0; i < 12 - usedTail.length; i++) rows.push({ used: true, reward: 0 })
  for (const r of usedTail) rows.push({ used: true, reward: r })
  return rows
}

test('fires_on_the_second_consecutive_used_cohort_failure', () => {
  const { base } = corpus(twentySixTrialCorpus())
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.equal(cohort.used.length + cohort.notUsed.length, 26)
  assert.equal(cohort.notUsed.length, 14)
  assert.equal(cohort.used.length, 12)
  // Time order, not directory order: the fixture wrote the dirs backwards.
  assert.deepEqual(
    cohort.used.slice(-4).map((t) => t.reward),
    [1, 1, 0, 0],
  )

  const alarm = refutationAlarm(cohort, BASE_DEFAULTS)
  assert.equal(alarm.notUsedPass, 12)
  assert.equal(alarm.notUsedTotal, 14)
  assert.equal(alarm.baseRate.toFixed(4), (12 / 14).toFixed(4))
  assert.equal(alarm.streak, 2)
  // (1 - 12/14)^2 = 0.142857^2 = 0.020408...
  assert.equal(alarm.p.toFixed(4), '0.0204')
  assert.ok(alarm.p <= BASE_DEFAULTS.alpha)
  assert.equal(alarm.fires, true)

  // ⛔ ONE TRIAL EARLIER IT MUST NOT FIRE. A detector that would have fired on
  // the FIRST loss is not a detector, it is a coin flip on a hard task.
  const earlier = { used: cohort.used.slice(0, -1), notUsed: cohort.notUsed }
  const before = refutationAlarm(earlier, BASE_DEFAULTS)
  assert.equal(before.streak, 1)
  assert.equal(before.p.toFixed(4), '0.1429')
  assert.equal(before.fires, false)
})

test('a_hard_task_does_not_trip_the_alarm', () => {
  // Base rate 0.3 — 3 passes in 10 not-used trials — and a THREE-failure used
  // streak. p = 0.7^3 = 0.343, nearly seven times alpha. This is the confound
  // guard: a counter with no control arm cannot tell "this entry is refuted"
  // from "this task is hard", and would have fired here.
  const rows = []
  for (let i = 0; i < 3; i++) rows.push({ used: false, reward: 1 })
  for (let i = 0; i < 7; i++) rows.push({ used: false, reward: 0 })
  rows.push({ used: true, reward: 1 })
  rows.push({ used: true, reward: 0 })
  rows.push({ used: true, reward: 0 })
  rows.push({ used: true, reward: 0 })
  const { base } = corpus(rows)
  const alarm = refutationAlarm(cohortForMemory(base, TASK, MEMORY), BASE_DEFAULTS)
  assert.equal(alarm.baseRate.toFixed(4), '0.3000')
  assert.equal(alarm.streak, 3)
  assert.equal(alarm.p.toFixed(4), '0.3430')
  assert.equal(alarm.fires, false)
})

test('a_lifetime_pass_does_not_prevent_a_recency_collapse', () => {
  // ⛔ THE SHAPE THE EXISTING RETROSPECTIVE RULE STRUCTURALLY CANNOT SEE.
  // `served-memory-audit.mjs` ranks suspects by lifetime zeros, so an entry
  // with prior passes is invisible to it however badly it is failing NOW.
  const rows = []
  for (let i = 0; i < 12; i++) rows.push({ used: false, reward: 1 })
  rows.push({ used: false, reward: 0 })
  rows.push({ used: false, reward: 0 })
  for (const r of [1, 1, 0, 0]) rows.push({ used: true, reward: r })
  const { base } = corpus(rows)
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.equal(
    cohort.used.filter((t) => t.reward > 0).length,
    2,
    'the entry has a lifetime pass record',
  )
  const alarm = refutationAlarm(cohort, BASE_DEFAULTS)
  assert.equal(alarm.fires, true)
  assert.equal(alarm.streak, 2)
})

test('never_ran_trials_are_excluded_from_both_cohorts', () => {
  // Two control trials that never ran (zero output tokens — the 429/401 shape).
  // Counted, they drag the base rate from 12/14 = 0.857 to 12/16 = 0.75, which
  // is a ~10pp move in the denominator the alarm is measured against.
  const rows = twentySixTrialCorpus()
  rows.splice(4, 0, { used: false, reward: 0, sound: false })
  rows.splice(9, 0, { used: false, reward: 0, sound: false })
  rows.push({ used: true, reward: 0, sound: false })
  const { base } = corpus(rows)
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.equal(cohort.notUsed.length, 14, 'the two never-ran control trials are dropped')
  assert.equal(cohort.used.length, 12, 'the never-ran treatment trial is dropped too')
  const alarm = refutationAlarm(cohort, BASE_DEFAULTS)
  assert.equal(alarm.baseRate.toFixed(4), (12 / 14).toFixed(4))
  assert.notEqual(alarm.baseRate.toFixed(4), '0.7500')
  assert.equal(alarm.p.toFixed(4), '0.0204')
  assert.equal(alarm.fires, true)
})

test('another_task_that_used_the_same_memory_is_not_in_either_cohort', () => {
  // The keying decision, measured: same-task USE precision is 10/12 = 83.3%,
  // while the unscoped served-only alternative collapses to 10/19 = 52.6% — and
  // 7 of those 9 false positives are PASSING trials on unrelated tasks that were
  // shown the row by search noise.
  const rows = twentySixTrialCorpus()
  rows.push({ used: true, reward: 1, task: 'some-other-task' })
  rows.push({ used: true, reward: 1, task: 'some-other-task' })
  const { base } = corpus(rows)
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.equal(cohort.used.length, 12)
  assert.equal(cohort.used.filter((t) => t.reward > 0).length, 2)
  assert.equal(refutationAlarm(cohort, BASE_DEFAULTS).fires, true)
})

test('no_credible_base_rate_means_no_alarm', () => {
  // Three control trials is not a base rate. Firing on it would make the alarm a
  // restatement of the streak — exactly the counter it is meant to replace.
  const rows = [
    { used: false, reward: 1 },
    { used: false, reward: 1 },
    { used: false, reward: 1 },
    { used: true, reward: 0 },
    { used: true, reward: 0 },
  ]
  const { base } = corpus(rows)
  const alarm = refutationAlarm(cohortForMemory(base, TASK, MEMORY), BASE_DEFAULTS)
  assert.equal(alarm.fires, false)
  assert.equal(alarm.reason, 'no credible base rate')
  assert.equal(alarm.p, null)
})

test('an_alarm_calls_recount_with_used_cohort_counts_not_the_global_ledger', async () => {
  const { base, trials } = corpus(twentySixTrialCorpus())
  const last = trials[trials.length - 1]
  const calls = []
  const callTool = async (params) => {
    calls.push(params)
    return {
      res: { ok: true, status: 200 },
      text: JSON.stringify({
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ memory_id: MEMORY, outcome: { graded_successes: 2 } }),
            },
          ],
        },
      }),
    }
  }
  const out = await runRefutationWatch({
    base,
    trialDir: last.trialDir,
    memoryIds: [MEMORY],
    apply: true,
    callTool,
    cfg: BASE_DEFAULTS,
  })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].fires, true)
  assert.equal(out.rows[0].applied, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'brain_recount_outcome')
  const a = calls[0].arguments
  assert.equal(a.id, MEMORY)
  // ⛔ THE USED, ORDER-SENSITIVE COUNTS — not the store's own ledger, which is
  // the thing that was wrong in the first place. This corpus is single-task, so
  // the payload's cross-task scope (see the two-task case below) is the same 12
  // rows the alarm read; that identity is the reason the widening was safe.
  assert.equal(a.graded_successes, 2)
  assert.equal(a.graded_failures, 10)
  assert.equal(a.consecutive_failures, 2)
  assert.equal(a.last_outcome, 'failure')
  assert.ok(typeof a.source === 'string' && a.source.length > 0, 'provenance is required')
  assert.ok(a.source.includes('refutation-watch'), `source names the writer: ${a.source}`)
  assert.ok(a.source.includes('w=2'), `source carries the window: ${a.source}`)

  // The audit row lands beside the trial, whatever the decision was.
  const alerts = join(last.jobDir, 'memory-refutation-alerts.jsonl')
  assert.ok(existsSync(alerts), 'the alert log is written next to the trial')
  const row = JSON.parse(readFileSync(alerts, 'utf8').trim().split('\n').pop())
  assert.equal(row.memory_id, MEMORY)
  assert.equal(row.task, TASK)
  assert.equal(row.streak, 2)
  assert.equal(row.fires, true)
  assert.equal(row.applied, true)
  assert.ok(typeof row.base_rate === 'number')
  assert.ok(typeof row.at === 'string')
})

test('dry_by_default', async () => {
  const { base, trials } = corpus(twentySixTrialCorpus())
  const last = trials[trials.length - 1]
  const calls = []
  const out = await runRefutationWatch({
    base,
    trialDir: last.trialDir,
    memoryIds: [MEMORY],
    callTool: async (p) => {
      calls.push(p)
      return { res: { ok: true, status: 200 }, text: '{}' }
    },
    cfg: BASE_DEFAULTS,
  })
  assert.equal(out.rows[0].fires, true)
  assert.equal(out.rows[0].applied, false)
  assert.equal(calls.length, 0, 'a tool that mutates ranking state must not do so by being read')
  // A non-applied decision is still AUDITABLE.
  const row = JSON.parse(
    readFileSync(join(last.jobDir, 'memory-refutation-alerts.jsonl'), 'utf8').trim(),
  )
  assert.equal(row.fires, true)
  assert.equal(row.applied, false)
})

test('a_non_firing_decision_is_recorded_too', async () => {
  const { base, trials } = corpus(twentySixTrialCorpus([1, 1, 1, 0]))
  const last = trials[trials.length - 1]
  const out = await runRefutationWatch({ base, trialDir: last.trialDir, memoryIds: [MEMORY], cfg: BASE_DEFAULTS })
  assert.equal(out.rows[0].fires, false)
  const row = JSON.parse(
    readFileSync(join(last.jobDir, 'memory-refutation-alerts.jsonl'), 'utf8').trim(),
  )
  assert.equal(row.fires, false)
  assert.equal(row.streak, 1)
  // The base rate travels with the row so a reader can re-judge the call later
  // without re-walking the corpus.
  assert.equal(typeof row.base_rate, 'number')
})

test('the_watch_threshold_is_READ_FROM_the_products_seeded_refutation_rule', () => {
  // ⛔ THIS TEST USED TO ASSERT `DEFAULTS.minStreak === 2` AGAINST A LITERAL,
  // which pins the module's own constant and cannot detect the drift its name
  // promises to guard. The coupling is load-bearing: the watch must never mark
  // something the serving layer will not annotate, and the serving layer's
  // threshold is a SEEDED CONFIG ROW, not a number in this file. So read it.
  //
  // A missing key fails with a message naming it — that failure IS the coupling
  // (the product stopped seeding the rule the watch is calibrated to), not a
  // bug in the test.
  const seed = join(REPO, 'mcp-data', 'shared', 'seed-config.sql')
  const sql = readFileSync(seed, 'utf8')
  const m = sql.match(/outcome\.refuted\.min_consecutive_failures\s*\|\s*(\d+)\s*\|/)
  // BASE_DEFAULTS, not DEFAULTS: the latter is computed from TB_REFUTE_* at
  // import, so asserting on it would fail inside any sweep shell that overrode
  // the threshold — a test whose verdict depends on who ran it measures the
  // shell rather than the code.
  assert.ok(
    m,
    `outcome.refuted.min_consecutive_failures is not seeded in ${seed} — the watch's minStreak is ` +
      `calibrated to the serving layer's refutation rule and there is now nothing to calibrate against`,
  )
  assert.equal(
    BASE_DEFAULTS.minStreak,
    Number(m[1]),
    'the watch would recount rows the serving layer never annotates (or warn on rows it does not consider refuted)',
  )
})

test('the recount FOLD is the one recount-outcomes.mjs uses, not a second copy', async () => {
  // ⛔ TWO WRITERS OF ONE LEDGER FIELD MUST NOT ANSWER DIFFERENTLY. The online
  // watch and the retrospective repair both call `brain_recount_outcome`; if
  // they fold with different ordering or scoping, the counters ping-pong between
  // whichever ran last. This asserts they are literally the same function.
  const recount = await import('./recount-outcomes.mjs')
  const watch = await import('./refutation-watch.mjs')
  assert.equal(watch.foldOrderedRows, recount.foldOrderedRows)
  // And the fold is order-sensitive on the SAME key both callers supply.
  const rows = [
    { reward: 1, at: 30 },
    { reward: 0, at: 10 },
    { reward: 0, at: 20 },
  ]
  const folded = recount.foldOrderedRows(rows)
  assert.equal(folded.graded_successes, 1)
  assert.equal(folded.graded_failures, 2)
  // Sorted by `at`: fail, fail, pass — so the streak ends at 0 and the last
  // outcome is the success. Reading them in array order would say otherwise.
  assert.equal(folded.consecutive_failures, 0)
  assert.equal(folded.last_outcome, 'success')
  assert.equal(folded.last_outcome_at, 30)
  // A row with no timestamp sorts LAST rather than first, so a missing window
  // can never masquerade as the oldest evidence.
  assert.equal(recount.foldOrderedRows([{ reward: 0, at: null }, { reward: 1, at: 5 }]).last_outcome, 'failure')
})

test('the fold SCOPES to one task when asked, which is the CLI lens and not what either writer sends', async () => {
  const { foldOrderedRows } = await import('./recount-outcomes.mjs')
  const rows = [
    { reward: 0, at: 10, task: 'seg' },
    { reward: 1, at: 20, task: 'other' },
    { reward: 0, at: 30, task: 'seg' },
  ]
  const scoped = foldOrderedRows(rows, { task: 'seg' })
  assert.equal(scoped.graded_successes, 0)
  assert.equal(scoped.graded_failures, 2)
  assert.equal(scoped.consecutive_failures, 2)
  // ⛔ UNSCOPED IS WHAT BOTH WRITERS SEND, because the store holds ONE outcome
  // row per memory: `recount-outcomes.mjs` without `--task`, and the online
  // watch's applied recount. The scoped answer above is the CLI's operator lens
  // and the cohort the watch's ALARM is computed over — writing it would put one
  // task's verdicts over every other task's.
  assert.equal(foldOrderedRows(rows).graded_successes, 1)
})

test('the standalone CLI does not let a boolean flag swallow the trial dir', async () => {
  // ⛔ `argv.find(a => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'))`
  // treats the word after ANY flag as that flag's value, so
  // `refutation-watch.mjs --apply <trial-dir>` dropped the trial directory and
  // the watch ran on nothing — silently, because "no memory ids" is also what a
  // trial that used no memory looks like.
  const { parseArgs } = await import('./refutation-watch.mjs')
  const t = 'jobs/j1/task__abc'
  assert.equal(parseArgs(['--apply', t]).trialDir, t)
  assert.equal(parseArgs([t, '--apply']).trialDir, t)
  assert.equal(parseArgs(['--base', 'B', t]).trialDir, t)
  assert.equal(parseArgs(['--base', 'B', t]).base, 'B')
  assert.equal(parseArgs(['--memory', '42', t]).memory, 42)
  assert.equal(parseArgs(['--apply', '--base', 'B', t]).apply, true)
  assert.equal(parseArgs(['--apply']).trialDir, null)
})

test('the per-task job scan is done ONCE per run, not once per memory id', async () => {
  // A real trial credits several ids. The scan is 87 ms over the live corpus of
  // 1,011 job directories, and it is pure directory reads on the D: drive this
  // machine already saturates — so doing it per id multiplies a cost that has
  // exactly one answer per run.
  const { base, trials } = corpus(twentySixTrialCorpus())
  const last = trials[trials.length - 1]
  const { runRefutationWatch, __scanCounter } = await import('./refutation-watch.mjs')
  const before = __scanCounter()
  await runRefutationWatch({ base, trialDir: last.trialDir, memoryIds: [MEMORY, MEMORY + 1, MEMORY + 2], cfg: BASE_DEFAULTS })
  assert.equal(__scanCounter() - before, 1, 'three memory ids, one directory walk')
})

test('a base that holds no jobs roots says SCANNED NOTHING, not "no base rate"', async () => {
  // ⛔ THE SILENCE THAT LOOKS LIKE AN ANSWER. `run-dg.sh` honours TB_JOBS_DIR, so
  // a sweep pointed at a root whose name does not begin with `jobs` yields zero
  // roots — and the alarm then reported "no credible base rate", which is the
  // same sentence it prints for a task nobody else has run. One is a measurement
  // and the other is a misconfiguration.
  const empty = mkdtempSync(join(tmpdir(), 'refute-empty-'))
  const out = await runRefutationWatch({
    base: empty,
    trialDir: join(empty, 'nowhere', 'sample-seg-task__zzz'),
    memoryIds: [MEMORY],
    cfg: BASE_DEFAULTS,
  })
  assert.equal(out.rows[0].fires, false)
  assert.equal(out.rows[0].scanned_jobs, 0)
  assert.match(out.rows[0].reason, /scanned nothing/i)
})

/**
 * One job holding SEVERAL trials, written by hand: the fixture above builds
 * one-trial jobs, which is the only shape whose log can be attributed.
 */
function multiTrialJob(trialSpecs, { task = TASK, memoryId = MEMORY } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'refute-multi-'))
  const jobDir = join(base, 'jobs', 'j001-20260901-000000')
  const lines = []
  trialSpecs.forEach((spec, i) => {
    const trialName = `${task}__m${i}`
    const trialDir = join(jobDir, trialName)
    mkdirSync(join(trialDir, 'verifier'), { recursive: true })
    writeFileSync(
      join(trialDir, 'result.json'),
      JSON.stringify({
        task_name: task,
        started_at: spec.started,
        finished_at: spec.finished,
        agent_execution: { started_at: spec.started, finished_at: spec.finished },
        agent_result: { n_output_tokens: 4096 },
        verifier_result: { rewards: { reward: spec.reward } },
      }),
    )
    writeFileSync(join(trialDir, 'verifier', 'reward.txt'), `${spec.reward}\n`)
    lines.push(`[tb-proxy] ${JSON.stringify({ read: [memoryId], at: spec.callAt })}`)
  })
  writeFileSync(join(jobDir, 'terransoul-proxy-calls.jsonl'), `${lines.join('\n')}\n`)
  return base
}

test('a job whose log cannot be split lands in EXCLUDED, never in the control arm', () => {
  // ⛔ THE RULE THAT DECIDES WHAT ENTERS p0, AND IT HAD NO FAILING TEST. Two
  // trials in flight against one proxy cannot be separated — the peer address is
  // NAT-collapsed for every container — so `usedIdsFor` returns null. "We cannot
  // tell" is NOT "did not use": dropping those trials into `notUsed` pads the
  // control arm with trials that may well have used the row, which inflates p0
  // and makes the alarm more trigger-happy on every task. p0 is the alarm's only
  // decision input besides the streak.
  const base = multiTrialJob([
    { started: '2026-09-02T10:00:00Z', finished: '2026-09-02T12:00:00Z', callAt: '2026-09-02T10:30:00Z', reward: 1 },
    // Overlaps the first window: this is what makes the log unsplittable.
    { started: '2026-09-02T11:00:00Z', finished: '2026-09-02T13:00:00Z', callAt: '2026-09-02T11:30:00Z', reward: 1 },
  ])
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.equal(cohort.used.length, 0)
  assert.equal(cohort.notUsed.length, 0, 'an unattributable trial must never pad the control arm')
  assert.equal(cohort.excluded.length, 2)
  for (const e of cohort.excluded) assert.match(e.why, /cannot be attributed/)
})

test('a SOLE-trial job is attributed whole, including calls outside its agent window', () => {
  // ⛔ THE OTHER RULE THAT SETS p0. `idsForTrial` exists to SPLIT a shared log
  // and keeps only lines inside the agent's own window — but a job with one
  // trial has nothing to split, and its log legitimately carries calls outside
  // that window: the setup probe, and the deferred-write flush the proxy
  // performs after the agent exits. Windowing it can only LOSE lines, and every
  // line lost moves a USED trial into the control arm, which is the worst place
  // for it: the treatment arm shrinks and the base rate it is compared against
  // rises on the same datum.
  const base = mkdtempSync(join(tmpdir(), 'refute-sole-'))
  const jobDir = join(base, 'jobs', 'j001-20260901-000000')
  const trialName = `${TASK}__sole`
  mkdirSync(join(jobDir, trialName, 'verifier'), { recursive: true })
  writeFileSync(
    join(jobDir, trialName, 'result.json'),
    JSON.stringify({
      task_name: TASK,
      started_at: '2026-09-02T10:00:00Z',
      finished_at: '2026-09-02T12:00:00Z',
      agent_execution: { started_at: '2026-09-02T10:10:00Z', finished_at: '2026-09-02T11:00:00Z' },
      agent_result: { n_output_tokens: 4096 },
      verifier_result: { rewards: { reward: 0 } },
    }),
  )
  writeFileSync(join(jobDir, trialName, 'verifier', 'reward.txt'), '0\n')
  // AFTER the agent window closed — the deferred-write flush.
  writeFileSync(
    join(jobDir, 'terransoul-proxy-calls.jsonl'),
    `[tb-proxy] ${JSON.stringify({ authored: [MEMORY], at: '2026-09-02T11:40:00Z' })}\n`,
  )
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.deepEqual(cohort.used.map((t) => t.trial), [trialName])
  assert.equal(cohort.notUsed.length, 0, 'a windowed read would have called this trial not-used')
  assert.equal(cohort.excluded.length, 0)
})

test('a --memory value that is not an id REFUSES rather than silently watching everything', async () => {
  // ⛔ THE SILENT-DROP SHAPE AGAIN, ONE ARGUMENT OVER. `--memory abc` parsed to
  // null and main() then fell back to auto-discovery, so the operator who
  // mistyped an id watched whatever ids the trial happened to use — with no
  // diagnostic, and an answer that looks exactly like a correct run.
  const { parseArgs } = await import('./refutation-watch.mjs')
  const t = 'jobs/j1/task__abc'
  assert.equal(parseArgs(['--memory', 'abc', t]).memory, null)
  assert.equal(parseArgs(['--memory', 'abc', t]).badMemory, 'abc')
  assert.equal(parseArgs(['--memory', '42', t]).badMemory, undefined)
  assert.equal(parseArgs([t]).badMemory, undefined)

  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  let failed = null
  try {
    await run(process.execPath, [join(here, 'refutation-watch.mjs'), '--memory', 'abc', t], { encoding: 'utf8' })
  } catch (e) {
    failed = e
  }
  assert.ok(failed, 'a malformed --memory must exit non-zero')
  assert.match(`${failed.stdout}${failed.stderr}`, /--memory abc is not a memory id/)
})

test('an errored-but-passing trial counts as a FAILURE, the campaign rule, in both arms', () => {
  // ⛔ TWO READERS OF "DID THIS TRIAL PASS" IN ONE DIRECTORY MUST NOT DISAGREE.
  // caffe-cifar-10 scored reward 1 after blowing the 3600 s agent cap, and the
  // campaign rule is that an errored trial contributes 0. `stop-gate-audit.mjs`
  // reads `outcomeOf(...).counted`; reading the raw `reward.txt` here would put
  // an errored pass into the CONTROL arm as a pass, inflating p0 — which biases
  // the alarm towards firing. The trial is still IN the cohort: errored is a
  // non-pass, never an exclusion.
  const base = mkdtempSync(join(tmpdir(), 'refute-errored-'))
  const jobDir = join(base, 'jobs', 'j001-20260901-000000')
  const trialName = `${TASK}__errored`
  mkdirSync(join(jobDir, trialName, 'verifier'), { recursive: true })
  writeFileSync(
    join(jobDir, trialName, 'result.json'),
    JSON.stringify({
      task_name: TASK,
      started_at: '2026-09-02T10:00:00Z',
      finished_at: '2026-09-02T12:00:00Z',
      agent_execution: { started_at: '2026-09-02T10:00:00Z', finished_at: '2026-09-02T12:00:00Z' },
      agent_result: { n_output_tokens: 4096 },
      exception_info: { exception_type: 'AgentTimeoutError' },
      verifier_result: { rewards: { reward: 1 } },
    }),
  )
  writeFileSync(join(jobDir, trialName, 'verifier', 'reward.txt'), '1\n')
  writeFileSync(
    join(jobDir, 'terransoul-proxy-calls.jsonl'),
    `[tb-proxy] ${JSON.stringify({ served: [MEMORY], at: '2026-09-02T11:00:00Z' })}\n`,
  )
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.equal(cohort.excluded.length, 0, 'an errored trial with a verdict is never excluded')
  assert.equal(cohort.notUsed.length, 1)
  assert.equal(cohort.notUsed[0].reward, 0, 'errored counts as 0 however the verifier scored it')
})

test('a DRY credit still records the watch decision, and sends nothing', async () => {
  // ⛔ THE BLIND SPOT THIS CLOSES. The watch used to run only on the credit's
  // `--apply` path, so a dry sweep wrote no alert row at all and
  // `stop-gate-audit.mjs`'s REFUTATION ALARMS line read 0 for a sweep that never
  // had the chance to decide. The decision is computed from the artifacts on
  // disk — rewards, timestamps, proxy rows — not from the ledger, so it is
  // exactly the decision a live run would have made. No MCP env is set here, so
  // a call of any kind would fail loudly rather than pass quietly.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const { base, trials } = corpus(twentySixTrialCorpus())
  const last = trials[trials.length - 1]
  const log = join(last.jobDir, 'terransoul-proxy-calls.jsonl')
  const out = await run(
    process.execPath,
    [join(here, 'credit-trial-outcome.mjs'), last.trialDir, log, '--refute-watch'],
    {
      encoding: 'utf8',
      // The child pins BASE_DEFAULTS exactly as every in-process case here does:
      // an empty value is not a number, so the module falls back to its own
      // defaults and the test cannot be decided by the shell that ran it.
      env: {
        ...process.env,
        TERRANSOUL_MCP_URL: '',
        TERRANSOUL_MCP_TOKEN: '',
        TB_REFUTE_MIN_STREAK: '',
        TB_REFUTE_ALPHA: '',
        TB_REFUTE_MIN_BASE: '',
      },
    },
  )
  assert.match(out.stdout, /DRY RUN/)
  assert.match(out.stdout, /OBSERVE-ONLY/)
  assert.match(out.stdout, /the credit itself is dry/)
  assert.match(out.stdout, /ALARM memory 4242/)
  assert.doesNotMatch(out.stdout, /RECOUNTED via brain_recount_outcome/)

  const alerts = readFileSync(join(last.jobDir, 'memory-refutation-alerts.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].fires, true)
  assert.equal(alerts[0].applied, false, 'a dry credit must never claim the recount landed')
  assert.equal(alerts[0].streak, 2)
})

// ── THE REVIEWER'S FINDINGS, EACH WITH THE MUTATION IT CATCHES ──────────────

/** A recount response that claims success AND names the row it wrote. */
function recountOk(memoryId = MEMORY) {
  return {
    res: { ok: true, status: 200 },
    text: JSON.stringify({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ memory_id: memoryId, outcome: { graded_successes: 2 } }),
          },
        ],
      },
    }),
  }
}

/** A collector shaped like `console`, so a test can read what was printed. */
function recorder() {
  const lines = []
  return { lines, log: { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) } }
}

test('OBSERVE-ONLY is BEHAVIOURAL: the observe arm writes the row, prints the line, and calls nothing', async () => {
  // ⛔ THE KILL SWITCH HAD NO BEHAVIOURAL TEST. `escalation-wiring.test.sh`
  // greps `credit-trial-outcome.mjs` for the literal
  // `rest.includes('--refute-observe')` — a grep is not a behaviour: it goes
  // green on a line that is present and unreachable, and it is not in this
  // suite. Mutating the switch to `watchApplies = apply` therefore left the
  // node suite entirely green while every observe-only sweep wrote to the brain.
  // This drives the real credit-step code path with a recording transport.
  const { runWatchStage } = await import('./credit-trial-outcome.mjs')
  const { trials } = corpus(twentySixTrialCorpus())
  // The credit step resolves the base from the trial path itself
  // (<base>/jobs*/<job>/<trial>), which is the resolution under test here too.
  const last = trials[trials.length - 1]
  const calls = []
  const { lines, log } = recorder()
  await runWatchStage({
    rest: ['--refute-watch', '--refute-observe'],
    trialDir: last.trialDir,
    trialName: last.trialName,
    ids: [MEMORY],
    attributed: true,
    callTool: async (p) => {
      calls.push(p)
      return recountOk()
    },
    // The live sweep reaches this with apply=true; observe is the ONLY thing
    // standing between it and a brain write.
    apply: true,
    cfg: BASE_DEFAULTS,
    log,
  })
  assert.equal(calls.length, 0, 'observe-only performed a brain write')
  assert.ok(
    lines.some((l) => /OBSERVE-ONLY/.test(l)),
    `the observe arm must say so: ${lines.join(' | ')}`,
  )
  assert.ok(
    lines.some((l) => /\[refute\] ALARM memory 4242/.test(l)),
    `the alarm still fires and still prints: ${lines.join(' | ')}`,
  )
  const row = JSON.parse(
    readFileSync(join(last.jobDir, 'memory-refutation-alerts.jsonl'), 'utf8').trim().split('\n').pop(),
  )
  assert.equal(row.fires, true, 'the decision is still recorded')
  assert.equal(row.applied, false, 'an observe-only run must never claim the recount landed')
})

test('WRITE-ON is the same code path: without the observe flag the credit step DOES recount', async () => {
  const { runWatchStage } = await import('./credit-trial-outcome.mjs')
  const { trials } = corpus(twentySixTrialCorpus())
  const last = trials[trials.length - 1]
  const calls = []
  const { lines, log } = recorder()
  await runWatchStage({
    rest: ['--refute-watch'],
    trialDir: last.trialDir,
    trialName: last.trialName,
    ids: [MEMORY],
    attributed: true,
    callTool: async (p) => {
      calls.push(p)
      return recountOk()
    },
    apply: true,
    cfg: BASE_DEFAULTS,
    log,
  })
  assert.equal(calls.length, 1, 'the write-on arm must actually write')
  assert.equal(calls[0].name, 'brain_recount_outcome')
  assert.ok(
    lines.some((l) => /RECOUNTED via brain_recount_outcome/.test(l)),
    lines.join(' | '),
  )
  const row = JSON.parse(
    readFileSync(join(last.jobDir, 'memory-refutation-alerts.jsonl'), 'utf8').trim().split('\n').pop(),
  )
  assert.equal(row.applied, true)
})

test('a recount that SUCCEEDS while writing nothing is never claimed as applied', async () => {
  // ⛔ THE GUARD'S OWN COMMENT NAMES THIS SHAPE - "a call that succeeds while
  // writing nothing is the defect class this directory keeps rediscovering" -
  // and nothing failed when the guard was replaced with `applied = true`. Both
  // halves of it are exercised here: a 200 whose payload carries no
  // `memory_id`, and an envelope that sets `isError`.
  const wroteNothing = {
    res: { ok: true, status: 200 },
    text: JSON.stringify({
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, rows_written: 0 }) }] },
    }),
  }
  const errored = {
    res: { ok: true, status: 200 },
    text: JSON.stringify({
      isError: true,
      result: { content: [{ type: 'text', text: JSON.stringify({ memory_id: MEMORY }) }] },
    }),
  }
  for (const [label, response] of [
    ['a 200 that reports no write', wroteNothing],
    ['an isError envelope', errored],
  ]) {
    const { base, trials } = corpus(twentySixTrialCorpus())
    const last = trials[trials.length - 1]
    const { lines, log } = recorder()
    const out = await runRefutationWatch({
      base,
      trialDir: last.trialDir,
      memoryIds: [MEMORY],
      apply: true,
      callTool: async () => response,
      cfg: BASE_DEFAULTS,
      log,
    })
    assert.equal(out.rows[0].fires, true, `${label}: the alarm still fires`)
    assert.equal(out.rows[0].applied, false, `${label}: applied must stay false`)
    assert.ok(
      lines.some((l) => /RECOUNT UNVERIFIED/.test(l)),
      `${label}: the operator must be told: ${lines.join(' | ')}`,
    )
    assert.ok(
      lines.some((l) => /recount NOT confirmed/.test(l)),
      `${label}: the ALARM line must not claim the recount landed: ${lines.join(' | ')}`,
    )
    const row = JSON.parse(
      readFileSync(join(last.jobDir, 'memory-refutation-alerts.jsonl'), 'utf8').trim().split(NL).pop(),
    )
    assert.equal(row.applied, false, `${label}: the alert row records the failure to apply`)
  }
})

test('formatP prints a tiny p in exponent form rather than as 0.0000', async () => {
  // ⛔ `p.toFixed(4)` printed the campaign's own worked example — p = 4.67e-9 —
  // as `0.0000`, i.e. as a number that reads like a rounding artefact rather
  // than like nine orders of magnitude below alpha.
  const { formatP } = await import('./refutation-watch.mjs')
  assert.equal(formatP(0.0204), '0.0204')
  assert.equal(formatP(0.1429), '0.1429')
  assert.equal(formatP(4.67e-9), '4.67e-9')
  assert.equal(formatP(0.000467), '4.67e-4')
  assert.equal(formatP(0.001), '0.0010')
  assert.equal(formatP(0), '0')
  assert.equal(formatP(null), 'n/a')
  assert.equal(formatP(undefined), 'n/a')
})

test('the module exports no unexercised cache reset', async () => {
  // ⛔ ADVERTISEMENT IS NOT USE. `resetJobScanCache` had zero callers in the
  // repo: an exported cache primitive nothing calls is a promise the suite
  // cannot keep, and the same shape (a writer or an export with no reader) is
  // the most common silent defect class in this directory.
  const m = await import('./refutation-watch.mjs')
  assert.equal(m.resetJobScanCache, undefined)
})

test('the APPLIED recount folds EVERY task the memory was used on — the ledger row is per-memory', async () => {
  // ⛔ THE ALARM IS A SAME-TASK STATISTIC AND THE LEDGER IS NOT. The store holds
  // ONE outcome row per memory, so a recount built from one task's cohort
  // OVERWRITES the verdicts every other task earned. The alarm must stay
  // same-task (that is the control arm the streak is judged against) while the
  // payload spans all of them, in `started_at` order, through the ONE fold.
  const rows = twentySixTrialCorpus()
  // Two earlier PASSING uses on a different task. Placed first so they cannot be
  // confused with a fix to the streak: the global fold must still report
  // consecutive_failures 2, with four successes instead of two.
  rows.unshift({ used: true, reward: 1, task: 'another-task' }, { used: true, reward: 1, task: 'another-task' })
  const { base, trials } = corpus(rows)
  const last = trials[trials.length - 1]
  const calls = []
  const out = await runRefutationWatch({
    base,
    trialDir: last.trialDir,
    memoryIds: [MEMORY],
    apply: true,
    callTool: async (p) => {
      calls.push(p)
      return recountOk()
    },
    cfg: BASE_DEFAULTS,
  })
  // The ALARM is unchanged: same-task cohort, same streak, same base rate.
  assert.equal(out.rows[0].fires, true)
  assert.equal(out.rows[0].streak, 2)
  assert.equal(out.rows[0].used.total, 12, 'the alarm cohort is still ONE task')
  assert.equal(out.rows[0].not_used.total, 14)

  assert.equal(calls.length, 1)
  const a = calls[0].arguments
  assert.equal(a.id, MEMORY)
  assert.equal(a.graded_successes, 4, 'the other task’s two passes are in the ledger count')
  assert.equal(a.graded_failures, 10)
  assert.equal(a.consecutive_failures, 2, 'order survives the widening: the tail is still two losses')
  assert.equal(a.last_outcome, 'failure')
  // And the widening is VISIBLE in the audit row rather than implied.
  //
  // `exposed_while_refuted` is ALWAYS present (OUTCOME-VISIBLE-6) rather than
  // added only when non-zero: a field that appears conditionally is the
  // shape-drift class this directory keeps paying for, and a reader comparing
  // `trials` with the folded counts needs to see the 0 to know nothing was
  // dropped. Every used row in this fixture is `authored`, so nothing is.
  assert.deepEqual(out.rows[0].recount_scope, { trials: 14, tasks: 2, exposed_while_refuted: 0 })
})

test('the cross-task used rows come from the SAME grading rules as the alarm cohort', async () => {
  // A never-ran trial is not a failure, and an errored pass counts as 0 — the
  // campaign's own definitions. The widened scan must not reintroduce either,
  // or the payload disagrees with the arm that fired.
  const { usedRowsForMemory } = await import('./refutation-watch.mjs')
  const rows = twentySixTrialCorpus()
  rows.unshift({ used: true, reward: 0, sound: false, task: 'another-task' })
  const { base } = corpus(rows)
  const used = await usedRowsForMemory(base, MEMORY)
  assert.equal(used.length, 12, 'the never-ran trial on the other task is dropped, not counted as a loss')
  assert.deepEqual(
    used.slice(-4).map((r) => r.reward),
    [1, 1, 0, 0],
    'started_at order, not directory order',
  )
})

// ── OUTCOME-VISIBLE-6 — the used COHORT drops a read taken while refuted ─────
//
// ⛔ WHY THESE FAIL ON THE PRE-CHANGE TREE. `cohortForMemory` classified a trial
// as used or not-used and stopped there: its rows carried no `how`, there was no
// `exposedWhileRefuted` arm (the field is `undefined`), and every used trial's
// grade reached `foldOrderedRows`. So the fourth trial below sat in `used` and its
// PASS cleared the streak — which is precisely what lifts the serving layer's
// banner and its quarantine, handing the body back to the next reader.
//
// MEASURED 2026-09-13: entry 26809, 10 consecutive graded failures, quarantined.
// `redo09130830` opened it, was served the verdict plus a graded index of its
// blocks, authored 27007 and passed 9/9 — and the credit loop moved 26809 to
// graded_successes 3 / consecutive_failures 0 / last_outcome success.

/** One job, one trial, with the proxy row spelled by the caller. */
function jobWithRow(base, { task, name, reward, started, row }) {
  const jobDir = join(base, 'jobs', `j-${name}`)
  mkdirSync(join(jobDir, name, 'verifier'), { recursive: true })
  writeFileSync(
    join(jobDir, name, 'result.json'),
    JSON.stringify({
      task_name: task,
      started_at: started,
      finished_at: started,
      agent_execution: { started_at: started, finished_at: started },
      agent_result: { n_output_tokens: 4096 },
      verifier_result: { rewards: { reward } },
    }),
  )
  writeFileSync(join(jobDir, name, 'verifier', 'reward.txt'), `${reward}${NL}`)
  writeFileSync(
    join(jobDir, 'terransoul-proxy-calls.jsonl'),
    `[tb-proxy] ${JSON.stringify({ ...row, at: started })}${NL}`,
  )
}

/**
 * authored pass, read fail, read fail (streak 2 = refuted), read PASS while
 * refuted — plus a control arm, because the alarm refuses without one.
 */
function exposureCorpus({ fourthRow }) {
  const base = mkdtempSync(join(tmpdir(), 'refute-exposure-'))
  const used = [
    { name: `${TASK}__u1`, reward: 1, started: '2026-09-01T01:00:00Z', row: { authored: [MEMORY] } },
    { name: `${TASK}__u2`, reward: 0, started: '2026-09-01T02:00:00Z', row: { read: [MEMORY] } },
    { name: `${TASK}__u3`, reward: 0, started: '2026-09-01T03:00:00Z', row: { read: [MEMORY] } },
    { name: `${TASK}__u4`, reward: 1, started: '2026-09-01T04:00:00Z', row: fourthRow },
  ]
  for (const u of used) jobWithRow(base, { task: TASK, ...u })
  // The control arm: four not-used trials, so `minBase` is satisfied.
  for (let i = 0; i < 4; i++) {
    jobWithRow(base, {
      task: TASK,
      name: `${TASK}__c${i}`,
      reward: 1,
      started: `2026-09-02T0${i}:00:00Z`,
      row: { served: [9999] },
    })
  }
  return base
}

test('a read taken while the entry was already refuted is in NEITHER cohort arm', () => {
  // The legacy spelling: a plain `read` row, which is what every archived job
  // carries. The positional fold is what has to catch this one.
  const base = exposureCorpus({ fourthRow: { read: [MEMORY] } })
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.deepEqual(
    cohort.used.map((t) => t.trial),
    [`${TASK}__u1`, `${TASK}__u2`, `${TASK}__u3`],
    'the refuted-time read is not treatment: it was served the verdict, not the construction',
  )
  assert.deepEqual(
    cohort.exposedWhileRefuted.map((t) => t.trial),
    [`${TASK}__u4`],
  )
  assert.ok(
    !cohort.notUsed.some((t) => t.trial === `${TASK}__u4`),
    'nor control: padding p0 with a trial that DID see the warning biases the arm it is ' +
      'compared against, on the same datum',
  )
  assert.ok(
    !cohort.excluded.some((t) => t.trial === `${TASK}__u4`),
    'exposure is a classification, not a measurement failure — it gets its own bucket',
  )
  // The rows say HOW, which is what the fold reads.
  assert.deepEqual(cohort.used.map((t) => t.how), ['authored', 'read', 'read'])
  // And the alarm still sees the streak the real evidence produced.
  const alarm = refutationAlarm(cohort, BASE_DEFAULTS)
  assert.equal(alarm.streak, 2)
  assert.equal(alarm.usedTotal, 3)
  assert.equal(alarm.usedPass, 1)
})

test('the proxy KEY reaches the same verdict as the fold, one step earlier', () => {
  // `read_refuted` is not in USED_KEYS at all, so a current-proxy row never
  // becomes a used trial. The two sources must agree, or a sweep's numbers depend
  // on which proxy binary wrote its log.
  const base = exposureCorpus({
    fourthRow: { read_refuted: [MEMORY], refuted_at_read: true },
  })
  const cohort = cohortForMemory(base, TASK, MEMORY)
  assert.deepEqual(
    cohort.used.map((t) => t.trial),
    [`${TASK}__u1`, `${TASK}__u2`, `${TASK}__u3`],
  )
  assert.ok(
    !cohort.notUsed.some((t) => t.trial === `${TASK}__u4`),
    'a trial the proxy recorded as a refuted read is not a control trial either',
  )
})

test('the APPLIED recount payload excludes the refuted-time read, and SAYS how many', async () => {
  const { usedRowsForMemory, buildRecountAcrossTasks } = await import('./refutation-watch.mjs')
  const base = exposureCorpus({ fourthRow: { read: [MEMORY] } })
  const rows = await usedRowsForMemory(base, MEMORY)
  assert.deepEqual(rows.map((r) => r.how), ['authored', 'read', 'read', 'read'])
  const call = buildRecountAcrossTasks(MEMORY, rows, { streak: 2, p: 0.0025 })
  assert.equal(call.arguments.graded_successes, 1, 'the refuted-time pass is not in the ledger')
  assert.equal(call.arguments.graded_failures, 2)
  assert.equal(call.arguments.consecutive_failures, 2, 'so the entry stays refuted')
  assert.equal(call.arguments.last_outcome, 'failure')
  assert.match(call.arguments.source, /1 exposed-while-refuted/)
})

test('the alert row and the recount scope both carry the exposure count', async () => {
  const base = exposureCorpus({ fourthRow: { read: [MEMORY] } })
  const trialDir = join(base, 'jobs', `j-${TASK}__u4`, `${TASK}__u4`)
  const calls = []
  const out = await runRefutationWatch({
    base,
    trialDir,
    memoryIds: [MEMORY],
    apply: true,
    callTool: async (p) => {
      calls.push(p)
      return {
        res: { ok: true },
        text: JSON.stringify({
          result: {
            content: [
              {
                text: JSON.stringify({
                  memory_id: MEMORY,
                  outcome: { graded_successes: 1, graded_failures: 2 },
                }),
              },
            ],
          },
        }),
      }
    },
    cfg: BASE_DEFAULTS,
  })
  assert.equal(out.rows[0].exposed_while_refuted, 1)
  assert.equal(out.rows[0].fires, true, 'the streak the real evidence produced still fires')
  assert.equal(out.rows[0].recount_scope.exposed_while_refuted, 1)
  assert.equal(out.rows[0].recount_scope.trials, 4, 'what the walk FOUND, beside what it counted')
  // The row is the canonical record, and `stop-gate-audit.mjs` reads it back.
  const alerts = JSON.parse(
    readFileSync(join(base, 'jobs', `j-${TASK}__u4`, 'memory-refutation-alerts.jsonl'), 'utf8')
      .trim()
      .split(NL)
      .pop(),
  )
  assert.equal(alerts.exposed_while_refuted, 1)
})

// ── THE MCP TRANSPORT MUST BOUND ITS OWN WAIT ────────────────────────────────
//
// ⛔ FAILS ON THE PRE-CHANGE TREE: `transportFor` called `fetch(url, {...})`
// with no `signal` and took no options, so (a) there was nothing to inject a
// fake fetch through and the first case below could not be written at all, and
// (b) a fetch that never answers waited out undici's 300 s default. The watch
// runs at the END of every trial against a brain the trial may have just
// outlived — the MCP idle watchdog has shut the brain down mid-trial before
// (2026-09-01, filter-js-from-html, where the Stop hook's own request came back
// "upstream unreachable"). Across an unattended 89-task sweep that is up to
// five dead minutes per trial, per call.
test('the MCP transport bounds its wait, and a timeout is not fatal', async () => {
  // Honours the signal the transport passes; without one it would hang forever,
  // which is precisely the pre-change behaviour.
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })

  const started = Date.now()
  const call = transportFor('http://127.0.0.1:9/mcp', 'tok', {
    timeoutMs: 150,
    fetchImpl: hangingFetch,
    label: 'test',
  })
  const out = await call({ name: 'brain_get_entry', arguments: { id: 1 } })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 5000, `waited ${elapsed}ms — the bound did not fire`)
  // NOT a throw: crediting is post-processing and the trial's result.json is
  // already written, so an unreachable brain must cost one call, not the run.
  assert.equal(out.res.ok, false)
  assert.match(out.text, /timed out after 150ms/)
})

test('every MCP call carries an abort signal', async () => {
  let seen = null
  const call = transportFor('http://127.0.0.1:9/mcp', 'tok', {
    fetchImpl: (_u, init) => {
      seen = init
      return Promise.resolve({ ok: true, status: 200, text: async () => '{"result":{}}' })
    },
  })
  await call({ name: 'brain_search', arguments: {} })
  assert.ok(seen && seen.signal, 'the request was sent with no AbortSignal')
  assert.equal(typeof seen.signal.aborted, 'boolean')
})
