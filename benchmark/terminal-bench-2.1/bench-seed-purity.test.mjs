#!/usr/bin/env node
/**
 * The bench store's SEED must be task-naive, not just the store.
 *
 * ⛔ THE DEFECT THIS CLOSES, AND WHY THE EXISTING GATE COULD NOT.
 *
 * `run-dg.sh` scans the live store for benchmark task names and refuses when it
 * finds any. That check is correct and it fired. But the store is REBUILT from
 * `shared/seed-lessons.sql` whenever the brain restarts and the seed checksum
 * has changed, so a seed carrying task names re-contaminates a store that was
 * clean — and the run-time gate can only report it AFTER the damage, once per
 * restart, forever.
 *
 * MEASURED 2026-09-04. The bench sweep ran all night against a store the gate
 * called clean at 2121 rows. Restarting the brain re-applied the seed
 * ("[mcp] seed snapshot re-applied (checksum change)"), and the next run was
 * refused: 3 of 2190 rows named a task. The three were harness post-mortems —
 * my own, about errored trials inflating the mean and about subagent job-dir
 * discovery — which name tasks only as incidental context ("Measured on job
 * dg-... (fix-ocaml-gc)"). Useful lessons; forbidden identifiers.
 *
 * Cleaning the rows alone would have left it to recur on the next restart. So
 * the names were redacted from the seed, and this test keeps them out: it fails
 * at commit time rather than after a restart has already poisoned a run.
 *
 * FAILS ON THE PRE-CHANGE TREE: the seed contained 11 task-name references
 * across 3 lessons (filter-js-from-html x3, fix-ocaml-gc x6, fix-git x2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SEED = join(REPO, 'mcp-data-tbench-clean', 'shared', 'seed-lessons.sql')
const TASKS = process.env.TB21_DIR
  ? join(process.env.TB21_DIR, 'tasks')
  : 'D:/Git/terminal-bench-2-1/tasks'

/**
 * Task names, longest first.
 *
 * Longest-first matters: `fix-git` is a substring of nothing here, but a short
 * name that is a prefix of a longer one would otherwise be reported for the
 * wrong lesson and send the reader to the wrong line.
 */
function taskNames() {
  if (!existsSync(TASKS)) return []
  return readdirSync(TASKS)
    .filter((d) => statSync(join(TASKS, d)).isDirectory())
    .sort((a, b) => b.length - a.length)
}

test('the BENCH seed names no benchmark task', () => {
  if (!existsSync(SEED)) {
    // A missing bench store is not a failure — it is simply not provisioned
    // here. Asserting on its absence would make this pass or fail on which
    // machine ran it.
    return
  }
  const names = taskNames()
  if (!names.length) return // no task clone on this machine
  const seed = readFileSync(SEED, 'utf8')
  // Counted with split(), not a RegExp: a task name needs no escaping this way,
  // and building a pattern from a directory name is how this file first failed
  // to parse at all.
  const hits = names
    .map((n) => [n, seed.split(n).length - 1])
    .filter(([, c]) => c > 0)
  assert.deepEqual(
    hits,
    [],
    `the bench seed names ${hits.length} benchmark task(s): ${hits.map(([n, c]) => `${n} x${c}`).join(', ')}. ` +
      `A seed is re-applied on brain restart, so this re-contaminates a clean store every time. ` +
      `Redact the identifier — the lesson itself is usually fine to keep.`,
  )
})

test('the task list is actually being read, or this test proves nothing', () => {
  // ⛔ Without this the whole file passes vacuously on a machine with no task
  // clone, which is the "measured on an empty table" shape this repo has been
  // bitten by. It asserts the fixture, not the outcome.
  if (!existsSync(TASKS)) return
  const names = taskNames()
  assert.ok(names.length > 50, `expected the 2.1 task set, got ${names.length} names`)
  assert.ok(names.includes('filter-js-from-html'), 'a known task name must be in the list')
})

/**
 * The workstream's own executable modules, scanned the same way.
 *
 * ⛔ THE SEED IS NOT THE ONLY PLACE A TASK NAME CAN DECIDE SOMETHING. The spec
 * for the refutation watch asked for its new files to join this gate's scan set,
 * and the gate had none — it read exactly one input, the seed. A task name in a
 * post-mortem COMMENT is the existing convention here and is harmless; a task
 * name in a line of CODE is a harness that behaves differently on one task,
 * which is what `rules/bench-agi-purity.md` forbids. So comments are stripped
 * and the remaining code is what is scanned.
 *
 * The grader's own artifacts are refused in the same stripped code: nothing here
 * has any business READING a task's solution directory, its test fixtures or its
 * reference output. (Comments are exempt for both scans, and deliberately so —
 * the header of `refutation-watch.mjs` earns its purity claim by NAMING the
 * things it never opens, and a gate that punished that sentence would push the
 * claim out of the file.)
 *
 * SCOPE: the modules this workstream owns. Two neighbours were in the first
 * draft of the set and both tripped it for reasons that are not contamination —
 * `task-regression-audit.mjs` prints a task name inside a piece of ADVICE it
 * emits — so widening the set is a separate change with its own edits, not a
 * silent extra.
 */
const SCANNED_MODULES = [
  'refutation-watch.mjs',
  'recount-outcomes.mjs',
  'credit-trial-outcome.mjs',
  'stop-gate-audit.mjs',
  'extract-deliverables.mjs',
  'triage-trial.mjs',
]

/** Source with block comments and whole-line comments removed. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

test('no harness module makes a DECISION on a benchmark task name', () => {
  const names = taskNames()
  if (!names.length) return // no task clone on this machine
  const offences = []
  for (const mod of SCANNED_MODULES) {
    const path = join(HERE, mod)
    if (!existsSync(path)) continue
    const code = codeOnly(readFileSync(path, 'utf8'))
    for (const n of names) {
      const c = code.split(n).length - 1
      if (c > 0) offences.push(`${mod}: ${n} x${c}`)
    }
  }
  assert.deepEqual(
    offences,
    [],
    `a benchmark task name appears in executable code: ${offences.join(', ')}. ` +
      `Task names may appear in post-mortem comments; a name that reaches a decision path makes the ` +
      `harness behave differently on one task, which is the contamination this campaign forbids.`,
  )
})

test('no harness module names the grader own reference artifacts', () => {
  // A tool that READS a task's solution or its expected output is contaminated
  // whether or not the reading is currently wired to anything.
  const forbidden = ['correct_output', 'solve.sh', 'solution/', 'tests/test_outputs']
  const offences = []
  for (const mod of SCANNED_MODULES) {
    const path = join(HERE, mod)
    if (!existsSync(path)) continue
    const code = codeOnly(readFileSync(path, 'utf8'))
    for (const f of forbidden) if (code.includes(f)) offences.push(`${mod}: ${f}`)
  }
  assert.deepEqual(offences, [], `a harness module names a grader artifact: ${offences.join(', ')}`)
})

test('the module scan is actually reading files, or it proves nothing', () => {
  // ⛔ The same vacuity guard as the task-list one above: a scan set whose files
  // do not exist passes for free. Asserts the fixture, not the outcome.
  const present = SCANNED_MODULES.filter((m) => existsSync(join(HERE, m)))
  assert.equal(present.length, SCANNED_MODULES.length, `missing from the scan set: ${
    SCANNED_MODULES.filter((m) => !existsSync(join(HERE, m))).join(', ')}`)
  const sample = codeOnly(readFileSync(join(HERE, 'refutation-watch.mjs'), 'utf8'))
  assert.ok(sample.includes('export function cohortForMemory'), 'the comment stripper removed the code too')
})
