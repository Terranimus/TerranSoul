/**
 * Tests for `retry-disclosure.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-FIX TREE (two senses):
 *   - The module did not exist at all before TBENCH-LATE-API-RETRY-1 /
 *     TBENCH-HOST-SPAWN-WAIT-1 got a reader, so importing it throws and every
 *     test in this file errors before its first assertion.
 *   - The FIRST version of this file computed a job's window from the
 *     JOB-level result.json's own `started_at`/`finished_at`, forcing `Z`
 *     onto them (`parseJobTime`). That is provably wrong: measured directly
 *     against the live jobs dir on 2026-09-11, `jobs/redo09111849-.../result.json`
 *     stamps `started_at` in LOCAL time while a sibling job stamps the same
 *     field in UTC. Forcing `Z` onto the LOCAL one reads it ~10 hours off
 *     (this host's offset), which zeroed every hook-note count for that
 *     prefix and missed the whole outage window for `unseenSAM`. The
 *     functions below (`parseExplicitZoned`, `parseDirNameStamp`,
 *     `newestMtimeUnder`, `jobWindowFromTrials`, `jobWindowSingle`,
 *     `aggregateJobWindows`) did not exist on that tree either, so importing
 *     them also throws there.
 *
 * Hermetic: temp fixture dirs and an explicit `--notes-file` /
 * `--retried-attempts-dir` (never the real mcp-data/.tb-hook-notes.jsonl or
 * the real retried-attempts/ — both can be written by a trial running RIGHT
 * NOW, so a test that read them would be neither hermetic nor reproducible).
 *
 * Where a test needs to be independent of the host's own UTC offset (which
 * can be anywhere from -12h to +14h), it separates the two candidate
 * instants by whole DAYS rather than by minutes — no real host offset can
 * make a "10 days earlier" instant read as later, so the ordering being
 * tested holds regardless of where this runs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseExplicitZoned,
  parseNoteTime,
  parseDirNameStamp,
  newestMtimeUnder,
  listJobDirs,
  gradedExceptions,
  countPreservedAttempts,
  readNotes,
  jobWindowFromTrials,
  jobWindowSingle,
  aggregateJobWindows,
  summarizeNotes,
  buildReport,
} from './retry-disclosure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'retry-disclosure.mjs')

/** Python's `datetime.now().isoformat(timespec="seconds")` shape, LOCAL components, no zone. */
function localNaiveIso(epochMs) {
  const d = new Date(epochMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'retry-disc-'))
}

/** Write a job dir with a job-level result.json and, optionally, one trial subdir. */
function mkJob(jobsDir, jobName, { jobLevel = {}, trial = null } = {}) {
  const jobDir = join(jobsDir, jobName)
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'result.json'), JSON.stringify(jobLevel))
  if (trial) {
    const trialDir = join(jobDir, trial.name)
    mkdirSync(trialDir, { recursive: true })
    writeFileSync(join(trialDir, 'result.json'), JSON.stringify(trial.result))
  }
  return jobDir
}

// ── parseExplicitZoned / parseNoteTime ──────────────────────────────────────

test('parseExplicitZoned refuses a timestamp with no zone marker at all', () => {
  // This is the fix's whole premise: a job-level timestamp cannot be trusted
  // BECAUSE it has no marker AND its zone varies by job. Refusing it (rather
  // than guessing UTC, as the pre-fix `parseJobTime` did) is what makes the
  // caller fall through to a source that IS unambiguous.
  assert.equal(parseExplicitZoned('2026-09-01T12:30:00'), null)
  assert.equal(parseExplicitZoned(''), null)
  assert.equal(parseExplicitZoned(undefined), null)
})

test('parseExplicitZoned accepts Z and numeric-offset markers', () => {
  assert.equal(parseExplicitZoned('2026-09-01T12:30:00Z'), Date.UTC(2026, 8, 1, 12, 30, 0))
  assert.equal(parseExplicitZoned('2026-09-01T12:30:00.123456Z'), Date.UTC(2026, 8, 1, 12, 30, 0, 123))
  assert.equal(parseExplicitZoned('2026-09-01T22:30:00+10:00'), Date.UTC(2026, 8, 1, 12, 30, 0))
})

test('parseNoteTime treats a naive timestamp as LOCAL (`_hook_note` stamps datetime.now())', () => {
  const naive = '2026-09-01T12:30:00'
  const local = new Date(2026, 8, 1, 12, 30, 0) // local-time constructor, no zone math
  assert.equal(parseNoteTime(naive), local.getTime())
  assert.equal(parseNoteTime(''), null)
  assert.equal(parseNoteTime('also not a date'), null)
})

// ── parseDirNameStamp / newestMtimeUnder ────────────────────────────────────

test('parseDirNameStamp reads run-dg.sh\'s own local-clock stamp from the job dir name', () => {
  // Real dir names checked against the live jobs dir: "unseenSAM-20260909-223347"
  // (job started 22:33:47 local) and "redo09111849-20260911-185128" (18:51:28
  // local) — both match this pattern.
  const t = parseDirNameStamp('unseenSAM-20260909-223347')
  assert.equal(t, new Date(2026, 8, 9, 22, 33, 47).getTime())
})

test('parseDirNameStamp returns null for a name that does not carry the stamp', () => {
  assert.equal(parseDirNameStamp('zz01-a'), null)
  assert.equal(parseDirNameStamp('not-a-job-name-at-all'), null)
})

test('newestMtimeUnder finds the latest mtime across nested files, and null for an empty/missing dir', () => {
  const base = mkTmp()
  try {
    mkdirSync(join(base, 'a', 'b'), { recursive: true })
    writeFileSync(join(base, 'a', 'old.txt'), 'x')
    writeFileSync(join(base, 'a', 'b', 'new.txt'), 'y')
    const mt = newestMtimeUnder(join(base, 'a'))
    assert.ok(typeof mt === 'number' && mt > 0)
    mkdirSync(join(base, 'empty'), { recursive: true })
    assert.equal(newestMtimeUnder(join(base, 'empty')), null)
    assert.equal(newestMtimeUnder(join(base, 'does-not-exist')), null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── the bug itself: job-level naive timestamps must NEVER decide the window ─

test('FIXTURE: a naive-LOCAL job-level stamp is never read — the dir-name+mtime fallback decides instead', () => {
  // Shaped exactly like the real regression: redo09111849's job-level
  // started_at ("...T18:51:31", no trial timestamp yet) is LOCAL. The
  // pre-fix `jobWindow`/`parseJobTime` would force `Z` onto it and read it as
  // 10 hours earlier than it really was (this host's offset) — every
  // hook-note count for that prefix then read 0. Here the job-level field is
  // deliberately set to an absurd, unrelated LOCAL-looking value (a Y2K date)
  // to prove it plays no role at all, not merely that it happens to be close.
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'poisonlocal-20260911-100000'
    mkJob(jobsDir, jobName, { jobLevel: { started_at: '2000-01-01T00:00:00.000000', finished_at: '2000-01-01T01:00:00.000000' } })
    writeFileSync(join(jobsDir, jobName, 'job.log'), 'setup output')
    const w = jobWindowSingle(jobsDir, jobName)
    assert.equal(w.start, parseDirNameStamp(jobName))
    // Nowhere near the poisoned Y2K value, in either direction.
    assert.ok(Math.abs(w.start - Date.UTC(2000, 0, 1)) > 365 * 24 * 3600_000)
    assert.match(w.source, /job dir name stamp/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('FIXTURE: a naive-UTC-shaped job-level stamp is ALSO never read', () => {
  // The other half of the regression: redo09111900's job-level started_at
  // ("...T09:02:03") is UTC-shaped -- correct by coincidence only if you
  // guess right, which is exactly the problem with guessing at all. This
  // fixture's poison is deliberately UTC-shaped and still must be ignored.
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'poisonutc-20260911-110000'
    mkJob(jobsDir, jobName, { jobLevel: { started_at: '2026-09-11T01:02:03.000000', finished_at: '2026-09-11T01:30:00.000000' } })
    writeFileSync(join(jobsDir, jobName, 'job.log'), 'setup output')
    const w = jobWindowSingle(jobsDir, jobName)
    assert.equal(w.start, parseDirNameStamp(jobName))
    assert.match(w.source, /job dir name stamp/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('FIXTURE: trial-level result.json Z timestamps are read directly and span multiple trials', () => {
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'trialz-job'
    mkdirSync(join(jobsDir, jobName), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'result.json'), JSON.stringify({ started_at: 'garbage-not-used' }))
    mkdirSync(join(jobsDir, jobName, 'task-a__t1'), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'task-a__t1', 'result.json'), JSON.stringify({
      started_at: '2026-09-11T00:05:00.000000Z',
      finished_at: '2026-09-11T00:10:00.000000Z',
    }))
    mkdirSync(join(jobsDir, jobName, 'task-b__t2'), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'task-b__t2', 'result.json'), JSON.stringify({
      started_at: '2026-09-11T00:02:00.000000Z',
      finished_at: '2026-09-11T00:20:00.000000Z',
    }))
    const w = jobWindowFromTrials(jobsDir, jobName)
    assert.equal(w.start, Date.parse('2026-09-11T00:02:00.000000Z'))
    assert.equal(w.end, Date.parse('2026-09-11T00:20:00.000000Z'))
    assert.match(w.source, /explicit Z/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('FIXTURE: the dir-name+mtime fallback fires only when no trial ever stamped a Z timestamp', () => {
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'fallback-20260911-120000'
    mkJob(jobsDir, jobName, { jobLevel: {} }) // no trial subdir at all -- setup died first
    writeFileSync(join(jobsDir, jobName, 'job.log'), 'died before any trial')
    assert.equal(jobWindowFromTrials(jobsDir, jobName), null)
    const w = jobWindowSingle(jobsDir, jobName)
    assert.equal(w.start, parseDirNameStamp(jobName))
    assert.ok(w.end >= w.start)
    assert.match(w.source, /no trial ever stamped/)

    // And when the job dir has no files at all under it (not even job.log).
    const emptyName = 'emptyfallback-20260911-130000'
    mkdirSync(join(jobsDir, emptyName), { recursive: true })
    const w2 = jobWindowSingle(jobsDir, emptyName)
    assert.equal(w2.start, parseDirNameStamp(emptyName))
    assert.equal(w2.end, w2.start)
    assert.match(w2.source, /no files found/)

    // A name that doesn't carry the dir-name stamp AND has no trial: no
    // window can be derived at all.
    mkdirSync(join(jobsDir, 'no-stamp-here'), { recursive: true })
    assert.equal(jobWindowSingle(jobsDir, 'no-stamp-here'), null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('FIXTURE: the dir-name stamp widens a trial-level window backward, never narrows or replaces the end', () => {
  // Measured on unseenSAM-20260909-223347: its one trial's own `started_at`
  // (23:23:11 local) postdates the job's real first docker-compose attempt
  // (23:20:09 local, from the notes file) by three minutes -- harbor's
  // shared-environment preflight runs before the trial's own timestamp is
  // stamped. Separated here by 10 DAYS (not 3 minutes) so the assertion holds
  // regardless of this host's own UTC offset.
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'widen-20260901-000000' // dir-name: Sept 1
    mkdirSync(join(jobsDir, jobName), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'result.json'), '{}')
    mkdirSync(join(jobsDir, jobName, 'task__t1'), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'task__t1', 'result.json'), JSON.stringify({
      started_at: '2026-09-11T00:05:00.000000Z', // Sept 11 -- ten days after the dir-name stamp
      finished_at: '2026-09-11T00:15:00.000000Z',
    }))
    const w = jobWindowSingle(jobsDir, jobName)
    assert.equal(w.start, parseDirNameStamp(jobName))
    assert.equal(w.end, Date.parse('2026-09-11T00:15:00.000000Z')) // end is NOT touched by the widening
    assert.match(w.source, /widened backward/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('FIXTURE: a dir-name stamp that is LATER than the trial window does not widen anything', () => {
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'notwiden-20260911-000000' // Sept 11
    mkdirSync(join(jobsDir, jobName), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'result.json'), '{}')
    mkdirSync(join(jobsDir, jobName, 'task__t1'), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'task__t1', 'result.json'), JSON.stringify({
      started_at: '2026-09-01T00:05:00.000000Z', // Sept 1 -- ten days BEFORE the dir-name stamp
      finished_at: '2026-09-01T00:15:00.000000Z',
    }))
    const w = jobWindowSingle(jobsDir, jobName)
    assert.equal(w.start, Date.parse('2026-09-01T00:05:00.000000Z'))
    assert.equal(w.end, Date.parse('2026-09-01T00:15:00.000000Z'))
    assert.doesNotMatch(w.source, /widened/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('aggregateJobWindows spans several jobs and reports each one\'s own source', () => {
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    // The dir-name (Sept 11) is ten days AFTER the trial's own Z timestamps
    // (Sept 1), so `jobWindowSingle` never widens this one -- the aggregate
    // start below is unambiguously the trial's Z start regardless of this
    // host's own UTC offset (see file header).
    mkdirSync(join(jobsDir, 'ag-20260911-000000', 'task__t1'), { recursive: true })
    writeFileSync(join(jobsDir, 'ag-20260911-000000', 'result.json'), '{}')
    writeFileSync(join(jobsDir, 'ag-20260911-000000', 'task__t1', 'result.json'), JSON.stringify({
      started_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T01:00:00Z',
    }))
    mkdirSync(join(jobsDir, 'ag-20260911-050000'), { recursive: true })
    writeFileSync(join(jobsDir, 'ag-20260911-050000', 'result.json'), '{}')
    const { window, perJob } = aggregateJobWindows(jobsDir, ['ag-20260911-000000', 'ag-20260911-050000'])
    assert.equal(window.start, Date.parse('2026-09-01T00:00:00Z'))
    assert.equal(perJob.length, 2)
    assert.match(perJob[0].window.source, /explicit Z/)
    assert.doesNotMatch(perJob[0].window.source, /widened/)
    assert.match(perJob[1].window.source, /no trial ever stamped/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── gradedExceptions: the TBENCH-LATE-API-RETRY-1 join ──────────────────────

test('a trial in exception_stats AND reward_stats is graded-despite-exception', () => {
  const result = {
    stats: {
      evals: {
        e1: {
          exception_stats: { UnknownApiError: ['task-alpha__t1'], AddTestsDirError: ['task-beta__t2'] },
          reward_stats: { reward: { '1.0': ['task-alpha__t1'] } },
        },
      },
    },
  }
  const rows = gradedExceptions(result)
  assert.deepEqual(rows, [{ trialId: 'task-alpha__t1', task: 'task-alpha', exception: 'UnknownApiError', reward: 1 }])
})

test('a task name containing "__" is rsplit correctly, not split on the first "__"', () => {
  const result = {
    stats: { evals: { e1: {
      exception_stats: { X: ['weird__task__name__abc123'] },
      reward_stats: { reward: { '0.0': ['weird__task__name__abc123'] } },
    } } },
  }
  const [row] = gradedExceptions(result)
  assert.equal(row.task, 'weird__task__name')
})

test('no exception_stats or reward_stats yields no rows, not a crash', () => {
  assert.deepEqual(gradedExceptions({}), [])
  assert.deepEqual(gradedExceptions({ stats: {} }), [])
  assert.deepEqual(gradedExceptions({ stats: { evals: {} } }), [])
})

// ── filesystem helpers ───────────────────────────────────────────────────

test('listJobDirs only returns directories that actually have a result.json', () => {
  const base = mkTmp()
  try {
    const jobs = join(base, 'jobs')
    mkdirSync(join(jobs, 'zz01-a'), { recursive: true })
    writeFileSync(join(jobs, 'zz01-a', 'result.json'), '{}')
    mkdirSync(join(jobs, 'zz01-b'), { recursive: true }) // no result.json -- still mid-run
    mkdirSync(join(jobs, 'other-c'), { recursive: true })
    writeFileSync(join(jobs, 'other-c', 'result.json'), '{}')
    assert.deepEqual(listJobDirs(jobs, []), ['other-c', 'zz01-a'])
    assert.deepEqual(listJobDirs(jobs, ['zz01']), ['zz01-a'])
    assert.deepEqual(listJobDirs(join(base, 'does-not-exist'), []), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('countPreservedAttempts counts only *__attempt<n> directories, not files or other names', () => {
  const base = mkTmp()
  try {
    const dir = join(base, 'retried-attempts', 'zz01-job')
    mkdirSync(join(dir, 'task-a__t1__attempt1'), { recursive: true })
    mkdirSync(join(dir, 'task-b__t2__attempt2'), { recursive: true })
    mkdirSync(join(dir, 'not-an-attempt-dir'), { recursive: true })
    writeFileSync(join(dir, 'task-c__t3__attempt3'), 'not a directory') // a FILE named like an attempt
    assert.equal(countPreservedAttempts(join(base, 'retried-attempts'), 'zz01-job'), 2)
    assert.equal(countPreservedAttempts(join(base, 'retried-attempts'), 'no-such-job'), 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('readNotes skips malformed lines instead of losing the whole file', () => {
  const base = mkTmp()
  try {
    const notesFile = join(base, 'notes.jsonl')
    writeFileSync(notesFile, '{"at":"2026-09-01T00:00:00","message":"a"}\nnot json\n\n{"at":"2026-09-01T00:00:01","message":"b"}\n')
    const notes = readNotes(notesFile)
    assert.equal(notes.length, 2)
    assert.equal(notes[0].message, 'a')
    assert.equal(notes[1].message, 'b')
    assert.deepEqual(readNotes(join(base, 'missing.jsonl')), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── summarizeNotes: the time-based correlation itself ───────────────────────

test('summarizeNotes counts nothing when the window is null, rather than including every note', () => {
  const notes = [{ at: '2026-09-01T00:00:00', message: 'AFTER the agent produced work' }]
  const s = summarizeNotes(notes, null)
  assert.equal(s.retryRefusals, 0)
  assert.equal(s.inWindowTotal, 0)
  assert.equal(s.consideredTotal, 1)
})

test('summarizeNotes classifies each message family and excludes out-of-window notes', () => {
  const winStart = Date.UTC(2026, 8, 1, 0, 0, 0)
  const winEnd = Date.UTC(2026, 8, 1, 2, 0, 0)
  const inside = (offsetMs) => localNaiveIso(winStart + offsetMs)
  const notes = [
    { at: inside(10 * 60_000), message: 'UnknownApiError AFTER the agent produced work (500 tokens); NOT re-running' },
    { at: inside(20 * 60_000), message: 'AddTestsDirError before any agent work (no tokens); re-attempting as a first attempt' },
    { at: inside(30 * 60_000), message: 'host spawn OUTAGE began on `docker compose cp tests/.`' },
    { at: inside(35 * 60_000), message: 'host spawn outage OVER: attempt 4', outage_s: 42.5, outage_failures: 3 },
    // Outside the window entirely (a day later, in local terms too).
    { at: localNaiveIso(winEnd + 24 * 3600_000), message: 'AFTER the agent produced work' },
  ]
  const s = summarizeNotes(notes, { start: winStart, end: winEnd })
  assert.equal(s.consideredTotal, 5)
  assert.equal(s.inWindowTotal, 4)
  assert.equal(s.retryRefusals, 1)
  assert.equal(s.neverRanReattempts, 1)
  assert.equal(s.outagesBegan, 1)
  assert.equal(s.outagesMeasured, 1)
  assert.deepEqual(s.outageLengthsS, [42.5])
  assert.equal(s.outagesUnresolvedInWindow, 0)
  assert.equal(s.spawnFailuresLegacy, 0)
})

test('an outage that began but never recorded as OVER in-window is disclosed, not silently dropped', () => {
  const winStart = Date.UTC(2026, 8, 1, 0, 0, 0)
  const winEnd = Date.UTC(2026, 8, 1, 2, 0, 0)
  const notes = [{ at: localNaiveIso(winStart + 60_000), message: 'host spawn OUTAGE began on `docker compose up`' }]
  const s = summarizeNotes(notes, { start: winStart, end: winEnd })
  assert.equal(s.outagesBegan, 1)
  assert.equal(s.outagesMeasured, 0)
  assert.equal(s.outagesUnresolvedInWindow, 1)
})

test('FIXTURE: legacy per-attempt spawn-failure rows are counted separately from the OUTAGE began/over pair', () => {
  // Shaped exactly like the real 2026-09-09 23:20-23:25 outage on unseenSAM:
  // ~21 per-attempt rows, ZERO "OUTAGE began"/"outage OVER" notes (that
  // event predates the outage-clock feature). Counting only the pair would
  // report this real event as if it never happened.
  const winStart = Date.UTC(2026, 8, 9, 12, 0, 0)
  const winEnd = Date.UTC(2026, 8, 9, 14, 0, 0)
  const inside = (offsetMs) => localNaiveIso(winStart + offsetMs)
  const notes = [
    { at: inside(0), message: 'host could not start `docker compose exec -e` (0xC0000142, both streams empty — the command never ran); attempt 1 of 4, re-attempting in 15s' },
    { at: inside(15_000), message: 'host could not start `docker compose exec -e` (0xC0000142, both streams empty — the command never ran); attempt 2 of 4, re-attempting in 15s' },
    { at: inside(30_000), message: '`docker compose exec -e` started on attempt 3 of 4' },
  ]
  const s = summarizeNotes(notes, { start: winStart, end: winEnd })
  assert.equal(s.spawnFailuresLegacy, 2)
  assert.equal(s.outagesBegan, 0)
  assert.equal(s.outagesMeasured, 0)
})

// ── end-to-end CLI, via the fixture flags (never the real mcp-data file) ───

test('CLI end-to-end: fixture jobs + notes produce the disclosure counts, windowed off the TRIAL-level Z timestamps', () => {
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    const jobName = 'zz01-20260901-000000'
    mkdirSync(join(jobsDir, jobName), { recursive: true })
    // Job-level result.json deliberately carries exception/reward stats (read
    // for gradedExceptions) AND a poisoned naive started_at that must NOT be
    // used for windowing.
    const winStart = Date.UTC(2026, 8, 1, 0, 0, 0)
    const winEnd = Date.UTC(2026, 8, 1, 2, 0, 0)
    writeFileSync(
      join(jobsDir, jobName, 'result.json'),
      JSON.stringify({
        started_at: '1999-01-01T00:00:00.000000', // poison -- must be ignored
        finished_at: '1999-01-01T01:00:00.000000',
        stats: {
          evals: {
            e1: {
              exception_stats: { UnknownApiError: ['task-alpha__t1'], AddTestsDirError: ['task-beta__t2'] },
              reward_stats: { reward: { '1.0': ['task-alpha__t1'] } },
            },
          },
        },
      }),
    )
    // The trial-level result.json is what actually decides the window now.
    mkdirSync(join(jobsDir, jobName, 'task-alpha__t1'), { recursive: true })
    writeFileSync(join(jobsDir, jobName, 'task-alpha__t1', 'result.json'), JSON.stringify({
      started_at: new Date(winStart).toISOString(),
      finished_at: new Date(winEnd).toISOString(),
    }))

    const retriedDir = join(base, 'retried-attempts', jobName)
    mkdirSync(join(retriedDir, 'task-beta__t2__attempt1'), { recursive: true })

    const notesFile = join(base, 'notes.jsonl')
    const inside = (offsetMs) => localNaiveIso(winStart + offsetMs)
    const lines = [
      { at: inside(5 * 60_000), message: 'UnknownApiError AFTER the agent produced work (evidence); NOT re-running the task' },
      { at: inside(6 * 60_000), message: 'AddTestsDirError before any agent work (evidence); re-attempting as a first attempt' },
      { at: inside(7 * 60_000), message: 'host spawn outage OVER: attempt 2', outage_s: 12.0, outage_failures: 1 },
      { at: inside(8 * 60_000), message: 'host could not start `docker compose up` (0xC0000142, both streams empty — the command never ran); attempt 1 of 4, re-attempting in 15s' },
      { at: localNaiveIso(winEnd + 3600_000), message: 'AFTER the agent produced work (outside window, must not count)' },
    ]
    writeFileSync(notesFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const out = execFileSync(
      process.execPath,
      [SCRIPT, jobsDir, '--prefix', 'zz01', '--notes-file', notesFile, '--retried-attempts-dir', join(base, 'retried-attempts')],
      { encoding: 'utf8' },
    )
    assert.doesNotMatch(out, /1999/) // the poisoned job-level field never surfaces
    assert.match(out, /preserved never-ran attempts\s*: 1/)
    assert.match(out, /trials graded despite an exception: 1/)
    assert.match(out, /retry refused \(agent had already produced work\)\s*: 1/)
    assert.match(out, /never-ran re-attempt \(before any agent work\)\s*: 1/)
    assert.match(out, /spawn outages measured[^:]*:\s*1\s*\[12s\]/)
    assert.match(out, /spawn failures noted \(per-attempt rows, legacy\)\s*: 1/)
    assert.doesNotMatch(out, /outside window/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('buildReport groups by --prefix when prefixes are given, and by "(all jobs)" otherwise', () => {
  const base = mkTmp()
  try {
    const jobsDir = join(base, 'jobs')
    for (const name of ['zz01-a', 'zz02-a']) {
      mkdirSync(join(jobsDir, name), { recursive: true })
      writeFileSync(join(jobsDir, name, 'result.json'), '{}')
    }
    const notesFile = join(base, 'notes.jsonl')
    writeFileSync(notesFile, '')
    const retriedDir = join(base, 'retried-attempts')

    const grouped = buildReport({ jobsDir, prefixes: ['zz01', 'zz02'], notesFile, retriedAttemptsDir: retriedDir })
    assert.deepEqual(grouped.groups.map((g) => g.label), ['zz01', 'zz02'])
    assert.deepEqual(grouped.groups[0].jobs, ['zz01-a'])

    const ungrouped = buildReport({ jobsDir, prefixes: [], notesFile, retriedAttemptsDir: retriedDir })
    assert.equal(ungrouped.groups.length, 1)
    assert.equal(ungrouped.groups[0].label, '(all jobs)')
    assert.deepEqual(ungrouped.groups[0].jobs, ['zz01-a', 'zz02-a'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
