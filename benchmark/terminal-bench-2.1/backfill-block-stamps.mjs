#!/usr/bin/env node
/**
 * `backfill-block-stamps.mjs` — put the grader's recorded verdict on the
 * `[Update <ms> · agent-session]` blocks that were written before
 * `credit-trial-outcome.mjs` started stamping them.
 *
 *   usage: node backfill-block-stamps.mjs --data-dir <store dir> --jobs <jobs root> [--apply]
 *
 *   env:   TERRANSOUL_MCP_URL, TERRANSOUL_MCP_TOKEN  (required for --apply)
 *
 * ⛔ THE GAP. OUTCOME-VISIBLE-1 (c1a6cf76, 2026-09-11) made the credit step call
 * `brain_stamp_outcome` after every graded trial, so each block that trial wrote
 * carries its grade in the header. Blocks written before that carry none.
 *
 * MEASURED 2026-09-15 on bench-store memory 26661: an unstamped
 * `[Update 1788859279859 · agent-session]` written 4.2 minutes into trial
 * raman-fitting__uXX8fyZ (reward 1, no exception) sits beside a newer block
 * stamped `GRADED failure`. A later trial reproduced an earlier failing trial's
 * answer to 9 significant digits from a row that mixed passing and failing advice
 * with no per-block grade. The grade was on disk the whole time.
 *
 * ── THE RULE, AND IT IS STRICT ─────────────────────────────────────────────
 *
 * A block is stamped only when exactly ONE trial qualifies as its author:
 *
 *   1. the block's ms lies inside that trial's `[started_at, finished_at]`
 *      (`trialWindow`, the window credit-trial-outcome stamps over), AND
 *   2. that trial's own job proxy log shows it WROTE that memory id — the
 *      `authored` ids `idsForTrial(..., ['authored'])` attributes to it, exactly
 *      the set credit-trial-outcome stamps.
 *
 * Two qualifiers is UNATTRIBUTABLE. So is one qualifier while another trial in
 * flight has NO attributable write record — no proxy log, a log that cannot be
 * split per trial, or an accepted write whose id the proxy never recorded
 * (`authored` recording landed 2026-09-02/03, cc52fbd7; every earlier accepted
 * write is unrecorded). A trial whose writes cannot be seen may have written
 * this block, so the visible author is not provably the only one.
 *
 * The verdict is `verdictFor(reward)` from the trial's own `verifier/reward.txt`,
 * gated by `runWasSound` — the same two checks credit-trial-outcome applies
 * before it will stamp. A trial with no graded reward is never stamped.
 *
 * ⛔ THE STAMP WINDOW IS `[ms, ms]`, NOT THE TRIAL'S. The server stamps EVERY
 * `[Update]` header inside the window it is sent (outcome_stamp.rs,
 * `stamp_graded_blocks`), and heads too when `created_at` is inside it. A
 * trial-wide window would grade blocks this tool just called unattributable. A
 * block whose ms is shared by another header in the row, or by the row's
 * `created_at`, is refused rather than stamped, because `[ms, ms]` would touch
 * that too.
 *
 * SAFEGUARDS: dry run by default; no `brain_observe_outcome` and no counter moves
 * — `brain_stamp_outcome` only; every target id is probed with the read-only
 * `brain_get_entry` BEFORE any write, and a store whose entry lacks the planned
 * `[Update <ms>` header is refused (ids are reissued across store generations —
 * see backfill-served-outcomes.mjs); a header that carries ANY `GRADED` token is
 * never planned, so a re-run after `--apply` plans nothing for it.
 *
 * PURITY (rules/bench-agi-purity.md): it writes the grader's recorded verdict on
 * the block its author wrote. No content edits, no task names, no heuristics.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { idsForTrial, parseProxyLog, trialWindows } from './attribute-proxy-lines.mjs'
import {
  readReward,
  readSiblingTrials,
  trialWindow,
  verdictFor,
  buildStamps,
} from './credit-trial-outcome.mjs'
import { runWasSound } from './trial-outcome.mjs'
import { transportFor } from './refutation-watch.mjs'
import { readIndex } from './forensics-side-by-side.mjs'

const SEP = '·'
const UPDATE_PREFIX = '[Update '
const AGENT_SESSION = 'agent-session'
const PROXY_LOG = 'terransoul-proxy-calls.jsonl'

/** The two tools whose response `noteAuthoredMemory` (mcp-auth-proxy.mjs) records. */
const WRITE_TOOLS = new Set(['brain_append', 'brain_ingest_lesson'])
/** Proxy response verdicts after which the write may have landed. */
const MAY_HAVE_WRITTEN = new Set(['accepted', 'unparseable'])

export const REASONS = Object.freeze({
  NO_WINDOW: 'no-indexed-trial-in-flight',
  NO_WRITER: 'no-trial-in-flight-wrote-id',
  WRITER_UNOBSERVABLE: 'trials-in-flight-have-no-write-record',
  CONCURRENT_AUTHORS: 'concurrent-authors',
  CONCURRENT_UNOBSERVABLE: 'concurrent-trial-has-no-write-record',
  AUTHOR_UNGRADED: 'author-ungraded',
  AUTHOR_NOT_SOUND: 'author-run-not-sound',
  WINDOW_NOT_EXCLUSIVE: 'block-ms-not-exclusive',
})

const LEGEND = {
  [REASONS.NO_WINDOW]: 'no trial in forensics-index.jsonl was in flight at the block ms',
  [REASONS.NO_WRITER]: 'trials were in flight, their write records are complete, none wrote this id',
  [REASONS.WRITER_UNOBSERVABLE]: 'no visible author, and some trial in flight has no attributable write record',
  [REASONS.CONCURRENT_AUTHORS]: 'two or more trials in flight wrote this id',
  [REASONS.CONCURRENT_UNOBSERVABLE]: 'one visible author, but another trial in flight has no attributable write record',
  [REASONS.AUTHOR_UNGRADED]: 'unique author, but it has no graded reward',
  [REASONS.AUTHOR_NOT_SOUND]: 'unique author, but runWasSound says it was not a fair test',
  [REASONS.WINDOW_NOT_EXCLUSIVE]: 'unique author, but a [ms, ms] stamp would also touch another header or the head',
}

/**
 * Every `[Update <ms> · <source> …]` header in `content`, as `{ms, source, graded}`.
 *
 * Recognition mirrors `update_block_ts` in crates/memory/src/outcome_stamp.rs —
 * trailing whitespace (incl. `\r`) trimmed, `[Update ` prefix, `]` suffix, first
 * whitespace token an integer — so this sees exactly the headers the server
 * would stamp. `graded` is true for ANY `GRADED` token, not only one verdict: a
 * block the forward path already graded is not this tool's to grade again.
 */
export function updateHeaders(content) {
  const out = []
  for (const line of String(content ?? '').split('\n')) {
    const s = line.trimEnd()
    if (!s.startsWith(UPDATE_PREFIX) || !s.endsWith(']')) continue
    const inner = s.slice(UPDATE_PREFIX.length, -1)
    const token = inner.trim().split(/\s+/)[0]
    if (!/^[+-]?\d+$/.test(token ?? '')) continue
    const parts = inner.split(` ${SEP} `)
    out.push({
      ms: Number(token),
      source: (parts[1] ?? '').trim(),
      graded: parts.slice(2).some((p) => p.trim().startsWith('GRADED ')),
    })
  }
  return out
}

/** Unstamped agent-session blocks in the live `memories` rows, read-only. */
export function readBlocks(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const blocks = []
    let alreadyStamped = 0
    const rows = db
      .prepare("SELECT id, content, created_at FROM memories WHERE content LIKE '%agent-session%' ORDER BY id")
      .all()
    for (const row of rows) {
      const headers = updateHeaders(row.content)
      for (const h of headers) {
        if (h.source !== AGENT_SESSION) continue
        if (h.graded) {
          alreadyStamped++
          continue
        }
        blocks.push({
          id: Number(row.id),
          ms: h.ms,
          createdAt: Number(row.created_at),
          sameMs: headers.filter((o) => o.ms === h.ms).length,
        })
      }
    }
    return { blocks, alreadyStamped }
  } finally {
    db.close()
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Every indexed trial with a readable window. Located through
 * `forensics-index.jsonl` only — never a scan of the jobs root.
 */
export function loadTrials(jobsDir) {
  const trials = []
  let indexed = 0
  let noWindow = 0
  for (const row of readIndex(jobsDir).values()) {
    if (!row?.job || !row?.trial) continue
    indexed++
    const dir = join(jobsDir, row.job, row.trial)
    const result = readJson(join(dir, 'result.json'))
    const window = trialWindow(result)
    if (!window) {
      noWindow++
      continue
    }
    trials.push({ trial: row.trial, job: row.job, dir, result, window, reward: readReward(dir) })
  }
  return { trials, indexed, noWindow }
}

/**
 * What one trial's proxy log proves it wrote: `{ids, observable, why}`.
 *
 * `ids` is credit-trial-outcome's own authored set. `observable` is false when
 * that set cannot be the whole story — no log, a log `idsForTrial` refuses to
 * split, or more writes that may have landed (accepted, unparseable, or deferred)
 * than `authored` records inside the trial's agent window.
 */
export function writeRecord(trial, cache = new Map()) {
  let job = cache.get(trial.job)
  if (!job) {
    const logPath = join(trial.dir, '..', PROXY_LOG)
    job = {
      logText: existsSync(logPath) ? readFileSync(logPath, 'utf8') : null,
      siblings: readSiblingTrials(trial.dir),
    }
    job.lines = job.logText === null ? [] : parseProxyLog(job.logText)
    cache.set(trial.job, job)
  }
  if (job.logText === null) return { ids: [], observable: false, why: 'no proxy log' }
  const authored = idsForTrial(job.logText, trial.trial, job.siblings, ['authored'])
  if (!authored.attributed) return { ids: [], observable: false, why: authored.reason }
  const w = trialWindows(job.siblings).find((x) => x.name === trial.trial)
  let writes = 0
  let recorded = 0
  for (const l of job.lines) {
    if (l.at < w.start || l.at > w.end) continue
    const o = l.obj
    if (WRITE_TOOLS.has(o?.name) && MAY_HAVE_WRITTEN.has(o?.verdict)) writes++
    if (WRITE_TOOLS.has(o?.tool) && o?.mode === 'deferred') writes++
    if (Array.isArray(o?.authored)) recorded++
  }
  if (writes > recorded) {
    return { ids: authored.ids, observable: false, why: `${writes - recorded} write(s) with no recorded id` }
  }
  return { ids: authored.ids, observable: true }
}

/** The decision for one block: a `call`, or a `reason` it is left alone. */
export function attributeBlock(block, trials, cache = new Map()) {
  const inFlight = trials.filter((t) => block.ms >= t.window.from_ms && block.ms <= t.window.to_ms)
  if (!inFlight.length) return { reason: REASONS.NO_WINDOW }
  const qualifiers = []
  const unobservable = []
  for (const t of inFlight) {
    const rec = writeRecord(t, cache)
    if (rec.ids.includes(block.id)) qualifiers.push(t)
    else if (!rec.observable) unobservable.push(`${t.trial} (${rec.why})`)
  }
  const names = qualifiers.map((t) => t.trial).sort()
  if (qualifiers.length > 1) return { reason: REASONS.CONCURRENT_AUTHORS, qualifiers: names }
  if (!qualifiers.length) {
    return unobservable.length
      ? { reason: REASONS.WRITER_UNOBSERVABLE, unobservable }
      : { reason: REASONS.NO_WRITER }
  }
  if (unobservable.length) {
    return { reason: REASONS.CONCURRENT_UNOBSERVABLE, qualifiers: names, unobservable }
  }
  const author = qualifiers[0]
  const base = { author: author.trial, reward: author.reward }
  if (author.reward === null) return { ...base, reason: REASONS.AUTHOR_UNGRADED }
  if (!runWasSound(author.result, author.reward)) return { ...base, reason: REASONS.AUTHOR_NOT_SOUND }
  if (block.sameMs > 1 || block.createdAt === block.ms) return { ...base, reason: REASONS.WINDOW_NOT_EXCLUSIVE }
  const verdict = verdictFor(author.reward)
  const [call] = buildStamps([block.id], { from_ms: block.ms, to_ms: block.ms }, verdict, author.window.to_ms)
  return { ...base, verdict, call }
}

function innerJson(text) {
  try {
    return JSON.parse(JSON.parse(text)?.result?.content?.[0]?.text ?? 'null')
  } catch {
    return null
  }
}

/**
 * Confirm the target store holds every planned id AND block before any write.
 *
 * A refuted entry is served as a graded index with no raw `[Update <ms>`
 * headers (outcome_stamp.rs, `render_refuted_index`); for that view only the id
 * can be checked, and it is reported as such.
 */
export async function probeStore(callTool, calls) {
  const byId = new Map()
  for (const c of calls) byId.set(c.arguments.id, [...(byId.get(c.arguments.id) ?? []), c.arguments.from_ms])
  const missing = []
  const idOnly = []
  for (const [id, msList] of byId) {
    const { res, text } = await callTool({ name: 'brain_get_entry', arguments: { id } })
    const inner = res?.ok && !String(text).includes('"isError":true') ? innerJson(text) : null
    if (inner?.id !== id) {
      missing.push(`${id}: not in this store`)
      continue
    }
    const present = new Set(updateHeaders(inner.content).map((h) => h.ms))
    if (!present.size) {
      idOnly.push(id)
      continue
    }
    for (const ms of msList) if (!present.has(ms)) missing.push(`${id}: no [Update ${ms}] block`)
  }
  return { ok: missing.length === 0, missing, idOnly }
}

/** Probe, then send the stamps. Never any other write. */
export async function applyStamps(callTool, calls, log = console) {
  const applied = { refused: false, missing: [], idOnly: [], blocksStamped: 0, unchanged: 0, failed: [] }
  if (!calls.length) return applied
  const probe = await probeStore(callTool, calls)
  applied.idOnly = probe.idOnly
  if (!probe.ok) {
    applied.refused = true
    applied.missing = probe.missing
    log.error(
      `[backfill-stamps] WRONG STORE — ${probe.missing.length} planned target(s) absent: ` +
        `${probe.missing.slice(0, 5).join('; ')}. Point TERRANSOUL_MCP_URL at the brain whose store ` +
        `was read (--data-dir). Nothing was written.`,
    )
    return applied
  }
  for (const call of calls) {
    const { id, from_ms: ms } = call.arguments
    const { res, text } = await callTool(call)
    if (!res?.ok || String(text).includes('"isError":true')) {
      applied.failed.push(`${id}@${ms}: ${res?.status ?? '?'} ${String(text).slice(0, 160)}`)
      continue
    }
    const inner = innerJson(text)
    if (typeof inner?.blocks_stamped !== 'number') {
      applied.failed.push(`${id}@${ms}: no blocks_stamped in the response`)
      continue
    }
    applied.blocksStamped += inner.blocks_stamped
    if (!inner.changed) applied.unchanged++
    if (inner.head_stamped) applied.failed.push(`${id}@${ms}: the server stamped the HEAD too`)
  }
  log.log(
    `[backfill-stamps] stamped ${applied.blocksStamped} block(s) over ${calls.length} call(s)` +
      (applied.unchanged ? `, ${applied.unchanged} already carried the verdict` : '') +
      (applied.failed.length ? `, ${applied.failed.length} FAILED:\n  ${applied.failed.join('\n  ')}` : ''),
  )
  return applied
}

function summarize(rows, alreadyStamped, loaded) {
  const byReason = {}
  const attributable = { success: 0, failure: 0 }
  for (const r of rows) {
    if (r.call) attributable[r.verdict]++
    else byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
  }
  return {
    unstamped: rows.length,
    alreadyStamped,
    attributable,
    unattributable: byReason,
    indexedTrials: loaded.indexed,
    indexedTrialsWithoutWindow: loaded.noWindow,
  }
}

function report(rows, calls, summary, log) {
  const width = Math.max(12, ...rows.map((r) => String(r.author ?? '').length)) + 2
  const clip = (s) => (s.length > 100 ? `${s.slice(0, 99)}…` : s)
  let current = null
  for (const r of rows) {
    if (r.id !== current) {
      current = r.id
      log.log(`\nmemory ${r.id}`)
      log.log(`  ${'block ms'.padEnd(15)}${'author trial'.padEnd(width)}${'reward'.padEnd(8)}verdict / reason`)
    }
    const detail = r.call
      ? r.verdict
      : `UNSTAMPED: ${r.reason}` +
        (r.qualifiers ? ` [writers: ${r.qualifiers.join(', ')}]` : '') +
        (r.unobservable ? ` [no write record: ${r.unobservable.slice(0, 3).map(clip).join('; ')}` +
          (r.unobservable.length > 3 ? ` +${r.unobservable.length - 3}` : '') + ']' : '')
    log.log(
      `  ${String(r.ms).padEnd(15)}${String(r.author ?? '—').padEnd(width)}` +
        `${String(r.reward ?? '—').padEnd(8)}${detail}`,
    )
  }
  log.log('\nreasons:')
  for (const [code, text] of Object.entries(LEGEND)) log.log(`  ${code.padEnd(38)}${text}`)
  log.log(`\nbrain_stamp_outcome calls ${calls.length ? 'it would make' : ': none'}${calls.length ? ` (${calls.length}):` : ''}`)
  for (const c of calls) log.log(`  ${JSON.stringify(c)}`)
  log.log(`\nsummary: ${JSON.stringify(summary)}`)
}

/**
 * The whole tool, injectable. `callTool` is only ever used with `apply: true`;
 * a dry run returns the plan and sends nothing.
 */
export async function run({ dataDir, jobsDir, apply = false, callTool = null, log = console }) {
  const { blocks, alreadyStamped } = readBlocks(join(dataDir, 'memory.db'))
  const loaded = loadTrials(jobsDir)
  const cache = new Map()
  const rows = blocks.map((b) => ({ ...b, ...attributeBlock(b, loaded.trials, cache) }))
  const calls = rows.filter((r) => r.call).map((r) => r.call)
  const summary = summarize(rows, alreadyStamped, loaded)
  report(rows, calls, summary, log)
  if (!apply) {
    log.log('\nDRY RUN — nothing was sent. Pass --apply to send these calls.')
    return { rows, calls, summary, applied: null }
  }
  if (!callTool) throw new Error('--apply needs an MCP transport')
  return { rows, calls, summary, applied: await applyStamps(callTool, calls, log) }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? null : (argv[i + 1] ?? null)
  }
  const dataDir = flag('--data-dir')
  const jobsDir = flag('--jobs')
  const apply = argv.includes('--apply')
  if (!dataDir || !jobsDir) {
    console.error('usage: backfill-block-stamps.mjs --data-dir <store dir> --jobs <jobs root> [--apply]')
    process.exit(2)
  }
  if (!existsSync(join(dataDir, 'memory.db'))) {
    console.error(`[backfill-stamps] no memory.db under ${dataDir}`)
    process.exit(2)
  }
  let callTool = null
  if (apply) {
    const url = process.env.TERRANSOUL_MCP_URL
    const token = process.env.TERRANSOUL_MCP_TOKEN
    if (!url || !token) {
      console.error('[backfill-stamps] TERRANSOUL_MCP_URL / TERRANSOUL_MCP_TOKEN unset — refusing to guess')
      process.exit(3)
    }
    callTool = transportFor(url, token, { label: 'backfill-stamps' })
  }
  const out = await run({ dataDir, jobsDir, apply, callTool })
  if (out.applied?.refused) process.exit(4)
  if (out.applied?.failed.length) process.exit(5)
}

if (process.argv[1]?.endsWith('backfill-block-stamps.mjs')) {
  main().catch((e) => {
    console.error(`[backfill-stamps] ${e?.message ?? e}`)
    process.exit(1)
  })
}
