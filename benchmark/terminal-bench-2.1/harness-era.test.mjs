#!/usr/bin/env node
/**
 * Tests for `harness-era.mjs`, `backfill-harness-era.mjs` and `era-counts.mjs`
 * — which harness each trial most likely ran under, and counting only the
 * trials that ran after a given fix.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: none of the three modules existed, so
 * the imports throw and every case errors. The measured gap: on 2026-09-15 each
 * failure mechanism had to be counted over trials that ran after its harness
 * fix, nothing recorded a trial's harness commit, and the era was rebuilt by
 * hand from git-log dates — so a count could silently include trials that ran
 * BEFORE the fix, which is exactly the confound the critic found.
 *
 * Hermetic: synthetic commit lists, a throwaway git repository with pinned
 * committer dates, and a synthetic jobs root under the OS temp dir. The CLI
 * cases assert that the forensics index and every job file are byte-identical
 * after the run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  parseStartedAt,
  estimateEra,
  eraForTrial,
  filterByEra,
  loadFirstParentCommits,
  jobInScope,
  gitIsAncestor,
} from './harness-era.mjs'
import { eraCounts } from './era-counts.mjs'
import { OUTCOME_CLASS } from './trial-outcome.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKFILL = join(HERE, 'backfill-harness-era.mjs')
const COUNTS = join(HERE, 'era-counts.mjs')

const sha = (n) => String(n).repeat(40).slice(0, 40)
/** oldest -> newest, the order `loadFirstParentCommits` returns. */
const COMMITS = [
  { sha: sha(1), date: '2026-09-01T00:00:00Z' },
  { sha: sha(2), date: '2026-09-05T00:00:00Z' },
  { sha: sha(3), date: '2026-09-10T00:00:00Z' },
  { sha: sha(4), date: '2026-09-12T00:00:00Z' },
].map((c, ord) => ({ ...c, ms: Date.parse(c.date), ord }))

test('an estimate NEVER picks a commit dated after the trial, and says it is an estimate', () => {
  for (const [started, want] of [
    ['2026-09-05T00:00:00Z', sha(2)], // exactly at a commit: that commit
    ['2026-09-04T23:59:59Z', sha(1)], // one second before it: the previous one
    ['2026-09-11T08:00:00Z', sha(3)],
    ['2026-09-30T00:00:00Z', sha(4)],
  ]) {
    const e = estimateEra(started, COMMITS)
    assert.equal(e.commit, want, started)
    assert.equal(e.estimated, true)
    assert.ok(Date.parse(e.commit_date) <= Date.parse(started), `${e.commit_date} is not after ${started}`)
    assert.match(e.basis, /committer date <= trial started_at/)
  }
})

test('a trial that started before every harness commit, or has no start time, has an UNKNOWN era', () => {
  const early = estimateEra('2026-08-01T00:00:00Z', COMMITS)
  assert.equal(early.commit, null)
  assert.equal(early.estimated, true)
  assert.match(early.basis, /before the first/)
  const none = estimateEra(null, COMMITS)
  assert.equal(none.commit, null)
  assert.match(none.basis, /no started_at/)
})

test("harbor's naive started_at is local time; an explicit offset makes it exact", () => {
  // MEASURED in this corpus: 33 index rows carry a naive stamp, and their job
  // names (written by `date +%Y%m%d-%H%M%S`) show they are LOCAL time.
  const naive = parseStartedAt('2026-09-11T18:51:31.754944', { naiveOffsetMinutes: 600 })
  assert.equal(new Date(naive.ms).toISOString(), '2026-09-11T08:51:31.754Z')
  assert.equal(naive.basis, 'naive-offset+600m')
  const utc = parseStartedAt('2026-09-11T09:02:03.642703Z')
  assert.equal(new Date(utc.ms).toISOString(), '2026-09-11T09:02:03.642Z')
  assert.equal(utc.basis, 'explicit-zone')
  assert.equal(parseStartedAt('not a date'), null)
})

test('an exact harness.json stamp always wins over an estimate', () => {
  const trial = { job: 'j1', trial: 't1', started_at: '2026-09-11T00:00:00Z' }
  const exact = eraForTrial(trial, { commits: COMMITS, stampOf: () => ({ commit: sha(2), dirty: true }) })
  assert.equal(exact.commit, sha(2), 'the stamp, not the date-based sha(3)')
  assert.equal(exact.estimated, false)
  assert.equal(exact.dirty, true)
  // A stamp that could not read git falls back to the estimate, and says why.
  const nullStamp = eraForTrial(trial, {
    commits: COMMITS,
    stampOf: () => ({ commit: null, reason: 'git rev-parse HEAD failed: not found' }),
  })
  assert.equal(nullStamp.commit, sha(3))
  assert.equal(nullStamp.estimated, true)
  assert.match(nullStamp.basis, /harness\.json has commit:null/)
})

test('the era filter keeps only trials at or after the fix, and COUNTS what it excluded and why', () => {
  const trials = [
    { trial: 'a', era: { commit: sha(1) } }, // older
    { trial: 'b', era: { commit: sha(2) } }, // older
    { trial: 'c', era: { commit: sha(3) } }, // the fix itself
    { trial: 'd', era: { commit: sha(4) } }, // after
    { trial: 'e', era: { commit: null, basis: 'no started_at' } }, // unknown
    { trial: 'f' }, // no era at all
    { trial: 'g', era: { commit: 'f'.repeat(40) } }, // not on the chain
  ]
  const r = filterByEra(trials, sha(3).slice(0, 10), { commits: COMMITS })
  assert.deepEqual(r.included.map((t) => t.trial), ['c', 'd'])
  assert.equal(r.excluded.older, 2)
  assert.equal(r.excluded.unknownEra, 3)
  assert.deepEqual(
    r.excludedTrials.map((x) => [x.trial, x.why.split(':')[0]]),
    [
      ['a', 'older'],
      ['b', 'older'],
      ['e', 'unknown-era'],
      ['f', 'unknown-era'],
      ['g', 'unknown-era'],
    ],
  )
  assert.equal(r.fix.commit, sha(3))
})

test('an ISO-date fix means "the harness as it stood at that date", not "commits dated after it"', () => {
  // A trial whose harness commit is the last one BEFORE the date ran the same
  // harness that existed at the date — excluding it would be wrong.
  const trials = [
    { trial: 'before', era: { commit: sha(2) } },
    { trial: 'same-harness', era: { commit: sha(3) } },
    { trial: 'after', era: { commit: sha(4) } },
  ]
  const r = filterByEra(trials, '2026-09-11T00:00:00Z', { commits: COMMITS })
  assert.equal(r.fix.kind, 'date')
  assert.equal(r.fix.commit, sha(3))
  assert.deepEqual(r.included.map((t) => t.trial), ['same-harness', 'after'])
  assert.equal(r.excluded.older, 1)
})

test('a fix commit that is not on the first-parent chain is refused, not silently matched', () => {
  assert.throws(() => filterByEra([], 'abcdef1234', { commits: COMMITS }), /not on the first-parent/)
})

test('live or recently-modified jobs are out of scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'era-scope-'))
  mkdirSync(join(root, 'ts09151605w1-20260915-173128'))
  mkdirSync(join(root, 'ts09150901w0-20260915-090101'))
  mkdirSync(join(root, 'tsb09031729-20260903-173033'))
  const scope = { jobsRoot: root, skipJobsAtOrAfter: 'ts091516', skipModifiedWithinHours: 0 }
  assert.equal(jobInScope('ts09151605w1-20260915-173128', scope).inScope, false)
  assert.equal(jobInScope('ts09160001w0-20260916-000001', scope).inScope, false)
  assert.equal(jobInScope('ts09150901w0-20260915-090101', scope).inScope, true)
  assert.equal(jobInScope('tsb09031729-20260903-173033', scope).inScope, true, 'a different series is not compared')
  // modified within the window
  const recent = jobInScope('ts09150901w0-20260915-090101', { ...scope, skipModifiedWithinHours: 3 })
  assert.equal(recent.inScope, false)
  assert.match(recent.why, /modified within/)
})

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
}

function gitAt(cwd, date, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  }).trim()
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * A repo whose first-parent history has: two harness commits, one commit that
 * touches nothing in scope, and a merge of a side branch whose own commit must
 * NOT appear (only the merge does, on the first-parent chain).
 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'era-repo-'))
  const g = (date, ...a) => gitAt(repo, date, ...a)
  g('2026-09-01T00:00:00Z', 'init', '-q', '-b', 'campaign')
  g('2026-09-01T00:00:00Z', 'config', 'user.email', 't@example.invalid')
  g('2026-09-01T00:00:00Z', 'config', 'user.name', 't')
  g('2026-09-01T00:00:00Z', 'config', 'core.autocrlf', 'false')
  write(join(repo, 'benchmark', 'a.mjs'), '1\n')
  g('2026-09-01T00:00:00Z', 'add', '-A')
  g('2026-09-01T00:00:00Z', 'commit', '-q', '-m', 'h1')
  const h1 = g('2026-09-01T00:00:00Z', 'rev-parse', 'HEAD')
  write(join(repo, 'docs', 'x.md'), 'out of scope\n')
  g('2026-09-03T00:00:00Z', 'add', '-A')
  g('2026-09-03T00:00:00Z', 'commit', '-q', '-m', 'docs only')
  const docs = g('2026-09-03T00:00:00Z', 'rev-parse', 'HEAD')
  g('2026-09-04T00:00:00Z', 'checkout', '-q', '-b', 'side')
  write(join(repo, 'packages', 'terransoul-cli', 'b.mjs'), 'side\n')
  g('2026-09-04T00:00:00Z', 'add', '-A')
  g('2026-09-04T00:00:00Z', 'commit', '-q', '-m', 'side work')
  const side = g('2026-09-04T00:00:00Z', 'rev-parse', 'HEAD')
  g('2026-09-06T00:00:00Z', 'checkout', '-q', 'campaign')
  g('2026-09-06T00:00:00Z', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  const merge = g('2026-09-06T00:00:00Z', 'rev-parse', 'HEAD')
  write(join(repo, 'benchmark', 'a.mjs'), '2\n')
  g('2026-09-10T00:00:00Z', 'add', '-A')
  g('2026-09-10T00:00:00Z', 'commit', '-q', '-m', 'h2')
  const h2 = g('2026-09-10T00:00:00Z', 'rev-parse', 'HEAD')
  // A docs-only commit on top of the last harness commit: the shape of the
  // branch HEAD a job gets stamped with (ca380253 on 2026-09-15).
  write(join(repo, 'docs', 'x.md'), 'still out of scope\n')
  g('2026-09-11T00:00:00Z', 'add', '-A')
  g('2026-09-11T00:00:00Z', 'commit', '-q', '-m', 'docs at the tip')
  const tip = g('2026-09-11T00:00:00Z', 'rev-parse', 'HEAD')
  // Harness work on a branch that is never merged; its parent is h2.
  g('2026-09-12T00:00:00Z', 'checkout', '-q', '-b', 'unmerged', h2)
  write(join(repo, 'benchmark', 'a.mjs'), 'unmerged\n')
  g('2026-09-12T00:00:00Z', 'add', '-A')
  g('2026-09-12T00:00:00Z', 'commit', '-q', '-m', 'unmerged harness work')
  const unmerged = g('2026-09-12T00:00:00Z', 'rev-parse', 'HEAD')
  g('2026-09-12T00:00:00Z', 'checkout', '-q', 'campaign')
  return { repo, h1, docs, side, merge, h2, tip, unmerged }
}

test('first-parent history of the campaign branch, limited to the harness scopes', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, h1, side, merge, h2 } = makeRepo()
  const { commits, error } = loadFirstParentCommits({ repo, branch: 'campaign' })
  assert.equal(error, null)
  assert.deepEqual(commits.map((c) => c.sha), [h1, merge, h2], 'oldest first; no docs-only commit; no side commit')
  assert.ok(!commits.some((c) => c.sha === side))
  assert.deepEqual(commits.map((c) => c.ord), [0, 1, 2])
  const bad = loadFirstParentCommits({ repo, branch: 'no-such-branch' })
  assert.deepEqual(bad.commits, [])
  assert.match(bad.error, /git log failed/)
})

test('the timeline is the same when the repo is given as a SUBDIRECTORY — the default is the driver dir', (t) => {
  // ⛔ FOUND BY THE FIRST REAL CORPUS RUN (2026-09-15): the backfill's default
  // `repo` is this benchmark directory, and `git -C <subdir> log -- benchmark
  // packages/terransoul-cli` resolves those pathspecs RELATIVE TO THE SUBDIR,
  // so it matched nothing and reported "0 harness commit(s)" with no error —
  // 1383 of 1383 trials came back unknown-era. The case above passed because it
  // pointed at the repo root. Scopes must be repository-root-relative.
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, h1, merge, h2 } = makeRepo()
  const fromSubdir = loadFirstParentCommits({ repo: join(repo, 'benchmark'), branch: 'campaign' })
  assert.equal(fromSubdir.error, null)
  assert.deepEqual(fromSubdir.commits.map((c) => c.sha), [h1, merge, h2])
})

test('an EMPTY timeline is an error, never a silent "every trial is unknown"', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo } = makeRepo()
  const none = loadFirstParentCommits({ repo, branch: 'campaign', paths: ['no-such-scope'] })
  assert.deepEqual(none.commits, [])
  assert.match(none.error, /no commits/)
})

test('an EXACT stamp that is off the timeline counts at its nearest timeline ancestor, by default', (t) => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: called without `isAncestor`, filterByEra
  // looked an era commit up on the timeline by sha alone, so an EXACT stamp
  // whose commit did not itself touch benchmark/ or packages/terransoul-cli/
  // was excluded as unknown-era. All three off-timeline stamps below were
  // dropped from both columns. MEASURED 2026-09-15: the campaign branch HEAD
  // (ca380253, a docs commit) is off the timeline, and 43 of 215 first-parent
  // commits since 2026-08-31 touch neither scope. So the most reliable era in
  // the corpus was the one most likely to be discarded.
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, h1, docs, merge, h2, tip, unmerged } = makeRepo()
  const { commits, error } = loadFirstParentCommits({ repo, branch: 'campaign' })
  assert.equal(error, null)
  for (const s of [docs, tip, unmerged]) assert.ok(!commits.some((c) => c.sha === s), 'the stamp is off the timeline')
  const exact = (trial, commit) => ({ trial, job: `job-${trial}`, era: { commit, estimated: false, basis: 'harness.json' } })
  const trials = [
    exact('docs-tip', tip), // docs-only commit on top of h2 -> h2
    exact('unmerged', unmerged), // harness work on an unmerged branch off h2 -> h2
    exact('docs-between', docs), // docs-only commit between h1 and the merge -> h1
    exact('on-timeline', h2),
    exact('not-in-repo', 'e'.repeat(40)),
  ]

  const r = filterByEra(trials, h2, { commits, repo })
  assert.deepEqual(r.included.map((x) => x.trial), ['docs-tip', 'unmerged', 'on-timeline'])
  for (const x of r.included) assert.equal(x.era.estimated, false, `${x.trial} is still an exact stamp`)
  assert.equal(r.excluded.older, 1)
  assert.equal(r.excluded.unknownEra, 1, 'only the commit this repository does not have')
  const why = Object.fromEntries(r.excludedTrials.map((x) => [x.trial, x.why]))
  assert.match(why['docs-between'], new RegExp(`^older: .*nearest timeline ancestor ${h1.slice(0, 10)}`))
  assert.match(why['not-in-repo'], /^unknown-era/)
  assert.deepEqual(
    r.placed.map((p) => [p.trial, p.timeline_commit]),
    [
      ['docs-tip', h2],
      ['unmerged', h2],
      ['docs-between', h1],
    ],
    'every placement is disclosed',
  )

  // The same stamps against earlier fixes: docs-between ran h1's harness.
  const all = ['docs-tip', 'unmerged', 'docs-between', 'on-timeline']
  assert.deepEqual(filterByEra(trials, h1, { commits, repo }).included.map((x) => x.trial), all)
  assert.deepEqual(
    filterByEra(trials, merge, { commits, repo }).included.map((x) => x.trial),
    ['docs-tip', 'unmerged', 'on-timeline'],
  )
  // A date fix goes through the same placement.
  assert.deepEqual(filterByEra(trials, '2026-09-02T00:00:00Z', { commits, repo }).included.map((x) => x.trial), all)

  // An explicit git ancestry check gives the same answer as the default.
  const explicit = filterByEra(trials, h2, { commits, isAncestor: gitIsAncestor({ repo }) })
  assert.deepEqual(explicit.included.map((x) => x.trial), r.included.map((x) => x.trial))
})

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file under a directory, with its hash — to prove nothing was rewritten. */
function snapshotTree(root) {
  const out = {}
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[p] = sha256(p)
    }
  }
  walk(root)
  return out
}

/** A jobs root with an index, trial dirs, and one job carrying an exact stamp. */
function makeCorpus(h1, h2) {
  const jobs = mkdtempSync(join(tmpdir(), 'era-jobs-'))
  const rows = []
  const trial = (job, name, started, { reward, exception = null, stdout, tokens = 5000 }) => {
    const dir = join(jobs, job, name)
    const result = {
      started_at: started,
      verifier_result: reward === null ? null : { rewards: { reward } },
      exception_info: exception ? { exception_type: exception } : null,
      agent_result: { n_input_tokens: 1000, n_output_tokens: tokens },
    }
    write(join(dir, 'result.json'), JSON.stringify(result))
    if (stdout !== undefined) write(join(dir, 'verifier', 'test-stdout.txt'), stdout)
    rows.push({ schema: 1, task: name.split('__')[0], trial: name, job, reward, started_at: started })
  }
  const passOut = '===== test session starts =====\ncollected 1 item\n===== 1 passed in 0.1s =====\n'
  const failOut = '===== test session starts =====\ncollected 2 items\n===== 1 failed, 1 passed in 0.1s =====\n'
  trial('old-20260902-000000', 'alpha-task__1', '2026-09-02T00:00:00Z', { reward: 0, stdout: failOut })
  trial('old-20260902-000000', 'beta-task__1', '2026-09-02T01:00:00Z', { reward: 1, exception: 'AgentTimeoutError', stdout: passOut })
  trial('new-20260911-000000', 'alpha-task__2', '2026-09-11T00:00:00Z', { reward: 1, stdout: passOut })
  trial('new-20260911-000000', 'beta-task__2', '2026-09-11T01:00:00Z', {
    reward: 0,
    stdout: '/tests/test.sh: line 19: uvx: command not found\n',
  })
  trial('undated-20260911-000000', 'alpha-task__3', null, { reward: 0, stdout: failOut })
  // an exact stamp that points at h1 even though the trial is dated after h2
  write(join(jobs, 'new-20260911-000000', 'harness.json'), JSON.stringify({ commit: h1, dirty: false }))
  const index = join(jobs, 'forensics-index.jsonl')
  // a duplicate row for the same trial, as a re-run of forensics appends
  writeFileSync(index, `${[...rows, rows[0]].map((r) => JSON.stringify(r)).join('\n')}\n`)
  return { jobs, index }
}

test('the backfill CLI writes a sidecar, marks estimates, lets stamps win, and rewrites NOTHING', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, h1, h2 } = makeRepo()
  const { jobs, index } = makeCorpus(h1, h2)
  const before = snapshotTree(jobs)
  const out = join(mkdtempSync(join(tmpdir(), 'era-out-')), 'era.jsonl')
  const r = spawnSync(
    process.execPath,
    [BACKFILL, '--jobs', jobs, '--repo', repo, '--branch', 'campaign', '--out', out],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(snapshotTree(jobs), before, 'the index, every trial and every job file are byte-identical')

  const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 5, 'one row per trial — the duplicate index row is folded')
  const by = Object.fromEntries(rows.map((x) => [x.trial, x]))
  assert.equal(by['alpha-task__1'].commit, h1)
  assert.equal(by['alpha-task__1'].estimated, true)
  // the stamp wins over the date (the date alone would say h2)
  assert.equal(by['alpha-task__2'].commit, h1)
  assert.equal(by['alpha-task__2'].estimated, false)
  assert.equal(by['alpha-task__3'].commit, null)
  for (const x of rows.filter((y) => y.estimated === true && y.commit)) {
    assert.ok(Date.parse(x.commit_date) <= Date.parse(x.started_at), `${x.trial}: ${x.commit_date} > ${x.started_at}`)
  }
  // both trials of the stamped job are exact; the two older ones are estimates
  assert.match(r.stdout, /5 trial\(s\): 2 estimated, 2 exact, 1 unknown/)

  // Refuses to write over the index it reads.
  const clobber = spawnSync(process.execPath, [BACKFILL, '--jobs', jobs, '--repo', repo, '--branch', 'campaign', '--out', index], {
    encoding: 'utf8',
  })
  assert.notEqual(clobber.status, 0)
  assert.deepEqual(snapshotTree(jobs), before)
})

test('era-counts prints per-task class counts before and after a fix, and reports the excluded', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, h1, h2 } = makeRepo()
  const { jobs } = makeCorpus(h1, h2)
  const before = snapshotTree(jobs)
  const era = join(mkdtempSync(join(tmpdir(), 'era-out-')), 'era.jsonl')
  let r = spawnSync(process.execPath, [BACKFILL, '--jobs', jobs, '--repo', repo, '--branch', 'campaign', '--out', era], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  r = spawnSync(
    process.execPath,
    [COUNTS, '--jobs', jobs, '--era', era, '--repo', repo, '--branch', 'campaign', '--fix', h2, '--json'],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  // alpha-task__2 and beta-task__2 are dated after h2, but the job's EXACT
  // stamp says h1 — so they are BEFORE the fix. Only alpha-task__3 has no era.
  assert.equal(j.after.total, 0)
  assert.equal(j.before.total, 4)
  assert.equal(j.excluded.unknownEra, 1)
  assert.equal(j.before.byClass['capability-fail'], 1)
  assert.equal(j.before.byClass['exception-zeroed-grader-passed'], 1)
  assert.equal(j.before.byClass['verifier-never-ran'], 1)
  assert.equal(j.before.byClass['clean-pass'], 1)
  assert.equal(j.before.byTask['beta-task']['verifier-never-ran'], 1)
  assert.deepEqual(snapshotTree(jobs), before, 'counting reads, never writes')

  // With a fix at h1, every dated trial is at or after the fix.
  r = spawnSync(process.execPath, [COUNTS, '--jobs', jobs, '--era', era, '--repo', repo, '--branch', 'campaign', '--fix', h1], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /alpha-task/)
  assert.match(r.stdout, /after the fix/)
  assert.match(r.stdout, /unknown era\s*: 1/)
})

test('era-counts: an EXACT stamp always beats a sidecar row, and a null sidecar commit masks nothing', async (t) => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: eraCounts read the backfill sidecar FIRST
  // and a forensics row's exact `harness_commit` only when the sidecar had no
  // row. It never read harness.json once a sidecar row existed. So a stale
  // estimate beat an exact stamp, and a sidecar row with commit:null blocked
  // every fallback. On that code, trial 1 below counts BEFORE the fix, trials
  // 2 and 4 are unknown-era, and only trial 3 is after (after.total 1, not 4).
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, h1, h2 } = makeRepo()
  const jobs = mkdtempSync(join(tmpdir(), 'era-precedence-'))
  const passOut = '===== test session starts =====\ncollected 1 item\n===== 1 passed in 0.1s =====\n'
  const rows = []
  const trial = (job, name, started, extra = {}) => {
    write(
      join(jobs, job, name, 'result.json'),
      JSON.stringify({ started_at: started, verifier_result: { rewards: { reward: 1 } }, agent_result: { n_output_tokens: 10 } }),
    )
    write(join(jobs, job, name, 'verifier', 'test-stdout.txt'), passOut)
    rows.push({ schema: 1, task: name.split('__')[0], trial: name, job, reward: 1, started_at: started, ...extra })
  }
  const J = {
    row: 'rowstamp-20260911-000000',
    job: 'jobstamp-20260911-000000',
    est: 'estimate-20260911-000000',
    live: 'nullside-20260911-000000',
  }
  // 1. the forensics row carries an exact commit; the sidecar holds an older estimate
  trial(J.row, 'alpha-task__row', '2026-09-11T00:00:00Z', { harness_commit: h2 })
  // 2. the job has an exact harness.json; the sidecar row says commit:null
  trial(J.job, 'alpha-task__job', null)
  write(join(jobs, J.job, 'harness.json'), JSON.stringify({ commit: h2, dirty: false }))
  // 3. no exact stamp anywhere: the sidecar estimate is used
  trial(J.est, 'alpha-task__est', '2026-09-11T00:00:00Z')
  // 4. no exact stamp, sidecar commit:null: the live estimate is still made
  trial(J.live, 'alpha-task__live', '2026-09-11T00:00:00Z')
  writeFileSync(join(jobs, 'forensics-index.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`)
  const side = join(mkdtempSync(join(tmpdir(), 'era-out-')), 'era.jsonl')
  const sidecarRow = (job, name, commit, basis) => JSON.stringify({ job, trial: name, commit, estimated: true, basis })
  writeFileSync(
    side,
    `${[
      sidecarRow(J.row, 'alpha-task__row', h1, 'a stale estimate'),
      sidecarRow(J.job, 'alpha-task__job', null, 'no started_at on the trial'),
      sidecarRow(J.est, 'alpha-task__est', h2, 'an estimate'),
      sidecarRow(J.live, 'alpha-task__live', null, 'no harness commits loaded at backfill time'),
    ].join('\n')}\n`,
  )
  const before = snapshotTree(jobs)

  const r = await eraCounts({ jobsRoot: jobs, eraPath: side, fix: h2, repo, branch: 'campaign' })
  const era = Object.fromEntries(r.trials.map((x) => [x.trial, x.era]))
  assert.equal(era['alpha-task__row'].commit, h2, 'the row\'s exact commit, not the sidecar\'s h1')
  assert.equal(era['alpha-task__row'].estimated, false)
  assert.equal(era['alpha-task__job'].commit, h2, 'harness.json, not the sidecar\'s null')
  assert.equal(era['alpha-task__job'].estimated, false)
  assert.equal(era['alpha-task__est'].commit, h2, 'a sidecar estimate is used when nothing exact exists')
  assert.equal(era['alpha-task__est'].estimated, true)
  assert.equal(era['alpha-task__live'].commit, h2, 'a null sidecar commit does not block the live estimate')
  assert.equal(era['alpha-task__live'].estimated, true)
  assert.match(era['alpha-task__live'].basis, /sidecar row had commit:null/)
  assert.equal(r.after.total, 4)
  assert.equal(r.before.total, 0)
  assert.equal(r.excluded.unknownEra, 0)
  assert.deepEqual(snapshotTree(jobs), before, 'counting reads, never writes')
})

test('era-counts has a column for every outcome class, and a class read from a row keeps its exception', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: CLASS_ORDER had six classes and no
  // api-cutoff-ungraded, the classifier filed an API cut-off with no grade
  // under verifier-never-ran, and a row-sourced class read `exception`, a field
  // the forensics index never writes, so its exception type was always null.
  const jobs = mkdtempSync(join(tmpdir(), 'era-classes-'))
  write(
    join(jobs, 'job-a', 'cut-task__1', 'result.json'),
    JSON.stringify({ verifier_result: null, exception_info: { exception_type: 'ApiRateLimitError' }, agent_result: { n_output_tokens: 900 } }),
  )
  const rows = [
    { schema: 1, task: 'cut-task', trial: 'cut-task__1', job: 'job-a' },
    {
      schema: 1,
      task: 'cut-task',
      trial: 'cut-task__2',
      job: 'job-b',
      outcome_class: 'api-cutoff-ungraded',
      outcome_reason: 'graded-zero-under-run-breaking-exception:UnknownApiError',
      outcome_exception: 'UnknownApiError',
    },
  ]
  writeFileSync(join(jobs, 'forensics-index.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`)
  const r = spawnSync(process.execPath, [COUNTS, '--jobs', jobs, '--json', '--with-trials'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(j.all.byClass).sort(), Object.values(OUTCOME_CLASS).sort(), 'one column per class')
  assert.equal(j.all.byClass['api-cutoff-ungraded'], 2)
  assert.equal(j.all.byClass['verifier-never-ran'], 0)
  assert.deepEqual(
    j.trials.map((x) => x.exceptionType),
    ['ApiRateLimitError', 'UnknownApiError'],
  )
  const table = spawnSync(process.execPath, [COUNTS, '--jobs', jobs], { encoding: 'utf8' })
  assert.equal(table.status, 0, table.stderr)
  assert.match(table.stdout, /API=api-cutoff-ungraded/)
  assert.match(table.stdout, /^TOTAL\s+0\s+0\s+0\s+0\s+2\s+0\s+0\s*$/m)
})
