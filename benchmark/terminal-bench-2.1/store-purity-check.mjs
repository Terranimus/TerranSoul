#!/usr/bin/env node
// Fast PROVENANCE purity check on a bench memory store, run before a trial.
//
//   node store-purity-check.mjs --data-dir mcp-data-tbench-clean --tasks <dir>
//
// WHY PROVENANCE AND NOT RETRIEVAL. The brain's own PURITY-AUDIT-1 lesson
// (2026-08-16) records the trap: a semantic search reports CLEAN on a store
// whose seed SQL demonstrably contains the task names, because top-k answers
// "what is most similar" and not "does any row contain this string". That
// failure is ASYMMETRIC -- it fails OPEN, silently certifying a contaminated
// store, which is the direction that invalidates a submission. So this scans
// every row.
//
// It complements, and does not replace, clean-bench-brain.mjs's retrieval
// audit: that one answers "what would the agent actually be handed", which is
// the question that matters once a store is believed clean. This one is cheap
// enough (a few thousand rows, tens of milliseconds) to run before EVERY trial,
// so a store that drifts mid-sweep is caught at the next task rather than at
// submission time.
//
// Exit 0 = clean. Exit 3 = contaminated (names printed). Exit 2 = cannot check.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const dataDir = flag('--data-dir', '')
const tasksDir = flag('--tasks', '')

if (!dataDir || !tasksDir) {
  console.error('[purity] usage: --data-dir <dir> --tasks <dir>')
  process.exit(2)
}
const dbPath = join(dataDir, 'memory.db')
if (!existsSync(dbPath)) {
  console.error(`[purity] no memory.db under ${dataDir} — cannot verify, refusing to assume clean`)
  process.exit(2)
}

// A Harbor task is a DIRECTORY. Files such as README.md are not tasks, and
// treating them as forbidden terms makes the check cry wolf on any lesson that
// mentions a readme — an alarm an operator learns to wave through.
let terms
try {
  terms = readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name.toLowerCase())
    .filter((n) => n.length >= 4)
} catch (err) {
  console.error(`[purity] cannot read tasks dir ${tasksDir}: ${err.message}`)
  process.exit(2)
}
if (!terms.length) {
  console.error(`[purity] no task directories under ${tasksDir} — refusing to certify against an empty list`)
  process.exit(2)
}

let rows
try {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  rows = db.prepare('SELECT id, content, tags FROM memories').all()
} catch (err) {
  console.error(`[purity] cannot read ${dbPath}: ${err.message}`)
  process.exit(2)
}

const hits = []
for (const row of rows) {
  const hay = `${row.content || ''} ${row.tags || ''}`.toLowerCase()
  const named = terms.filter((t) => hay.includes(t))
  if (named.length) hits.push({ id: row.id, named })
}

// ── CHECK 2: AN ANSWER FINGERPRINT THAT NAMES NO TASK ───────────────────────
//
// ⛔ CHECK 1 IS NAME-BASED, AND A LESSON CAN CARRY A TASK'S ANSWER WITHOUT EVER
// NAMING IT. Measured 2026-09-01: memory 26496 in this very store holds
// "the image sits at 0x400000 and EVERY key is off by that", "Skip disassembly
// and section-by-section work entirely" and "drop words >= 0x80000000 ... cost
// ~7%". It names no task directory, so check 1 certified the store CLEAN.
//
// It is not inert. Across all 34 extract-elf trials in the repo: that lesson
// present in the trajectory -> 0/15 passes; absent -> 14/19 (73.7%). The agent
// reads it and says "Memory's recipe matches this binary exactly". A stored
// answer that is WRONG is worse than no memory at all, and this is the shape
// `rules/bench-agi-purity.md` forbids.
//
// THE SIGNAL, and why it is this narrow. `0x400000` appears in NO task's
// instruction.md, so it cannot have come from a prompt — it came from solving.
// But scanning CONTENT for long hex flags 33 of 2192 rows, nearly all benign
// (CSS colour tokens like 0x9aa3ad from the app's design work, a Windows error
// code 0xc0000142 from a session note). A gate that cries wolf is one an
// operator learns to wave through — this file's own comment above says so.
//
// Scanning TAGS is precise. Tags are curated keywords; a raw address is not a
// topic, it is a remembered answer. Measured over the same 2192 rows: exactly
// ONE row flagged, and it is 26496. Zero false positives.
//
// SCOPE, honestly: this catches constant-as-tag. It does NOT catch every
// answer-derived lesson — e.g. one whose tags name only tools the prompt itself
// mentions. It closes the shape that was measured to cost a task.
//
// ⛔ TWO WIDER SIGNALS WERE MEASURED AND REJECTED. Recorded so they are not
// re-derived; both fail the same way, by crying wolf.
//
//   (a) SCAN CONTENT for long hex, not just tags.
//       33 of 2192 rows flagged, nearly all benign: CSS colour tokens from the
//       app's own design work (0x9aa3ad, 0xf9fafb, 0x6b7280) and a Windows
//       error code from a session note (0xc0000142).
//
//   (b) FLAG A TAG THAT APPEARS IN EXACTLY ONE TASK'S PROMPT, on the theory
//       that single-task vocabulary is task-identifying even when it is not the
//       directory name. 500 of 2192 rows flagged (22.8%) — on ordinary words
//       that happen to occur in one prompt: `settings`, `voice`, `continue`,
//       `mobile`, `debugging`, `math`, `windows`. Worse, it MISSED the rows it
//       was designed for (26477, 26531, 26556) while flagging hundreds of
//       innocents. Precision and recall both bad.
//
//   (c) FLAG A LESSON THAT ASSERTS GRADER BEHAVIOUR ("the grader compares...",
//       "the checker recovers...", "grader mismatch"), on the theory that an
//       agent cannot read the grader, so such a claim is answer-derived by
//       construction. 47 of 2192 rows (2.1%) — a promising rate, and it caught
//       4 of 6 known suspects. REJECTED ANYWAY on inspection: the flagged set
//       is dominated by LEGITIMATE generic technique ("the grader checks one
//       exact answer" as a task SHAPE; "you cannot tell whether your local
//       evaluation matches the grader's" as advice to build a local checker)
//       and by the purity-doctrine lessons themselves.
//
//       ⛔ AND THE BRAIN ALREADY SAID SO. Memory 25947 records exactly this
//       false-positive mode: "matching the benchmark's bare name fires on
//       nearly every row, because HONEST LESSONS DISCUSS THE HARNESS BY NAME
//       TOO." That was written before this attempt and would have refuted it in
//       one search. Search the brain BEFORE designing a purity signal — all
//       three rejected designs here cost measurement time that a `brain_search`
//       would have saved.
//
// WHAT REMAINS OPEN, stated plainly: the bench store still holds task-specific
// lessons this file cannot detect — e.g. a dna-insert cluster tagged
// `primer-design, oligotm, Q5, BsaI, golden gate, annealing region ambiguity`,
// one of them literally tagged `grader mismatch`. They name no task directory
// and carry no magic constant. `rules/bench-agi-purity.md` forbids them, but
// the test it implies ("would this read identically for a task about a
// different subject?") is a JUDGEMENT, and no mechanical proxy for it has
// survived measurement. Use `memory-outcome-audit.mjs` to find the ones that
// actually correlate with failure rather than guessing from the text.
const MAGIC_TAG = /^0x[0-9a-fA-F]{4,}$|^[0-9a-fA-F]{8,}$/
let promptText = ''
try {
  for (const d of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const p = join(tasksDir, d.name, 'instruction.md')
    if (existsSync(p)) promptText += `\n${readFileSync(p, 'utf8')}`
  }
} catch {
  // A prompt corpus we cannot read means we cannot tell derived from quoted.
  // Leave promptText empty: every magic tag then reads as unexplained, which
  // fails LOUD rather than silently certifying.
}
promptText = promptText.toLowerCase()

const fingerprints = []
for (const row of rows) {
  const tags = String(row.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const magic = tags.filter((t) => MAGIC_TAG.test(t)).filter((t) => !promptText.includes(t.toLowerCase()))
  if (magic.length) fingerprints.push({ id: row.id, magic })
}

if (fingerprints.length) {
  console.error(
    `[purity] REFUSING: ${fingerprints.length} of ${rows.length} rows in ${dataDir} tag a magic constant that appears in NO task prompt.`,
  )
  for (const f of fingerprints.slice(0, 20)) console.error(`[purity]   id=${f.id}  ${f.magic.join(', ')}`)
  console.error('[purity] A constant absent from every prompt cannot have been read; it was SOLVED for.')
  console.error('[purity] Measured: one such row correlates with 0/15 passes on its task vs 14/19 without it.')
  process.exit(3)
}

if (hits.length) {
  console.error(
    `[purity] REFUSING: ${hits.length} of ${rows.length} rows in ${dataDir} name a benchmark task.`,
  )
  for (const h of hits.slice(0, 20)) console.error(`[purity]   id=${h.id}  ${h.named.join(', ')}`)
  if (hits.length > 20) console.error(`[purity]   ... and ${hits.length - 20} more`)
  console.error('[purity] The leaderboard judge classes prior-run post-mortems as harness_level_cheating,')
  console.error('[purity] which renders a submission invalid. Clean the store first:')
  console.error(`[purity]   node benchmark/terminal-bench-3.0/clean-bench-brain.mjs --port <p> --tasks ${tasksDir} --apply`)
  process.exit(3)
}

console.log(`[purity] clean — ${rows.length} rows scanned against ${terms.length} task names in ${dataDir}`)
