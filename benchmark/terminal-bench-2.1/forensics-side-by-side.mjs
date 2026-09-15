#!/usr/bin/env node
/**
 * `forensics-side-by-side.mjs` — every finished trial in ONE table.
 *
 *   usage: node forensics-side-by-side.mjs [--base <jobs-root>] [--since YYYY-MM-DD]
 *                                          [--failed-only] [--task NAME] [--limit N]
 *
 * ⛔ THIS IS THE READER, AND WITHOUT IT THE INDEX IS A WRITER WITH NO READER.
 *
 * That is the most common silent defect class in this repo — three independent
 * instances in one sweep (`reference_writer_with_no_reader_defect_class`), plus
 * a completion judge that shipped write-only for weeks. A per-trial
 * `forensics.json` that nobody ever opens beside another one would reproduce it
 * exactly: the whole value of freezing a diagnosis is being able to lay two of
 * them next to each other and see that the same shape recurs.
 *
 * WHAT THE TABLE IS FOR. One failure is an anecdote. Ten failures with the same
 * `suspects` column is a mechanism — and this campaign has repeatedly spent
 * redo cycles on tasks whose failures shared one cause that nobody could see
 * because the evidence lived in ten different directories
 * (`reference_diagnose_only_when_failures_share_a_signature`).
 *
 * ⛔ RECORDS ARE BACKFILLED, NEVER INVENTED. A job directory that predates the
 * index gets its record COMPUTED here, from its own artifacts, by the same
 * function that writes one at the end of a run — so a historical row and a live
 * row cannot be produced under two different definitions. Backfilled records
 * are appended to the index but the old trial directory is NOT modified: a
 * reader must not rewrite the corpus it is reading.
 *
 * ⛔ AND IT IS BOUNDED. The corpus on this machine is ~2,000 job directories
 * across 39 roots, on a drive this campaign has already wedged twice with
 * unbounded scans (`reference_find_scans_wedge_d_drive`). `--since`, `--task`
 * and `--limit` are applied BEFORE any record is computed, so a filtered
 * question costs a filtered walk.
 *
 * READ-ONLY towards trials, OFFLINE, no brain, no network.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forensicsForTrial, INDEX_FILE } from './post-trial-forensics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** How many uncached trials one invocation will reconstruct. */
export const DEFAULT_LIMIT = 400

/** Failed-check cells are truncated to this, so one trace cannot own the table. */
export const CELL_CHARS = 40

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Index rows keyed by trial name — the LAST line for a trial wins. */
export function readIndex(base) {
  const path = join(base, INDEX_FILE)
  const byTrial = new Map()
  if (!existsSync(path)) return byTrial
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row?.trial) byTrial.set(row.trial, row)
    } catch {
      // A line torn by a concurrent append is skipped, not fatal.
    }
  }
  return byTrial
}

/**
 * Every `{jobDir, trial, dir, startedAt}` under one jobs root.
 *
 * `startedAt` comes from the JOB's own result.json when it has one — a small
 * file, one per job — so `--since` can reject a whole job before any trial's
 * artifacts are opened, and falls back to the TRIAL's own, which is also small.
 *
 * ⛔ BOTH SOURCES, BECAUSE ONE OF THEM IS OFTEN ABSENT. Older roots in this
 * corpus have no job-level `result.json`, and without the fallback every such
 * trial arrives dateless, survives `--since`, and is then reconstructed in full
 * — a ~1.4 MB trajectory-and-transcript parse — only to be dropped by the
 * post-filter afterwards. The whole point of filtering first is to not pay
 * that, and a filter that quietly stops filtering is worse than none.
 */
export function trialsUnder(base) {
  const out = []
  let jobs
  try {
    jobs = readdirSync(base)
  } catch {
    return out
  }
  for (const job of jobs) {
    const jobDir = join(base, job)
    let entries
    try {
      if (!statSync(jobDir).isDirectory()) continue
      entries = readdirSync(jobDir)
    } catch {
      continue
    }
    const jobResult = readJson(join(jobDir, 'result.json'))
    for (const name of entries) {
      if (!name.includes('__')) continue
      const dir = join(jobDir, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      out.push({
        jobDir,
        trial: name,
        dir,
        task: name.split('__')[0],
        startedAt: jobResult?.started_at ?? readJson(join(dir, 'result.json'))?.started_at ?? null,
      })
    }
  }
  return out
}

/** A row's date, from whichever of the two timestamps it actually carries. */
export function dateOf(row) {
  const raw = row?.started_at ?? row?.startedAt ?? row?.at ?? ''
  return String(raw).slice(0, 10)
}

function keep(row, opts) {
  if (opts.task && row.task !== opts.task) return false
  if (opts.since) {
    const d = dateOf(row)
    // A row with no date is KEPT. Dropping it would silently shrink the
    // denominator on exactly the trials whose artifacts are most damaged,
    // which is the population a forensics table exists to show.
    if (d && d < opts.since) return false
  }
  return true
}

function failedOut(row) {
  return !(typeof row.reward === 'number' && row.reward > 0)
}

/** One markdown cell: pipes escaped, newlines flattened, bounded. */
export function cell(text, max = CELL_CHARS) {
  const flat = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
  if (!flat) return '—'
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** `name=value` for each failed check, which is the whole point of the table. */
export function failedCell(row) {
  const failed = Array.isArray(row?.failed) ? row.failed : []
  if (!failed.length) return '—'
  return cell(
    failed
      .map((f) => {
        const short = String(f?.name ?? '?').split('::').pop()
        const v = Array.isArray(f?.values) && f.values.length ? `=${f.values[0]}` : ''
        return `${short}${v}`
      })
      .join('; '),
    CELL_CHARS,
  )
}

export function renderTable(rows) {
  const head = [
    'task',
    'trial',
    'date',
    'reward',
    'void',
    'failed check = value',
    'suspects',
    'blk',
    'out tok',
    'vs baseline',
  ]
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`]
  for (const r of rows) {
    const ds = r?.baseline?.diffstat
    lines.push(
      `| ${[
        cell(r.task, 28),
        cell(r.trial, 28),
        cell(dateOf(r), 10),
        r.reward === null || r.reward === undefined ? 'none' : String(r.reward),
        r.void ? 'YES' : '',
        failedCell(r),
        cell((r.suspects ?? []).join(', '), 60),
        String(r.blocks ?? 0),
        r?.tokens?.output === null || r?.tokens?.output === undefined ? '?' : String(r.tokens.output),
        ds ? `+${ds.added}/-${ds.removed} in ${ds.changed_files}` : '—',
      ].join(' | ')} |`,
    )
  }
  return lines.join('\n')
}

/**
 * The rows for one jobs root, backfilling any trial the index has never seen.
 *
 * @param {string} base the jobs root holding `forensics-index.jsonl`
 * @param {{task?: string, since?: string, failedOnly?: boolean, limit?: number,
 *          backfill?: boolean}} opts
 */
export function collectRows(base, opts = {}) {
  const index = readIndex(base)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const rows = []
  let backfilled = 0
  let skipped = 0
  for (const t of trialsUnder(base)) {
    if (!keep(t, opts)) continue
    let row = index.get(t.trial)
    if (!row) {
      if (opts.backfill === false) continue
      if (backfilled >= limit) {
        skipped += 1
        continue
      }
      backfilled += 1
      // `write:false` — a reader must not rewrite the trial directories it is
      // reading. `index:true` so the same walk never has to happen twice.
      const record = forensicsForTrial(t.dir, { base, write: false, index: true })
      row = {
        task: record.task,
        trial: record.trial,
        started_at: record.started_at,
        reward: record.reward,
        void: record.void,
        failed: record.checks.failed.map((c) => ({ name: c.name, values: c.values })),
        suspects: record.suspects.map((s) => s.rule),
        blocks: record.blocks.length,
        tokens: record.tokens,
        baseline: record.baseline
          ? { trial: record.baseline.trial, diffstat: record.baseline.diffstat }
          : null,
      }
    }
    if (!keep({ ...row, task: row.task ?? t.task }, opts)) continue
    if (opts.failedOnly && !failedOut(row)) continue
    rows.push({ ...row, task: row.task ?? t.task })
  }
  rows.sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))) || String(a.trial).localeCompare(String(b.trial)))
  return { rows, backfilled, skipped }
}

function main() {
  const args = process.argv.slice(2)
  const val = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const base = val('--base') ?? join(HERE, 'jobs')
  const opts = {
    task: val('--task'),
    since: val('--since'),
    failedOnly: args.includes('--failed-only'),
    limit: val('--limit') ? Number(val('--limit')) : undefined,
  }
  if (!existsSync(base)) {
    console.error(`[forensics] no such jobs root: ${base}`)
    process.exit(1)
  }
  const { rows, backfilled, skipped } = collectRows(base, opts)
  if (!rows.length) {
    console.log(`no trials matched under ${basename(base)}${opts.since ? ` since ${opts.since}` : ''}.`)
    return
  }
  console.log(renderTable(rows))
  console.log('')
  const note = [`${rows.length} trial(s)`, `${backfilled} reconstructed on the fly`]
  if (skipped) note.push(`${skipped} SKIPPED at the --limit (raise --limit to include them)`)
  console.log(`_${note.join(', ')}._`)
}

if (process.argv[1]?.endsWith('forensics-side-by-side.mjs')) main()
