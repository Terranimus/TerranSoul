#!/usr/bin/env node
/**
 * `retry-disclosure.mjs` — how many trials in a run consumed a retry, and why.
 *
 *   usage: node retry-disclosure.mjs [jobs-dir] [--prefix P ...]
 *                                    [--notes-file path] [--retried-attempts-dir path]
 *                                    [--json]
 *
 * ⛔ WHY THIS EXISTS. Commit a3a84453 added two retry mechanisms to
 * terransoul_hook.py:
 *
 *   TBENCH-LATE-API-RETRY-1  a by-name retry (`--retry-include UnknownApiError`
 *                            etc., see run-dg.sh) is refused once the agent has
 *                            already produced work — the trial's result then
 *                            carries BOTH an exception (exception_stats) and a
 *                            verifier grade (reward_stats). merge-sweep.sh
 *                            scores that 0 officially (correct), but nothing
 *                            counted how often it happened.
 *   TBENCH-HOST-SPAWN-WAIT-1 a never-ran attempt that IS re-run has its failed
 *                            directory MOVED to retried-attempts/<job>/ instead
 *                            of deleted. Nothing counted those either.
 *
 * run-dg.sh's own `--retry-include` comment states the obligation directly: a
 * submission must disclose how many trials consumed a retry. That number was
 * being hand-counted. This is the reader.
 *
 * THREE SOURCES, CROSS-REFERENCED BY TIME, NOT BY NAME. The hook's own notes
 * carry `sweep` (TB_AGENT_CACHE_ID) and `task` (TB_TASKS) fields that are
 * empty in ordinary use — a sweep script that never sets those env vars
 * leaves them "" — so a note cannot be matched to a job by string equality.
 * What every note DOES carry is a wall-clock timestamp, and every job's own
 * result.json carries started_at/finished_at, so the correlation this file
 * makes is "did this note happen while this job (or these jobs) were running".
 *
 *   1. result.json's exception_stats / reward_stats, read directly (no
 *      identity-prefix filtering — this is a diagnostic count of retries
 *      consumed, not a scoring pool like merge-sweep.sh's).
 *   2. retried-attempts/<job>/*__attempt* directories next to the jobs dir
 *      (terransoul_hook.py's `_preserve_retried_attempt` writes there, keyed
 *      by the JOB directory's own name — not the jobs-dir argument, which can
 *      vary; the anchor is this script's own location, exactly as the hook
 *      anchors on `__file__`).
 *   3. mcp-data/.tb-hook-notes.jsonl, filtered to notes whose timestamp falls
 *      inside the reported job(s)' own started_at..finished_at window.
 *
 * ⛔ A TIMEZONE TRAP, AND IT IS WORSE THAN "JOB TIMESTAMPS ARE UTC". `_hook_note`
 * stamps `at` with `datetime.now().isoformat(timespec="seconds")` — LOCAL
 * time, no offset, always. That part is simple and `parseNoteTime` handles it.
 *
 * harbor's JOB-level result.json (`started_at`/`finished_at` at the top of the
 * file) is naive too, but its zone is NOT consistent — measured directly
 * against the live jobs dir on 2026-09-11:
 *
 *     jobs/redo09111849-20260911-185128/result.json  started_at = ...T18:51:31  -> LOCAL (job launched 18:51 local)
 *     jobs/redo09111900-20260911-190202/result.json  started_at = ...T09:02:03  -> UTC   (job launched 19:02 local)
 *     jobs/unseenSAM-20260909-223347/result.json     finished_at = ...T23:25:26 -> LOCAL
 *
 * An earlier version of this file "fixed" this by forcing `Z` onto every
 * job-level timestamp — which is exactly backwards for the LOCAL ones above,
 * and was caught only because it silently zeroed every hook-note count for
 * `--prefix redo0911` and missed the whole outage window for `--prefix
 * unseenSAM`. There is no way to recover the zone of a job-level timestamp
 * from the string alone, so THIS FILE NO LONGER READS THEM AT ALL for windowing.
 *
 * TWO SOURCES THAT ARE NOT AMBIGUOUS, in priority order:
 *
 *   1. TRIAL-level result.json (`jobs/<job>/<task>__<id>/result.json`) DOES
 *      carry an explicit `Z`, always (`...T13:23:11.057246Z`) — this is a
 *      different code path in harbor than the job-level rollup and has been
 *      consistent in every sample checked. `parseExplicitZoned` refuses to
 *      trust a string that lacks a zone marker, so a future harbor version
 *      that drops the `Z` fails closed (falls through to source 2) instead of
 *      silently mis-reading local-as-UTC again.
 *   2. The JOB DIRECTORY NAME's own stamp, `<prefix>-YYYYMMDD-HHMMSS`, which
 *      run-dg.sh writes from its own LOCAL clock at launch — immutable once
 *      created, so it can never be back-dated by a later process. Paired with
 *      the newest file mtime under the job dir for an end estimate when no
 *      trial ever got far enough to stamp a `Z` timestamp (setup died first).
 *
 * MTIME IS NOT TRUSTED WHEN A TRIAL-LEVEL END EXISTS. Measured directly:
 * `unseenSAM-20260909-223347/sam-cell-seg__c9CHYJ2/verifier/reward.txt` has an
 * mtime of 2026-09-11 — TWO DAYS after that job actually ran on 2026-09-09 —
 * because a later redo/rescore pass touched a file inside the old job dir.
 * Using mtime as an END whenever it is available would have silently
 * stretched that job's window across two days. It is used ONLY as a last
 * resort when nothing Z-stamped exists at all (`jobWindowSingle`).
 *
 * THE DIR-NAME START CAN WIDEN A TRIAL-LEVEL WINDOW BACKWARD, NEVER NARROW
 * IT. Measured on `unseenSAM-20260909-223347`: its one trial's own
 * `started_at` (23:23:11 local) postdates the job's FIRST failing
 * `docker compose` attempt (23:20:09 local, from the notes file) by three
 * minutes — harbor's shared-environment preflight (`exec`/`cp` against a
 * REUSED verifier container) runs before the trial's own timestamp is
 * stamped. The directory-name stamp is immutable and zone-safe, so
 * `jobWindowSingle` takes `min(trial start, dir-name start)` — it can only
 * pull the window's start earlier into a moment still safely inside this
 * job's own real lifetime, never attribute another job's notes to this one.
 *
 * Plain factual text: no "beat/win/outperform" language — this reports
 * counts, not a verdict. Node, ESM, no dependencies. Read-only.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_JOBS_DIR = join(SCRIPT_DIR, 'jobs')
const DEFAULT_RETRIED_ATTEMPTS_DIR = join(SCRIPT_DIR, 'retried-attempts')
// mcp-data/ lives at the repo root — two levels above benchmark/terminal-bench-2.1/,
// the same computation terransoul_hook.py's `_HOOK_NOTES` makes from its own
// `__file__` (`.resolve().parents[2]`).
const DEFAULT_NOTES_FILE = join(SCRIPT_DIR, '..', '..', 'mcp-data', '.tb-hook-notes.jsonl')

/**
 * Only trust a timestamp string that carries its OWN zone marker. Used for
 * trial-level result.json, which has always carried an explicit `Z` in every
 * sample checked — unlike job-level result.json (see file header), whose zone
 * cannot be determined from the string at all. A string with no marker
 * returns null rather than guessing, so a future harbor change that drops the
 * `Z` fails closed (the caller falls back to the dir-name+mtime source)
 * instead of silently misreading local time as UTC again.
 */
export function parseExplicitZoned(s) {
  if (!s || !/[zZ]|[+-]\d\d:\d\d$/.test(s)) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Hook-note timestamps (`at`) are naive LOCAL time — parse as-is. */
export function parseNoteTime(s) {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Every subdirectory of `dir` that has a result.json, optionally name-filtered. */
export function listJobDirs(jobsDir, prefixes = []) {
  if (!existsSync(jobsDir)) return []
  const names = readdirSync(jobsDir).filter((name) => {
    try {
      return statSync(join(jobsDir, name)).isDirectory()
    } catch {
      return false
    }
  })
  const filtered = prefixes.length ? names.filter((n) => prefixes.some((p) => n.startsWith(p))) : names
  return filtered.filter((n) => existsSync(join(jobsDir, n, 'result.json'))).sort()
}

/** Read one job's result.json. Never throws — an unreadable job is reported, not fatal. */
export function readJobResult(jobsDir, jobName) {
  try {
    return JSON.parse(readFileSync(join(jobsDir, jobName, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Trials that appear in BOTH exception_stats and reward_stats for one job —
 * the TBENCH-LATE-API-RETRY-1 case: the retry was refused because the agent
 * had already produced work, so the exception is provenance and the grade
 * stands. No identity-prefix filtering (see file header) — every eval key in
 * the job is counted.
 */
export function gradedExceptions(resultJson) {
  const rows = []
  const evals = resultJson?.stats?.evals ?? {}
  for (const ev of Object.values(evals)) {
    const bad = new Map()
    for (const [exc, ids] of Object.entries(ev?.exception_stats ?? {})) {
      for (const id of ids) bad.set(id, exc)
    }
    const rewardOf = new Map()
    for (const [score, ids] of Object.entries(ev?.reward_stats?.reward ?? {})) {
      for (const id of ids) rewardOf.set(id, Number(score))
    }
    for (const [id, exc] of bad) {
      if (rewardOf.has(id)) {
        rows.push({ trialId: id, task: id.split('__').slice(0, -1).join('__'), exception: exc, reward: rewardOf.get(id) })
      }
    }
  }
  return rows
}

/** Preserved never-ran attempts for one job, under retried-attempts/<job>/ (dirs named *__attempt<n>). */
export function countPreservedAttempts(retriedAttemptsDir, jobName) {
  const dir = join(retriedAttemptsDir, jobName)
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((n) => {
      if (!/__attempt\d+$/.test(n)) return false
      try {
        return statSync(join(dir, n)).isDirectory()
      } catch {
        return false
      }
    }).length
  } catch {
    return 0
  }
}

/** Parse mcp-data/.tb-hook-notes.jsonl (or a fixture in its place). Malformed lines are skipped, not fatal. */
export function readNotes(notesFile) {
  if (!existsSync(notesFile)) return []
  const out = []
  for (const line of readFileSync(notesFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // one bad line must not hide every other note
    }
  }
  return out
}

/**
 * The window implied by run-dg.sh's own job-directory naming convention,
 * `<prefix>-YYYYMMDD-HHMMSS` — written from the LOCAL clock at job launch, so
 * this is unambiguous and, being baked into an immutable directory name,
 * cannot be back-dated by any later process. Returns epoch ms, or null when
 * the name does not match the pattern.
 */
export function parseDirNameStamp(jobName) {
  const m = /-(\d{8})-(\d{6})$/.exec(jobName)
  if (!m) return null
  const [, ymd, hms] = m
  const year = Number(ymd.slice(0, 4))
  const month = Number(ymd.slice(4, 6))
  const day = Number(ymd.slice(6, 8))
  const hour = Number(hms.slice(0, 2))
  const minute = Number(hms.slice(2, 4))
  const second = Number(hms.slice(4, 6))
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return null
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

/**
 * Newest mtime (epoch ms) of any file under `dir`, recursively. A real
 * filesystem timestamp, so unlike a naive ISO string it is never ambiguous
 * about its zone — but see the file header: it CAN be pushed forward by an
 * unrelated later process touching an old job dir, so callers use it only
 * when no Z-stamped trial timestamp exists at all. Bounded to one job's own
 * subtree (never a filesystem-wide walk).
 */
export function newestMtimeUnder(dir) {
  let newest = null
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      try {
        const mt = statSync(p).mtimeMs
        if (newest === null || mt > newest) newest = mt
      } catch {
        // the file vanished between readdir and stat -- not this file's fault
      }
    }
  }
  return newest
}

/**
 * The [start, end] window from every trial's OWN result.json under one job
 * (explicit-Z timestamps only — see `parseExplicitZoned`). Spans every trial
 * dir found, so a job with several trials (retries within one job dir) gets
 * the union of all of them. Returns null when no trial dir yields a
 * parseable timestamp at all (setup died before any trial got that far, or
 * the job has not produced a trial yet).
 */
export function jobWindowFromTrials(jobsDir, jobName) {
  const jobDir = join(jobsDir, jobName)
  let entries
  try {
    entries = readdirSync(jobDir, { withFileTypes: true })
  } catch {
    return null
  }
  let start = null
  let end = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    let r
    try {
      r = JSON.parse(readFileSync(join(jobDir, e.name, 'result.json'), 'utf8'))
    } catch {
      continue
    }
    const s = parseExplicitZoned(r?.started_at)
    const en = parseExplicitZoned(r?.finished_at ?? r?.updated_at)
    if (s !== null) start = start === null ? s : Math.min(start, s)
    if (en !== null) end = end === null ? en : Math.max(end, en)
  }
  if (start === null && end === null) return null
  return { start: start ?? end, end: end ?? start, source: 'trial-level result.json (explicit Z)' }
}

/**
 * One job's window. NEVER reads the job-level result.json's own
 * started_at/finished_at (see file header — its zone cannot be determined).
 *
 *   1. Trial-level Z timestamps, widened backward (never narrowed) by the
 *      job directory name's own local stamp — real data showed a trial's own
 *      `started_at` can postdate the job's actual first docker-compose
 *      attempt by several minutes (harbor's shared-environment preflight).
 *   2. When no trial produced a Z timestamp at all: the directory-name stamp
 *      for the start, and the newest file mtime under the job dir for the
 *      end (accepting the contamination risk documented in the file header —
 *      this branch only runs when nothing better exists).
 */
export function jobWindowSingle(jobsDir, jobName) {
  const dirStart = parseDirNameStamp(jobName)
  const fromTrials = jobWindowFromTrials(jobsDir, jobName)
  if (fromTrials) {
    if (dirStart !== null && dirStart < fromTrials.start) {
      return { start: dirStart, end: fromTrials.end, source: `${fromTrials.source}, widened backward by the job dir's own name stamp` }
    }
    return fromTrials
  }
  if (dirStart === null) return null
  const mtime = newestMtimeUnder(join(jobsDir, jobName))
  if (mtime === null) return { start: dirStart, end: dirStart, source: 'job dir name stamp only (no files found under it)' }
  return { start: dirStart, end: Math.max(mtime, dirStart), source: 'job dir name stamp + newest file mtime (no trial ever stamped a Z timestamp)' }
}

/** The [start, end] window (epoch ms) a set of jobs actually ran in, plus each job's own source for disclosure. */
export function aggregateJobWindows(jobsDir, jobNames) {
  const perJob = jobNames.map((name) => ({ name, window: jobWindowSingle(jobsDir, name) }))
  const withWindow = perJob.filter((j) => j.window !== null)
  if (!withWindow.length) return { window: null, perJob }
  const start = Math.min(...withWindow.map((j) => j.window.start))
  const end = Math.max(...withWindow.map((j) => j.window.end))
  return { window: { start, end }, perJob }
}

/**
 * The retry/outage narrative from the notes file, restricted to `window`.
 * `window === null` means no job in scope had readable timestamps — every
 * note is then reported as OUT of scope rather than silently included,
 * because an unbounded window is not the same claim as a measured one.
 */
export function summarizeNotes(notes, window) {
  const inWindow = window
    ? notes.filter((n) => {
        const t = parseNoteTime(n?.at)
        return t !== null && t >= window.start && t <= window.end
      })
    : []
  const refusals = inWindow.filter((n) => String(n.message ?? '').includes('AFTER the agent produced work'))
  const neverRanReattempts = inWindow.filter((n) => String(n.message ?? '').includes('before any agent work'))
  const outagesBegan = inWindow.filter((n) => String(n.message ?? '').includes('host spawn OUTAGE began'))
  const outagesOver = inWindow.filter((n) => String(n.message ?? '').includes('outage OVER'))
  // ⛔ LEGACY, PER-ATTEMPT ROWS — distinct from the OUTAGE began/over PAIR
  // above. Every failed spawn attempt writes one of these regardless of
  // whether the outage-clock feature is even installed (it predates
  // TBENCH-HOST-SPAWN-WAIT-1's aggregation and still fires on every attempt
  // inside the floor). Measured directly against the real notes file: the
  // 2026-09-09 23:20-23:25 outage on `unseenSAM` produced ~22 of these and
  // ZERO "OUTAGE began"/"outage OVER" notes (that job predates the
  // outage-clock code), so counting only the pair would report the event as
  // if it never happened.
  const legacySpawnFailures = inWindow.filter((n) => String(n.message ?? '').includes('host could not start `docker compose'))
  return {
    consideredTotal: notes.length,
    inWindowTotal: inWindow.length,
    retryRefusals: refusals.length,
    neverRanReattempts: neverRanReattempts.length,
    outagesBegan: outagesBegan.length,
    outagesMeasured: outagesOver.length,
    outageLengthsS: outagesOver.map((n) => n.outage_s).filter((v) => typeof v === 'number'),
    // An outage that began but has no matching "OVER" note in the same window
    // either recovered after the window ended or never recovered at all —
    // either way it is not a measured length, and is disclosed as its own
    // count rather than folded into outagesMeasured.
    outagesUnresolvedInWindow: Math.max(0, outagesBegan.length - outagesOver.length),
    spawnFailuresLegacy: legacySpawnFailures.length,
  }
}

/** One prefix's (or "all jobs"'s) full disclosure. */
export function buildGroup(label, jobsDir, jobNames, retriedAttemptsDir, notes) {
  const results = jobNames.map((name) => ({ name, result: readJobResult(jobsDir, name) }))
  const readable = results.filter((r) => r.result !== null)
  const unreadable = results.filter((r) => r.result === null).map((r) => r.name)

  const preservedAttempts = jobNames.reduce((sum, name) => sum + countPreservedAttempts(retriedAttemptsDir, name), 0)
  const graded = readable.flatMap((r) => gradedExceptions(r.result))
  const { window, perJob: windowSources } = aggregateJobWindows(jobsDir, jobNames)
  const noteSummary = summarizeNotes(notes, window)

  return {
    label,
    jobs: jobNames,
    unreadableJobs: unreadable,
    window,
    windowSources,
    preservedNeverRanAttempts: preservedAttempts,
    trialsGradedDespiteException: graded.length,
    gradedExceptionRows: graded,
    notes: noteSummary,
  }
}

/** Local-time and UTC renderings of one instant, both without ambiguity about which is which. */
function fmtInstant(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return { local, utc: d.toISOString() }
}

function fmtWindow(w) {
  if (!w) return '(no job in scope has a usable timestamp — notes NOT time-filtered, none counted)'
  const s = fmtInstant(w.start)
  const e = fmtInstant(w.end)
  return `LOCAL ${s.local} .. ${e.local}   |   UTC ${s.utc} .. ${e.utc}`
}

function printGroup(g) {
  console.log(`=== ${g.label} ===`)
  console.log(`  job(s) in scope                 : ${g.jobs.length}${g.jobs.length ? '  (' + g.jobs.join(', ') + ')' : ''}`)
  if (g.unreadableJobs.length) {
    console.log(`  unreadable result.json           : ${g.unreadableJobs.length}  (${g.unreadableJobs.join(', ')})`)
  }
  console.log(`  job time span                    : ${fmtWindow(g.window)}`)
  for (const { name, window } of g.windowSources) {
    console.log(`      ${name}: ${window ? window.source : 'no usable timestamp -- excluded from the window'}`)
  }
  console.log(`  preserved never-ran attempts      : ${g.preservedNeverRanAttempts}  (retried-attempts/<job>/*__attempt*)`)
  console.log(`  trials graded despite an exception: ${g.trialsGradedDespiteException}  (exception_stats and reward_stats both name the trial)`)
  for (const row of g.gradedExceptionRows.slice(0, 25)) {
    console.log(`      ${row.exception.padEnd(28)} ${row.task}  reward=${row.reward.toFixed(1)}`)
  }
  if (g.gradedExceptionRows.length > 25) {
    console.log(`      … and ${g.gradedExceptionRows.length - 25} more`)
  }
  console.log(`  hook notes in this job's time span (mcp-data/.tb-hook-notes.jsonl):`)
  console.log(`      retry refused (agent had already produced work)   : ${g.notes.retryRefusals}`)
  console.log(`      never-ran re-attempt (before any agent work)      : ${g.notes.neverRanReattempts}`)
  console.log(`      spawn outages measured (OUTAGE began/outage OVER) : ${g.notes.outagesMeasured}` +
    (g.notes.outageLengthsS.length ? `  [${g.notes.outageLengthsS.map((s) => `${s}s`).join(', ')}]` : ''))
  if (g.notes.outagesUnresolvedInWindow) {
    console.log(`      spawn outages begun but not recorded as recovered in this window  : ${g.notes.outagesUnresolvedInWindow}`)
  }
  console.log(`      spawn failures noted (per-attempt rows, legacy)   : ${g.notes.spawnFailuresLegacy}`)
  console.log('')
}

function parseArgs(argv) {
  const prefixes = []
  let jobsDir = null
  let notesFile = null
  let retriedAttemptsDir = null
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--prefix') {
      prefixes.push(argv[++i])
    } else if (a === '--notes-file') {
      notesFile = argv[++i]
    } else if (a === '--retried-attempts-dir') {
      retriedAttemptsDir = argv[++i]
    } else if (a === '--json') {
      json = true
    } else if (!a.startsWith('--') && jobsDir === null) {
      jobsDir = a
    }
  }
  return { jobsDir: jobsDir ?? DEFAULT_JOBS_DIR, prefixes, notesFile: notesFile ?? DEFAULT_NOTES_FILE, retriedAttemptsDir: retriedAttemptsDir ?? DEFAULT_RETRIED_ATTEMPTS_DIR, json }
}

export function buildReport({ jobsDir, prefixes, notesFile, retriedAttemptsDir }) {
  const notes = readNotes(notesFile)
  const groups = prefixes.length
    ? prefixes.map((p) => buildGroup(p, jobsDir, listJobDirs(jobsDir, [p]), retriedAttemptsDir, notes))
    : [buildGroup('(all jobs)', jobsDir, listJobDirs(jobsDir, []), retriedAttemptsDir, notes)]
  return { jobsDir, notesFile, retriedAttemptsDir, groups }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const report = buildReport(opts)
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`[retry-disclosure] jobs dir: ${report.jobsDir}`)
  console.log(`[retry-disclosure] notes file: ${report.notesFile}`)
  console.log(`[retry-disclosure] retried-attempts dir: ${report.retriedAttemptsDir}`)
  console.log('')
  for (const g of report.groups) printGroup(g)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('retry-disclosure.mjs')) main()
