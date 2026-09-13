#!/usr/bin/env node
/**
 * `memory-outcome-audit.mjs` — which SERVED memories correlate with FAILURE?
 *
 *   usage: node memory-outcome-audit.mjs <jobs-dir> [<jobs-dir> ...] [--data-dir <dir>] [--min N]
 *
 * ⛔ THE DEFECT CLASS THIS FINDS: A STORED ANSWER THAT IS WRONG IS WORSE THAN
 * NO MEMORY AT ALL, AND NOTHING WAS LOOKING FOR IT.
 *
 * MEASURED 2026-09-01. Memory 26496 held a solution recipe for one task
 * ("the image sits at 0x400000 and EVERY key is off by that", "Skip
 * disassembly and section-by-section work entirely"). Across all 34 graded
 * trials of that task: served -> 0/15 passed; not served -> 14/19 (73.7%). The
 * agent read it and wrote "Memory's recipe matches this binary exactly", then
 * followed a recipe that could not pass. The task's apparent ~48% "base rate"
 * was not variance at all — it decomposed exactly at that lesson's creation
 * date, and the campaign had been treating the task as a coin flip for weeks.
 *
 * The self-improve loop can WRITE such a lesson, and `credit-trial-outcome.mjs`
 * can lower its counters after the fact, but nothing ASKED the question this
 * asks: across the whole corpus, is there a memory whose presence predicts
 * failure? That is a retrospective, corpus-level question, so it needs a
 * corpus-level tool.
 *
 * WHY IT READS TRAJECTORIES AND NOT THE PROXY LOG. The proxy records a
 * `served` line per `brain_search`, which is the better signal — an observed
 * fact rather than an inference. But it was only added 2026-09-01, so it
 * covers 4 of 427 graded trials. Memory ids also appear structurally in the
 * trajectory (the search result is a tool result), which works RETROACTIVELY
 * over the whole corpus. Both are read; the proxy line wins where present.
 *
 * ⛔ CORRELATION, NOT PROOF, AND THE OUTPUT SAYS SO. A memory served only on
 * hard trials will look guilty. The confound that matters most here is
 * TEMPORAL: a lesson created on date D is served only after D, so it inherits
 * whatever else changed then. This prints the split and the counts and leaves
 * the causal claim to a human — 26496 was confirmed only by reading the
 * agent's own words and repairing the recipe.
 *
 * READ-ONLY. Opens job dirs and (optionally) the store; writes nothing.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runWasSound } from './trial-outcome.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const dataDir = flag('--data-dir', '')
const minTrials = Number.parseInt(flag('--min', '3'), 10) || 3
const roots = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--data-dir' && argv[i - 1] !== '--min')

// Run the scan only as a CLI. Importing this module — which the tests do, to
// exercise the two parsers — must not execute it or exit the process.
const IS_MAIN = Boolean(process.argv[1]?.endsWith('memory-outcome-audit.mjs'))

if (IS_MAIN && !roots.length) {
  console.error('usage: memory-outcome-audit.mjs <jobs-dir> [...] [--data-dir <dir>] [--min N]')
  process.exit(2)
}

/** Memory ids the proxy recorded as SERVED for this job, if it logged any. */
/**
 * A trial's parsed `result.json`, or null when unreadable — null makes
 * runWasSound() fail safe towards KEEPING the trial, so this can never silently
 * delete a genuine verdict.
 *
 * ⛔ WHY IT MATTERS HERE SPECIFICALLY, and it distorts BOTH arms at once. This
 * file's output is what decides a stored memory is poison, and acting on it
 * means deleting or demoting that memory. A trial where the agent never ran
 * served nothing, so it lands in the NOT-SERVED arm as a failure and drags the
 * baseline down — which makes every served memory look BETTER than it is. The 8
 * trials the API cut off mid-run had already been served memories, so they land
 * in the SERVED arm and make those look WORSE. Neither trial was a test of
 * anything. Measured 2026-09-08; see runWasSound() in trial-outcome.mjs.
 */
function readResult(trialDir) {
  try {
    return JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

export function servedFromProxyLog(text) {
  const ids = new Set()
  for (const line of String(text || '').split('\n')) {
    const b = line.indexOf('{')
    if (b < 0) continue
    try {
      const o = JSON.parse(line.slice(b))
      if (Array.isArray(o?.served)) for (const id of o.served) if (Number.isInteger(id)) ids.add(id)
    } catch {
      // The proxy log is a mixed stream; only some lines are JSON.
    }
  }
  return ids
}

/**
 * Memory ids visible in a trajectory.
 *
 * Structural (`"id": 26496`) rather than a bare number scan: a transcript is
 * full of five-digit numbers that are not memory ids, and the whole point of
 * this audit is to avoid the "advertisement is not use" error in a new place.
 */
export function servedFromTrajectory(text) {
  const ids = new Set()
  // The backslash is not optional pedantry: a search result is a tool result
  // nested inside the transcript's own JSON, so the ids arrive ESCAPED as
  // \"id\": on most real trajectories and plain on others. Matching only the
  // plain form silently halves the corpus.
  for (const m of String(text || '').matchAll(/\\?"id\\?"\s*:\s*(\d{4,6})\b/g)) {
    ids.add(Number(m[1]))
  }
  return ids
}

const stats = new Map() // id -> task -> {pass, fail}
let graded = 0
let withIds = 0

for (const root of IS_MAIN ? roots : []) {
  if (!existsSync(root)) continue
  for (const job of readdirSync(root)) {
    const jp = join(root, job)
    try {
      if (!statSync(jp).isDirectory()) continue
    } catch {
      continue
    }
    const logPath = join(jp, 'terransoul-proxy-calls.jsonl')
    const proxyIds = existsSync(logPath) ? servedFromProxyLog(readFileSync(logPath, 'utf8')) : new Set()

    for (const trial of readdirSync(jp)) {
      const tp = join(jp, trial)
      try {
        if (!statSync(tp).isDirectory()) continue
      } catch {
        continue
      }
      const rp = join(tp, 'verifier', 'reward.txt')
      if (!existsSync(rp)) continue // ungraded carries no outcome signal
      const reward = Number(readFileSync(rp, 'utf8').trim())
      if (!Number.isFinite(reward)) continue
      if (!runWasSound(readResult(tp), reward)) continue
      graded++

      let ids = proxyIds
      if (!ids.size) {
        const traj = join(tp, 'agent', 'trajectory.json')
        if (existsSync(traj)) {
          try {
            ids = servedFromTrajectory(readFileSync(traj, 'utf8'))
          } catch {
            ids = new Set()
          }
        }
      }
      if (!ids.size) continue
      withIds++
      const task = trial.split('__')[0]
      for (const id of ids) {
        if (!stats.has(id)) stats.set(id, new Map())
        const byTask = stats.get(id)
        if (!byTask.has(task)) byTask.set(task, { pass: 0, fail: 0 })
        byTask.get(task)[reward > 0 ? 'pass' : 'fail']++
      }
    }
  }
}

// Per-task outcome WITHOUT each suspect, so the contrast is visible rather than
// asserted. A memory that is served on every trial of a task tells us nothing.
const taskTotals = new Map()
for (const [, byTask] of stats) {
  for (const [task, c] of byTask) {
    if (!taskTotals.has(task)) taskTotals.set(task, { pass: 0, fail: 0 })
  }
}
for (const root of IS_MAIN ? roots : []) {
  if (!existsSync(root)) continue
  for (const job of readdirSync(root)) {
    const jp = join(root, job)
    try {
      if (!statSync(jp).isDirectory()) continue
    } catch {
      continue
    }
    for (const trial of readdirSync(jp)) {
      const rp = join(jp, trial, 'verifier', 'reward.txt')
      if (!existsSync(rp)) continue
      const reward = Number(readFileSync(rp, 'utf8').trim())
      if (!Number.isFinite(reward)) continue
      if (!runWasSound(readResult(join(jp, trial)), reward)) continue
      const task = trial.split('__')[0]
      if (!taskTotals.has(task)) continue
      taskTotals.get(task)[reward > 0 ? 'pass' : 'fail']++
    }
  }
}

if (IS_MAIN) {
console.log(`graded trials scanned      : ${graded}`)
console.log(`trials with memory ids     : ${withIds}`)
console.log(`distinct memories observed : ${stats.size}`)
console.log('')
console.log(`SUSPECTS — served on >= ${minTrials} graded trials of one task, never passing:`)

const suspects = []
for (const [id, byTask] of stats) {
  for (const [task, c] of byTask) {
    const n = c.pass + c.fail
    if (n < minTrials || c.pass > 0) continue
    const tot = taskTotals.get(task) ?? { pass: 0, fail: 0 }
    const without = { pass: tot.pass - c.pass, fail: tot.fail - c.fail }
    suspects.push({ id, task, n, without })
  }
}
suspects.sort((a, b) => b.n - a.n)

if (!suspects.length) {
  console.log('  none')
} else {
  for (const s of suspects) {
    const wn = s.without.pass + s.without.fail
    const wr = wn ? `${s.without.pass}/${wn} (${((100 * s.without.pass) / wn).toFixed(0)}%)` : 'n/a'
    console.log(`  memory ${s.id}  ${s.task}`)
    console.log(`      served    : 0/${s.n} passed`)
    console.log(`      NOT served: ${wr} passed`)
  }
  console.log('')
  console.log('These are CORRELATIONS. A lesson created on date D is served only after D,')
  console.log('so it inherits everything else that changed then. Confirm by reading the')
  console.log("agent's own words in the trajectory before removing anything.")
}

if (dataDir) {
  const dbPath = join(dataDir, 'memory.db')
  if (existsSync(dbPath)) {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    console.log('')
    console.log('suspect rows still present in the store:')
    for (const s of suspects) {
      const row = db.prepare('SELECT id, success_count, failure_count, LENGTH(content) len FROM memories WHERE id = ?').get(s.id)
      console.log(`  ${s.id}: ${row ? `present, ${row.len} chars, ${row.success_count}/${row.failure_count} success/fail` : 'ALREADY REMOVED'}`)
    }
  }
}
}
