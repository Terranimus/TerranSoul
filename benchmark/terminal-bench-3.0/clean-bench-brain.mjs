#!/usr/bin/env node
// Make an isolated bench store task-naive, then PROVE it by retrieval.
//
//   node clean-bench-brain.mjs --port 7424 --tasks <dir> [--apply]
//
// Two steps, and the second is the one that matters:
//
//   1. DELETE the entries that name a benchmark task, through `brain_delete_memory`
//      rather than SQL. A raw DELETE leaves the FTS index and the vector index
//      holding rows the table no longer has, so search returns ids that resolve
//      to nothing — a store that looks clean and answers wrong.
//
//   2. AUDIT BY RETRIEVAL, using the product's own `auditRetrieval`. Grepping a
//      store for answers is not a purity test: measured 2026-08-16, a store with
//      ZERO answer tokens still returned, at rank 1, a lesson naming the task and
//      quoting a previous attempt's approach. Purity is a property of what the
//      store HANDS OVER, not of what it contains.
//
// Dry by default. `--apply` is required to delete anything.

import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { auditRetrieval, formatAudit } from '../../packages/terransoul-cli/src/purity.mjs'
import { seedBrain } from './seed-bench-brain.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const PORT = Number(flag('--port', 7424))
const TASKS_DIR = flag(
  '--tasks',
  join(process.env.USERPROFILE || process.env.HOME || '', '.cache/harbor/tasks/packages/terminal-bench'),
)
const TOKEN_FILE = flag('--token', 'mcp-data-tbench-clean/mcp-token.txt')
const DATA_DIR = flag('--data-dir', 'mcp-data-tbench-clean')
const APPLY = args.includes('--apply')
const URL = `http://127.0.0.1:${PORT}/mcp`
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim()

let id = 0
async function rpc(method, params) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 200)}`)
  const body = JSON.parse(text.replace(/^data:\s*/gm, '').trim().split('\n').filter(Boolean).pop())
  if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error).slice(0, 200)}`)
  return body.result
}

const callTool = async (name, argsObj) => {
  const out = await rpc('tools/call', { name, arguments: argsObj })
  // ⛔ DO NOT NAIVELY JOIN EVERY CONTENT BLOCK. MEASURED 2026-08-24.
  //
  // The MCP router appends a "[MCP COMPLIANCE] Preflight steps incomplete"
  // TEXT BLOCK to some responses (session bookkeeping aimed at the operator,
  // not the caller). Joining it onto the JSON payload produced
  // `[{...}]⚠️ [MCP COMPLIANCE] ...`, which JSON.parse rejects -- and the
  // offender scan's `catch { continue }` then skipped that task name entirely
  // and moved on. An unknown subset of the 89 purity queries silently returned
  // "nothing found", and the audit reported CLEAN. Fail-open, in the one
  // direction that invalidates a leaderboard submission.
  //
  // The fix keeps every block but hands back the JSON one: prefer the first
  // block that actually parses, so an extra advisory block can never again be
  // mistaken for an empty result.
  const blocks = (out?.content ?? []).map((b) => b.text ?? '')
  let text = blocks.join('')
  for (const b of blocks) {
    const t = b.trim()
    if (!t.startsWith('[') && !t.startsWith('{')) continue
    try {
      JSON.parse(t)
      text = t
      break
    } catch {
      // not this block
    }
  }
  return { text, isError: Boolean(out?.isError) }
}

// THE TASK ROSTER IS READ FROM THE DATASET, never hardcoded. A list compiled
// into a script is stale the day the benchmark adds a task, and it would put
// benchmark identity into our source (`rules/bench-agi-purity.md`).
// A Harbor task is a DIRECTORY. Reading every dirent also picked up
// README.md, which then became both a forbidden TERM and an audit QUERY:
// "README.md" matched any lesson that merely mentions a readme, so the audit
// reported NOT CLEAN on a store with no task leak at all. An audit that cries
// wolf is one an operator learns to wave through -- the badge-cascade false
// alarm rules/mcp-response-audit.md exists to stop -- and here it would hide a
// REAL hit in the noise.
const taskNames = readdirSync(TASKS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name)
console.log(`[clean] ${taskNames.length} task names read from ${TASKS_DIR}`)
// ⛔ AN EMPTY ROSTER MUST NOT CERTIFY ANYTHING. With no task names every
// comparison below trivially finds nothing, the retrieval audit reports CLEAN
// and this exits 0 -- a green result produced by having asked no questions.
// The sibling checker (store-purity-check.mjs) already refuses this exact case;
// this one did not, and two checkers disagreeing about their own failure mode
// is how an operator ends up trusting the weaker one.
if (taskNames.length === 0) {
  console.error(`[clean] REFUSING: no task directories under ${TASKS_DIR}.`)
  console.error('[clean] A purity result computed against an empty roster is meaningless, not clean.')
  process.exit(2)
}

// Find offenders through the store's own search, so this sees what a CLIENT
// would see rather than what the file happens to contain.
const offenders = new Map()
for (const name of taskNames) {
  const { text, isError } = await callTool('brain_search', { query: name, limit: 5 })
  if (isError) continue
  let hits = []
  try {
    hits = JSON.parse(text)
  } catch {
    continue
  }
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (String(hit?.content ?? '').toLowerCase().includes(name.toLowerCase())) {
      if (!offenders.has(hit.id)) offenders.set(hit.id, new Set())
      offenders.get(hit.id).add(name)
    }
  }
}

// ── PROVENANCE SCAN: the search above CANNOT find what it cannot retrieve ────
//
// The loop above asks the store's own search for each task name and keeps the
// top 5. That is the right question for the AUDIT at the end -- it measures
// what a client would actually be handed. It is the WRONG question for
// DELETION, and on 2026-08-23 the difference mattered: a lesson naming a task
// sat in the store, did not rank in the top 5 for that task's own name, was
// therefore never offered for deletion, and the retrieval audit then reported
// CLEAN. Two independent checks failed in the SAME direction, which is the
// direction that invalidates a submission.
//
// This is the brain's own PURITY-AUDIT-1 lesson, restated by experience: a
// semantic search samples, it does not scan; audit PROVENANCE, not retrieval.
// So every row is scanned here, and the two sets are unioned -- search may
// still catch a paraphrase this substring match misses.
try {
  const db = new DatabaseSync(join(DATA_DIR, 'memory.db'), { readOnly: true })
  const lowered = taskNames.map((n) => [n, n.toLowerCase()])
  for (const row of db.prepare('SELECT id, content, tags FROM memories').all()) {
    const hay = `${row.content ?? ''} ${row.tags ?? ''}`.toLowerCase()
    for (const [name, lc] of lowered) {
      if (!hay.includes(lc)) continue
      if (!offenders.has(row.id)) offenders.set(row.id, new Set())
      offenders.get(row.id).add(name)
    }
  }
} catch (err) {
  // Refuse to certify a store this could not read: a scan that silently did
  // not happen is exactly the fail-open being closed here.
  console.error(`[clean] REFUSING: provenance scan could not read ${join(DATA_DIR, 'memory.db')}: ${err.message}`)
  console.error('[clean] Pass --data-dir for the store behind --port. Search-only detection is not sufficient.')
  process.exit(2)
}

console.log(`[clean] ${offenders.size} entr(ies) name a task:`)
for (const [memId, names] of offenders) {
  console.log(`   id=${memId}  ${[...names].join(', ')}`)
}

if (!APPLY) {
  console.log('\n[clean] DRY RUN — pass --apply to delete. Nothing was changed.')
} else {
  for (const memId of offenders.keys()) {
    const { text, isError } = await callTool('brain_delete_memory', { id: memId })
    console.log(`   delete ${memId}: ${isError ? 'ERROR ' : ''}${text.slice(0, 90)}`)
  }
}

// ── the disclosed prior ────────────────────────────────────────────────────
//
// `--seed <file>` ingests GENERIC transferable technique so the first attempt
// is not starting from nothing. This is legitimate under
// `rules/bench-agi-purity.md` — "generic transferable technique may persist;
// task-specific knowledge may not" — and it is also AUTHOR-WRITTEN rather than
// agent-learned, which is a different thing from self-improvement and must
// never be reported as it. Every entry is re-checked against the task roster
// before it is written, so a seed that names a task is refused rather than
// ingested.
//
// The application itself lives in `seed-bench-brain.mjs`, which
// `start-bench-stack.mjs` also calls — because a seed step that exists in two
// implementations is a seed step that will eventually be applied two different
// ways. Behaviour change on adoption, and deliberate: a lesson naming a task
// now REFUSES THE WHOLE SEED instead of being skipped with the rest written. A
// partial seed is a third state that looks like neither a seeded store nor an
// unseeded one, and nothing downstream records which lessons made it.
const SEED = flag('--seed', null)
if (SEED) {
  try {
    await seedBrain({
      url: `http://127.0.0.1:${PORT}`,
      token: TOKEN,
      seedPath: SEED,
      tasksDir: TASKS_DIR,
      dryRun: !APPLY,
      log: (line) => console.log(line),
    })
    if (!APPLY) console.log('[seed] DRY RUN — pass --apply to write the seed.')
  } catch (err) {
    console.error(`[seed] REFUSING: ${err.message}`)
    process.exit(2)
  }
}

// ── the proof ──────────────────────────────────────────────────────────────
// Queries an agent would plausibly write. Built from the task NAME because that
// is the strongest probe available: if the store will not surface an entry for
// the task's own name, it will not surface one for a paraphrase either.
const report = await auditRetrieval({
  search: async (query, limit) => {
    const { text, isError } = await callTool('brain_search', { query, limit })
    if (isError) throw new Error(text.slice(0, 120))
    try {
      return JSON.parse(text)
    } catch {
      return []
    }
  },
  queries: taskNames,
  forbidden: taskNames,
  depth: 5,
})

console.log('\n' + formatAudit(report))
process.exit(report.clean ? 0 : 1)
