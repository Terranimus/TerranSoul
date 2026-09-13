#!/usr/bin/env node
/**
 * `backfill-served-outcomes.mjs` — apply the harness's OWN crediting policy to
 * the trials whose proxy log never captured it.
 *
 *   usage: node backfill-served-outcomes.mjs [--task <name>] [--min-id N]
 *          [--max-id N] [--limit N] [--apply]
 *
 *   env:   TERRANSOUL_MCP_URL, TERRANSOUL_MCP_TOKEN  (required for --apply)
 *
 * ⛔ THE GAP: THE POLICY IS RIGHT, THE INPUT IS STARVED.
 *
 * `credit-trial-outcome.mjs` debits every memory a failing trial was served.
 * That is the harness's established policy and it works. But it reads the
 * proxy's `served` log, and `noteServedMemories` is recent: only 23 of 1207 job
 * dirs have one, against 2244 graded trials on disk. So nearly every graded
 * verdict ever produced was discarded, and rows sit at failure_count 0 or 1
 * after being served into dozens of scored zeros.
 *
 * This replays the SAME rule over the trials the proxy missed, taking the
 * served ids from the agent transcript instead. That is not a new inference:
 * validated on a trial that had both, transcript and proxy log yielded the same
 * seven ids exactly.
 *
 * ⛔ WHAT THIS IS NOT. It does not decide that a memory CAUSED a failure --
 * neither does the forward path. Both implement "a trial that scored 0 debits
 * what it was shown", and both inherit its weakness: on a hard task a useful
 * row accrues failures for being retrieved. `served-memory-audit.mjs` is the
 * read-only view that reports LIFT against each task's base rate; read that
 * BEFORE applying this, and treat a high-volume row with ~0 lift as untouched
 * by the evidence rather than condemned by it.
 *
 * SAFEGUARDS, because this writes at a scale the forward path never does:
 *   * dry run by DEFAULT; `--apply` is required to write;
 *   * `--min-id`/`--max-id` confine it to ONE brain's id band, since ids are
 *     per-brain and the bench and production stores overlap (~24000-26600);
 *   * `--since YYYYMMDD` confines it to one STORE GENERATION -- see below;
 *   * it refuses to run unless the target store CONTAINS the ids it is about to
 *     write -- a probe first, so a run cannot silently credit the wrong brain,
 *     which is a mistake this session actually made;
 *   * successes are credited too, not only failures. Debiting alone would
 *     ratchet the whole store downward.
 *
 * ⛔ IDS ARE NOT STABLE ACROSS STORE GENERATIONS, WHICH NARROWS THIS SHARPLY.
 *
 * MEASURED 2026-09-02: of the eight ids this tool ranked highest from
 * all-history transcripts, FIVE (26499, 26476, 26549, 26496, 26531) do not
 * exist in the bench store at all. The campaign ran against several successive
 * stores -- rebuilt, re-seeded, swapped between production and isolated -- and
 * each generation reissues ids from the same range. A transcript records the id
 * and not the store, so an old transcript's 26499 and today's 26499 are
 * unrelated rows that merely share a number.
 *
 * So a plan built from ALL history is mostly noise, and the honest scope for
 * this tool is trials from the CURRENT store generation only: pass `--since`
 * with the date that store was created. The store probe below is what stops the
 * unscoped case from doing damage -- it fails immediately when plan[0] is one
 * of the ids that no longer exists -- but a probe that refuses is a backstop,
 * not a substitute for scoping the query correctly.
 */
import { readFileSync } from 'node:fs'
import { collect } from './served-memory-audit.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}
const BASE = flag('--base', 'D:/Git/TerranSoulApp/benchmark/terminal-bench-2.1')
const TASK = flag('--task', null)
const MIN_ID = Number.parseInt(flag('--min-id', '0'), 10) || 0
const MAX_ID = Number.parseInt(flag('--max-id', String(Number.MAX_SAFE_INTEGER)), 10)
const LIMIT = Number.parseInt(flag('--limit', '0'), 10) || 0
// One STORE GENERATION only -- ids are reissued when a store is rebuilt.
const SINCE = flag('--since', null)
const APPLY = argv.includes('--apply')

async function call(url, token, name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(JSON.parse(text)?.result?.content?.[0]?.text ?? '{}')
  } catch {
    return {}
  }
}

/** One observation per (trial, verdict), exactly as the forward path does. */
export function planFromTrials(perMemory, minId, maxId) {
  // perMemory is {id -> {task -> {served, failed}}}; rebuild per-verdict totals.
  const plan = []
  for (const [id, byTask] of perMemory) {
    if (id < minId || id > maxId) continue
    let served = 0
    let failed = 0
    for (const c of byTask.values()) {
      served += c.served
      failed += c.failed
    }
    if (!served) continue
    plan.push({ id, failures: failed, successes: served - failed })
  }
  return plan.sort((a, b) => b.failures + b.successes - (a.failures + a.successes))
}

async function main() {
  const { perMemory, taskTotals } = collect(BASE, TASK, SINCE)
  let plan = planFromTrials(perMemory, MIN_ID, MAX_ID)
  if (LIMIT) plan = plan.slice(0, LIMIT)
  const totF = plan.reduce((n, p) => n + p.failures, 0)
  const totS = plan.reduce((n, p) => n + p.successes, 0)
  console.log(`tasks covered   : ${taskTotals.size}${TASK ? ` (filtered to ${TASK})` : ''}`)
  if (!SINCE) {
    console.log('  !! NO --since: ids are reissued across store generations, so an all-history')
    console.log('     plan mixes unrelated rows that share a number. The store probe will refuse.')
  }
  console.log(`memories in plan: ${plan.length}  (id band ${MIN_ID}..${MAX_ID === Number.MAX_SAFE_INTEGER ? '∞' : MAX_ID})`)
  console.log(`increments      : ${totF} failure, ${totS} success`)
  if (!plan.length) return

  if (!APPLY) {
    console.log('')
    console.log('  id        failures  successes')
    for (const p of plan.slice(0, 15)) {
      console.log(`  ${String(p.id).padEnd(10)}${String(p.failures).padStart(8)}${String(p.successes).padStart(11)}`)
    }
    console.log('')
    console.log('DRY RUN — pass --apply to write. Read served-memory-audit.mjs LIFT first:')
    console.log('a high-volume row with ~0 lift is untouched by the evidence, not condemned.')
    return
  }

  const url = process.env.TERRANSOUL_MCP_URL
  const token = process.env.TERRANSOUL_MCP_TOKEN
  if (!url || !token) {
    console.error('[backfill] TERRANSOUL_MCP_URL / TERRANSOUL_MCP_TOKEN unset — refusing to guess')
    process.exit(3)
  }

  // ⛔ PROBE THE TARGET STORE FIRST. This session credited a whole trial's
  // memories to the production brain while the trial had been reading the
  // isolated bench store -- every call returned ok and nothing that mattered
  // moved. Ports are not stores. A single observation whose `memories_credited`
  // comes back empty means these ids are not here; stop rather than write 2000
  // successful no-ops.
  const probeId = plan[0].id
  const probe = await call(url, token, 'brain_observe_outcome', {
    session_id: 'backfill:store-probe',
    context: 'confirming the target store holds these ids before any bulk write',
    action: 'probe',
    response: 'probe',
    outcome: 'failure',
    used_memory_ids: [probeId],
  })
  if (!Array.isArray(probe.memories_credited) || !probe.memories_credited.includes(probeId)) {
    console.error(
      `[backfill] WRONG STORE — id ${probeId} was served by a trial but this brain did not credit it. ` +
        `Point TERRANSOUL_MCP_URL at the brain those trials actually used (learn mode = :7424, ` +
        `mcp-data-tbench-clean) and re-run. Nothing else was written.`,
    )
    process.exit(4)
  }
  console.log(`[backfill] target store confirmed via id ${probeId}`)

  let done = 0
  for (const p of plan) {
    for (const [verdict, n] of [['failure', p.failures], ['success', p.successes]]) {
      for (let i = 0; i < n; i++) {
        // Counters are monotonic increments, so N observations record N trials.
        // session_id is unique per increment or the tool's repeat-detector
        // treats the run as a stuck loop.
        await call(url, token, 'brain_observe_outcome', {
          session_id: `backfill:${p.id}:${verdict}:${i}`,
          context: 'historical terminal-bench trial, graded by the task verifier',
          action: 'trial completed and scored',
          response: `verdict=${verdict}`,
          outcome: verdict,
          used_memory_ids: [p.id],
        })
        done++
      }
    }
  }
  console.log(`[backfill] recorded ${done} increments across ${plan.length} memories`)
}

if (process.argv[1]?.endsWith('backfill-served-outcomes.mjs')) {
  main().catch((e) => {
    console.error(`[backfill] ${e?.message ?? e}`)
    process.exit(1)
  })
}
