#!/usr/bin/env node
/**
 * `served-memory-audit.mjs` — which memories are being served into FAILURES?
 *
 *   usage: node served-memory-audit.mjs [--base <dir>] [--task <name>] [--min N]
 *
 * ⛔ THE GAP THIS CLOSES: the store records WHAT it was asked, never HOW IT WENT.
 *
 * Measured 2026-09-02: of 2131 memories in the production brain, 21 carried a
 * success and ZERO carried a failure. The debit half of the self-improvement
 * loop had never fired, so a lesson could be served into fifty graded zeros and
 * keep its rank. One such row -- importance 10, "you cannot round-trip through
 * a parser" -- was cited almost verbatim by successive attempts as their
 * deciding evidence on a task where that advice cannot pass.
 *
 * `credit-trial-outcome.mjs` fixes this going FORWARD, one trial at a time. It
 * needs the proxy's `served` log, which only 23 job dirs have. This reads the
 * same signal out of the AGENT TRANSCRIPT instead, which every trial has --
 * validated against a trial that had both, where the two agreed exactly.
 *
 * ⛔ READ-ONLY BY DESIGN, AND THAT IS NOT TIMIDITY.
 *
 * "Served into a failing trial" is CORRELATION, not attribution. Most trials on
 * a hard task fail, so a broadly-useful memory retrieved everywhere would
 * accrue failures simply for being popular, and mass-writing that would demote
 * good rows for being well-retrieved. This tool therefore RANKS candidates for
 * a human to judge; `credit-trial-outcome.mjs` remains the only writer, at
 * one-trial granularity where the link is tight.
 *
 * Read the LIFT column, not the failure count: a memory served only into
 * failures on a task whose base rate is 50% is interesting; the same count on a
 * task nothing has ever passed says nothing at all.
 *
 * ⛔ IDS ARE NOT GLOBALLY UNIQUE ACROSS BRAINS, AND THIS TOOL CANNOT TELL.
 *
 * Trials run against whichever brain `BRAIN_PORT` pointed at: production
 * (:7423, ids ~24000-26000 here) by default, the isolated bench brain (:7424,
 * ids ~1-1500) under TB_PROXY_MODE=learn. A transcript records the id and not
 * the store, so id 1153 from a learn-mode trial and id 1153 from production are
 * DIFFERENT MEMORIES and would be summed together.
 *
 * The first run of this tool showed exactly that: a 1xxx band and a 25xxx/26xxx
 * band ranked side by side. So use `--min-id` / `--max-id` to confine a run to
 * ONE id band before drawing any conclusion, and never read an unbounded run as
 * a single ranking. A cross-brain row is not a strong signal; it is two weak
 * signals added up by mistake.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runWasSound } from './trial-outcome.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}
const BASE = flag('--base', 'D:/Git/TerranSoulApp/benchmark/terminal-bench-2.1')
const TASK = flag('--task', null)
const MIN = Number.parseInt(flag('--min', '3'), 10) || 3
// Confine a run to ONE brain's id band -- see the id-space warning above.
const MIN_ID = Number.parseInt(flag('--min-id', '0'), 10) || 0
const MAX_ID = Number.parseInt(flag('--max-id', String(Number.MAX_SAFE_INTEGER)), 10)

/** Memory ids a trial's agent was actually shown, from its transcript. */
export function servedIdsFromTranscript(text) {
  const ids = new Set()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const content = o?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_result') continue
      let txt = b.content
      if (Array.isArray(txt)) txt = txt.map((x) => x?.text ?? '').join(' ')
      if (typeof txt !== 'string') continue
      // A brain_search result is a JSON array of rows carrying integer ids.
      // Anything else is not a retrieval and is skipped in silence.
      try {
        const rows = JSON.parse(txt)
        if (!Array.isArray(rows)) continue
        for (const r of rows) if (Number.isInteger(r?.id)) ids.add(r.id)
      } catch {
        /* not a retrieval payload */
      }
    }
  }
  return [...ids]
}

/**
 * A trial's parsed `result.json`, or null when it cannot be read — null makes
 * runWasSound() fail safe towards counting the trial, so an unreadable file can
 * never silently delete a genuine verdict.
 */
function readResult(trialDir) {
  try {
    return JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Per-memory {task -> {served, failed}} across every graded trial on disk. */
export function collect(base, taskFilter, since = null) {
  const perMemory = new Map()
  const taskTotals = new Map()
  let roots
  try {
    roots = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('jobs'))
      .map((d) => join(base, d.name))
  } catch {
    return { perMemory, taskTotals }
  }
  for (const root of roots) {
    let jobs
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
      // Ids are reissued when a store is rebuilt, so a caller confining itself
      // to one store GENERATION filters by the job dir's own date. An undated
      // job cannot be placed in a generation and is excluded when `since` is
      // set, rather than guessed into one.
      if (since) {
        const m = job.match(/-(20\d{6})-/)
        if (!m || m[1] < since) continue
      }
      let trials
      try {
        trials = readdirSync(jp)
      } catch {
        continue
      }
      for (const t of trials) {
        const task = t.split('__')[0]
        if (taskFilter && task !== taskFilter) continue
        const tp = join(jp, t)
        const rp = join(tp, 'verifier', 'reward.txt')
        if (!existsSync(rp)) continue // ungraded carries no verdict
        let reward
        try {
          reward = Number(readFileSync(rp, 'utf8').trim())
        } catch {
          continue
        }
        if (!Number.isFinite(reward)) continue
        // ⛔ A TRIAL THAT WAS NEVER A FAIR TEST CARRIES NO VERDICT, and this is
        // the collector BOTH the LIFT report and the bulk `--apply` writer in
        // backfill-served-outcomes.mjs read. Leaving these in does two separate
        // kinds of damage: the base rate below is computed over trials the agent
        // never got to attempt, and --apply would write real failure increments
        // for them into memory ranking. See runWasSound() in trial-outcome.mjs
        // for the measurement (40 never ran; 8 were cut off mid-run, and every
        // one of those 8 had already been served memories).
        if (!runWasSound(readResult(tp), reward)) continue
        const failed = reward <= 0

        const tot = taskTotals.get(task) ?? { n: 0, failed: 0 }
        tot.n += 1
        if (failed) tot.failed += 1
        taskTotals.set(task, tot)

        const sdir = join(tp, 'agent', 'sessions', 'projects', '-app')
        let files
        try {
          files = readdirSync(sdir).filter((f) => f.endsWith('.jsonl'))
        } catch {
          continue
        }
        for (const f of files) {
          let text
          try {
            text = readFileSync(join(sdir, f), 'utf8')
          } catch {
            continue
          }
          for (const id of servedIdsFromTranscript(text)) {
            if (!perMemory.has(id)) perMemory.set(id, new Map())
            const byTask = perMemory.get(id)
            const cur = byTask.get(task) ?? { served: 0, failed: 0 }
            cur.served += 1
            if (failed) cur.failed += 1
            byTask.set(task, cur)
          }
        }
      }
    }
  }
  return { perMemory, taskTotals }
}

/**
 * LIFT is the point. A memory's failure rate MINUS the base failure rate of the
 * tasks it was served on. Positive means it is over-represented in failures
 * relative to what those tasks do anyway; ~0 means it is just present.
 */
export function rank(perMemory, taskTotals, min, minId = 0, maxId = Number.MAX_SAFE_INTEGER) {
  const out = []
  for (const [id, byTask] of perMemory) {
    let served = 0
    let failed = 0
    let expected = 0
    for (const [task, c] of byTask) {
      served += c.served
      failed += c.failed
      const tot = taskTotals.get(task)
      expected += c.served * (tot && tot.n ? tot.failed / tot.n : 0)
    }
    if (served < min) continue
    if (id < minId || id > maxId) continue
    const rate = failed / served
    const base = expected / served
    out.push({ id, served, failed, rate, base, lift: rate - base })
  }
  return out.sort((a, b) => b.lift - a.lift || b.served - a.served)
}

if (process.argv[1]?.endsWith('served-memory-audit.mjs')) {
  const { perMemory, taskTotals } = collect(BASE, TASK)
  const ranked = rank(perMemory, taskTotals, MIN, MIN_ID, MAX_ID)
  console.log(`memories seen in transcripts : ${perMemory.size}`)
  console.log(`tasks covered                : ${taskTotals.size}`)
  console.log(`shown below                  : served >= ${MIN}${TASK ? `, task = ${TASK}` : ''}`)
  const bands = new Set([...perMemory.keys()].map((i) => (i < 20000 ? 'bench(:7424)' : 'production(:7423)')))
  if (bands.size > 1 && MIN_ID === 0 && MAX_ID === Number.MAX_SAFE_INTEGER) {
    console.log('')
    console.log(`  !! ${bands.size} ID BANDS PRESENT (${[...bands].join(', ')}) -- ids are per-brain, so this`)
    console.log('     ranking SUMS DIFFERENT MEMORIES. Re-run with --min-id/--max-id to confine it.')
  }
  console.log('')
  console.log('  id      served  failed   rate    base   LIFT')
  for (const r of ranked.slice(0, 25)) {
    console.log(
      `  ${String(r.id).padEnd(8)}${String(r.served).padStart(4)}${String(r.failed).padStart(8)}` +
        `${r.rate.toFixed(2).padStart(8)}${r.base.toFixed(2).padStart(8)}${r.lift >= 0 ? '  +' : '  '}${r.lift.toFixed(2)}`,
    )
  }
  console.log('')
  console.log('LIFT = this memory\'s failure rate MINUS the base failure rate of the tasks it')
  console.log('was served on. Correlation, NOT attribution: a hard task fails with or without')
  console.log('any given row. Use this to pick what to READ, never as a verdict.')
}
