#!/usr/bin/env node
// TBENCH-SEED-1 — APPLY THE DISCLOSED GENERIC PRIOR TO THE ISOLATED BENCH
// STORE, AS PART OF BRINGING THE STACK UP, OR REFUSE THE LAUNCH.
//
// WHY THIS EXISTS. On 2026-08-19 `extra-instruction-harness.md` was shrunk
// 9,098 -> 2,466 bytes, and the deleted "How to work" section was justified
// one-to-one against `generic-technique-seed.json`'s seven lessons: the prose
// copy was removed BECAUSE the same guidance lives in the memory the agent is
// supposed to retrieve from. That argument holds only if the seed is actually
// in the store. It was not wired anywhere — `clean-bench-brain.mjs` supports
// `--seed ... --apply`, but bench prep invoked it BY HAND. Ship it like that
// and a launch can produce a run with the guidance in NEITHER the prompt NOR
// the store, which is strictly worse than before the shrink and looks exactly
// like a normal run from the outside.
//
// So the seed becomes part of the stack launch (`start-bench-stack.mjs`), and
// this module is the one implementation both that launcher and
// `clean-bench-brain.mjs` call.
//
//   node seed-bench-brain.mjs --url http://127.0.0.1:7424 \
//        --token-file mcp-data-tbench-clean/mcp-token.txt \
//        --seed benchmark/terminal-bench-3.0/generic-technique-seed.json
//
// THREE PROPERTIES IT HAS TO HAVE, each for a reason this campaign has already
// been bitten by:
//
//  1. IDEMPOTENT. The stack launcher is meant to be re-runnable, so seeding
//     must not multiply rows. It does not need client-side state to manage
//     that: `AppStateGateway::ingest_lesson` holds a generic exact-content
//     dedup gate (`SELECT id FROM memories WHERE TRIM(content) = ?1`) and
//     answers `{"deduplicated":true, "memory_id":…}` instead of inserting.
//     Re-seeding is therefore a server-side no-op, and the ack says which of
//     the two happened — so this reports "N new, M already present" from the
//     SERVER's answer rather than from an assumption. That also satisfies
//     `rules/mcp-single-source-of-truth.md`: no private ledger of what we think
//     we wrote.
//  2. LOUD ON ABSENCE. A missing or empty seed file REFUSES. It must never
//     degrade to "seeded nothing, carried on" — that is the exact silent
//     no-op the shrink made dangerous.
//  3. PURE. `rules/bench-agi-purity.md`: generic transferable technique may
//     persist, task-specific knowledge may not. Every lesson is re-checked
//     against the task roster READ FROM THE DATASET (never a hardcoded list)
//     immediately before it is written, and a lesson naming a task refuses the
//     whole launch rather than being skipped — a partially applied seed is a
//     third state nobody would notice.
//
// The write goes DIRECT to the brain, not through `mcp-auth-proxy.mjs`: the
// proxy is read-only on the submission path and would refuse
// `brain_ingest_lesson` with -32001. This is bench PREP, before any agent
// exists; the agent's own path stays write-blocked.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_SEED_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'generic-technique-seed.json',
)

/** Thrown for every refusal, so callers can print one consistent receipt. */
export class SeedError extends Error {}

/**
 * Read and validate the seed file.
 *
 * @param {string} seedPath
 * @returns {{lessons: Array<{content: string, category: string}>}}
 */
export function loadSeed(seedPath) {
  if (!seedPath) throw new SeedError('no seed file was named')
  let raw
  try {
    raw = fs.readFileSync(seedPath, 'utf8')
  } catch (err) {
    throw new SeedError(
      `the seed file ${seedPath} could not be read (${err.code || err.message}). ` +
        'The shrunk extra-instruction file no longer carries this guidance, so a run without the ' +
        'seed ships it in NEITHER the prompt nor the store.',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SeedError(`the seed file ${seedPath} is not valid JSON: ${err.message}`)
  }
  const lessons = parsed?.lessons
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new SeedError(`the seed file ${seedPath} declares no lessons[] — there is nothing to apply`)
  }
  lessons.forEach((lesson, i) => {
    if (typeof lesson?.content !== 'string' || !lesson.content.trim()) {
      throw new SeedError(`lessons[${i}] in ${seedPath} has no non-empty content`)
    }
    if (typeof lesson?.category !== 'string' || !lesson.category.trim()) {
      throw new SeedError(`lessons[${i}] in ${seedPath} has no category`)
    }
  })
  return { lessons }
}

/**
 * The task roster, read from the dataset. `null` when the dataset is not on
 * this machine — the caller decides whether that is a note or a refusal.
 *
 * @param {string} tasksDir
 * @returns {string[]|null}
 */
export function readTaskRoster(tasksDir) {
  try {
    return fs.readdirSync(tasksDir).filter((n) => !n.startsWith('.'))
  } catch {
    return null
  }
}

/**
 * @param {Array<{content: string}>} lessons
 * @param {string[]} taskNames
 * @returns {Array<{index: number, names: string[]}>}
 */
export function purityViolations(lessons, taskNames) {
  const out = []
  lessons.forEach((lesson, index) => {
    const lower = lesson.content.toLowerCase()
    const names = taskNames.filter((n) => n && lower.includes(n.toLowerCase()))
    if (names.length) out.push({ index, names })
  })
  return out
}

// The MCP streamable-HTTP transport answers either JSON or SSE; take the last
// data frame either way (same parse the launchers' preflights use).
function parseRpc(text) {
  const line = text
    .replace(/^data:\s*/gm, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * Apply the seed to a brain, through MCP.
 *
 * @param {object} o
 * @param {string} o.url brain base URL or `/mcp` endpoint. NOT the proxy.
 * @param {string} o.token bearer token of the store behind `url`.
 * @param {Array<{content: string, category: string}>} o.lessons
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{written: number, deduplicated: number, total: number}>}
 */
export async function applySeed({ url, token, lessons, log = () => {}, timeoutMs = 60_000 }) {
  const endpoint = `${String(url).replace(/\/+$/, '').replace(/\/mcp$/, '')}/mcp`
  let id = 0
  let written = 0
  let deduplicated = 0

  for (const [i, lesson] of lessons.entries()) {
    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: {
            name: 'brain_ingest_lesson',
            arguments: { content: lesson.content, category: lesson.category },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw new SeedError(`lessons[${i}]: the brain at ${endpoint} could not be reached — ${err.message}`)
    }
    const text = await res.text()
    if (!res.ok) throw new SeedError(`lessons[${i}]: brain_ingest_lesson -> HTTP ${res.status}: ${text.slice(0, 200)}`)
    const body = parseRpc(text)
    if (!body) throw new SeedError(`lessons[${i}]: unparseable response: ${text.slice(0, 200)}`)
    if (body.error) throw new SeedError(`lessons[${i}]: ${JSON.stringify(body.error).slice(0, 200)}`)

    const payload = (body.result?.content ?? []).map((b) => b?.text ?? '').join('')
    if (body.result?.isError) {
      // The earned-autonomy `safe_write` gate can refuse a write on a store
      // with no trust history, and a denied retry does NOT reset its cooldown
      // (measured, mcp-data lesson `reference_mcp_earned_autonomy_quarantine_trap`).
      // That is a launch blocker, not a warning: the run would go out with the
      // guidance in neither channel.
      throw new SeedError(`lessons[${i}]: the brain REFUSED the write — ${payload.slice(0, 300)}`)
    }
    // PARSE THE FIRST BLOCK, NOT THE CONCATENATION. The MCP router appends its
    // own text blocks to a tool result — an `[MCP COMPLIANCE]` preflight notice
    // is added whenever the compliance gate has something to say (router.rs,
    // the same annotation machinery that two Terminal-Bench trials once flagged
    // as a prompt-injection attempt). Joining every block and parsing the result
    // glues that prose onto the end of the tool's JSON, so `JSON.parse` fails on
    // a response whose block[0] is perfectly well-formed.
    //
    // MEASURED: this refused a launch whose seed had in fact been applied — the
    // ack carried `{"memory_id":25996,"deduplicated":true}` and the lesson was
    // already retrievable from the store. The gate was right to be strict; its
    // model of the contract was wrong. block[0] is the tool's payload; later
    // blocks are server-side annotations and are never part of it.
    const ackText = (body.result?.content ?? [])[0]?.text ?? ''
    let ack
    try {
      ack = JSON.parse(ackText)
    } catch {
      throw new SeedError(
        `lessons[${i}]: brain_ingest_lesson answered something that is not its documented JSON ` +
          `response, so this cannot tell a write from a no-op: ${ackText.slice(0, 200)}`,
      )
    }
    if (typeof ack.memory_id !== 'number') {
      throw new SeedError(
        `lessons[${i}]: brain_ingest_lesson returned no memory_id, so the lesson is not in the ` +
          `store and this run would go out with the generic prior in neither channel: ${ackText.slice(0, 200)}`,
      )
    }
    if (ack.quarantined === true) {
      throw new SeedError(
        `lessons[${i}]: the lesson was QUARANTINED (${JSON.stringify(ack.quarantine_reasons ?? [])}), ` +
          `so it is not retrievable and the shrunk prompt has no fallback.`,
      )
    }
    if (ack.deduplicated === true) {
      deduplicated += 1
    } else {
      written += 1
    }
    log(`[seed] lessons[${i}] ${ack.deduplicated === true ? 'already present' : 'written'} id=${ack.memory_id ?? '?'}`)
  }

  return { written, deduplicated, total: lessons.length }
}

/**
 * The whole prep step: validate, purity-check, apply, report. Throws
 * `SeedError` on any refusal.
 *
 * @param {object} o
 * @param {string} o.url  @param {string} o.token  @param {string} o.seedPath
 * @param {string} [o.tasksDir] @param {(l: string) => void} [o.log]
 * @param {boolean} [o.dryRun]
 * @returns {Promise<{lessons: Array<{content: string, category: string}>, written: number, deduplicated: number, total: number}>}
 *   `lessons` comes back so a caller that validates EARLY (before it spawns
 *   anything) can hand the same, already-purity-checked list to `applySeed`
 *   later without re-reading or re-checking it.
 */
export async function seedBrain({ url, token, seedPath, tasksDir, log = () => {}, dryRun = false }) {
  const { lessons } = loadSeed(seedPath)

  const roster = tasksDir ? readTaskRoster(tasksDir) : null
  if (roster && roster.length) {
    const violations = purityViolations(lessons, roster)
    if (violations.length) {
      const detail = violations.map((v) => `lessons[${v.index}] names ${v.names.join(', ')}`).join('; ')
      throw new SeedError(
        `rules/bench-agi-purity.md: the seed names benchmark task(s) — ${detail}. ` +
          'Generic transferable technique may persist; task-specific knowledge may not.',
      )
    }
    log(`[seed] purity: ${lessons.length} lesson(s) checked against ${roster.length} task name(s) from ${tasksDir}`)
  } else {
    log(`[seed] NOTE: no task roster at ${tasksDir ?? '(unset)'} — the purity re-check could not run this launch.`)
  }

  if (dryRun) {
    log(`[seed] ${lessons.length} lesson(s) validated from ${seedPath}; nothing written (dry).`)
    return { lessons, written: 0, deduplicated: 0, total: lessons.length }
  }

  const counts = await applySeed({ url, token, lessons, log })
  log(
    `[seed] ${counts.total} generic lesson(s) applied to ${url}: ${counts.written} new, ` +
      `${counts.deduplicated} already present (server-side exact-content dedup).`,
  )
  return { lessons, ...counts }
}

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

async function main(argv) {
  const url = flag(argv, '--url')
  const seedPath = flag(argv, '--seed', DEFAULT_SEED_FILE)
  const tokenFile = flag(argv, '--token-file')
  const tasksDir = flag(
    argv,
    '--tasks',
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache/harbor/tasks/packages/terminal-bench'),
  )
  const dryRun = argv.includes('--dry-run')
  if (!url && !dryRun) {
    console.error('[seed] usage: seed-bench-brain.mjs --url <http://host:port> --token-file <path> [--seed <file>]')
    return 2
  }
  let token = ''
  if (!dryRun) {
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim()
    } catch (err) {
      console.error(`[seed] REFUSING: cannot read the token file ${tokenFile} — ${err.message}`)
      return 2
    }
  }
  try {
    await seedBrain({ url, token, seedPath, tasksDir, dryRun, log: (l) => console.log(l) })
    return 0
  } catch (err) {
    console.error(`[seed] REFUSING: ${err.message}`)
    return 2
  }
}

// Run only when invoked directly, never on import. See the same guard in
// check-served-instructions.mjs for why `pathToFileURL` and a basename
// fallback rather than a hand-built file:// string.
const invokedPath = process.argv[1] || ''
if (
  invokedPath &&
  (pathToFileURL(invokedPath).href === import.meta.url || path.basename(invokedPath) === 'seed-bench-brain.mjs')
) {
  process.exitCode = await main(process.argv.slice(2))
}
