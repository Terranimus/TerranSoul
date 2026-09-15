#!/usr/bin/env node
/**
 * Tests for `harness-stamp.mjs` — which harness a job ran under, recorded at
 * launch instead of reconstructed from git-log dates afterwards.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so the
 * import throws and every case errors. The measured gap it closes: on
 * 2026-09-15 every per-mechanism count had to be restricted to trials that ran
 * AFTER the relevant harness fix, and nothing in the corpus recorded which
 * commit a trial ran under — the era was rebuilt by hand from dates.
 *
 * Hermetic: every case builds its own throwaway git repository under the OS
 * temp dir. The "git fails" cases point the stamp at a git binary that does not
 * exist, so they run the same on a machine with no git at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  captureHarnessIdentity,
  finalizeHarnessIdentity,
  readHarnessStamp,
  HARNESS_FILE,
  MAX_DIRTY_FILES,
} from './harness-stamp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'harness-stamp.mjs')
const NO_GIT = join(tmpdir(), 'definitely-not-a-git-binary', 'git.exe')

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A repo shaped like this one: a driver home two levels down, and a CLI package. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'harness-stamp-'))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'core.autocrlf', 'false')
  const home = join(repo, 'benchmark', 'terminal-bench-2.1')
  write(join(home, 'run-dg.sh'), '#!/usr/bin/env bash\necho driver\n')
  write(join(repo, 'packages', 'terransoul-cli', 'src', 'stop-hook.mjs'), 'export const x = 1\n')
  write(join(repo, 'README.md'), 'outside the harness scopes\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return { repo, home }
}

test('a job launched from a clean tree is stamped with its exact commit', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, home } = makeRepo()
  const rec = captureHarnessIdentity({ home })
  assert.equal(rec.commit, git(repo, 'rev-parse', 'HEAD'))
  assert.equal(rec.reason, null)
  assert.equal(rec.dirty, false)
  assert.deepEqual(rec.dirty_files, [])
})

test('a tracked edit under benchmark/ or packages/terransoul-cli/ is dirty; an edit elsewhere or an untracked file is not', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, home } = makeRepo()
  write(join(repo, 'README.md'), 'edited, but outside the scopes\n')
  write(join(home, 'untracked-log.out'), 'a sweep log nobody commits\n')
  assert.equal(captureHarnessIdentity({ home }).dirty, false, 'out-of-scope and untracked changes do not count')

  write(join(repo, 'packages', 'terransoul-cli', 'src', 'stop-hook.mjs'), 'export const x = 2\n')
  const rec = captureHarnessIdentity({ home })
  assert.equal(rec.dirty, true)
  assert.deepEqual(rec.dirty_files, ['packages/terransoul-cli/src/stop-hook.mjs'])
  assert.equal(rec.dirty_files_total, 1)
})

test('the dirty-file list is short, and says how many it dropped', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, home } = makeRepo()
  for (let i = 0; i < MAX_DIRTY_FILES + 5; i++) write(join(home, `f${i}.mjs`), `export const v = ${i}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'many')
  for (let i = 0; i < MAX_DIRTY_FILES + 5; i++) write(join(home, `f${i}.mjs`), `export const v = -${i}\n`)
  const rec = captureHarnessIdentity({ home })
  assert.equal(rec.dirty_files.length, MAX_DIRTY_FILES)
  assert.equal(rec.dirty_files_total, MAX_DIRTY_FILES + 5)
})

test('the EXECUTING driver snapshot is compared with the committed driver, not assumed equal', (t) => {
  // ⛔ run-two-workers.sh runs a COPY of run-dg.sh taken at sweep start, while
  // every other harness file is read live. A commit stamp alone would describe
  // a driver the job may not have executed.
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, home } = makeRepo()
  const snapDir = mkdtempSync(join(tmpdir(), 'run-dg-sweep-'))
  const same = join(snapDir, 'same')
  copyFileSync(join(home, 'run-dg.sh'), same)
  const a = captureHarnessIdentity({ home, driver: same })
  assert.equal(a.driver.matches_head, true)
  assert.equal(a.driver.blob, git(repo, 'rev-parse', 'HEAD:benchmark/terminal-bench-2.1/run-dg.sh'))

  const stale = join(snapDir, 'stale')
  writeFileSync(stale, '#!/usr/bin/env bash\necho an older driver\n')
  const b = captureHarnessIdentity({ home, driver: stale })
  assert.equal(b.driver.matches_head, false)
  assert.notEqual(b.driver.blob, b.driver.head_blob)
})

test('when git fails the stamp is commit:null WITH a reason — it never throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'harness-nogit-'))
  const rec = captureHarnessIdentity({ home, git: NO_GIT })
  assert.equal(rec.commit, null)
  assert.equal(typeof rec.reason, 'string')
  assert.match(rec.reason, /git/)
  assert.equal(rec.dirty, null, 'unknown is not clean')
})

test('a directory that is not a repository is commit:null with a reason', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const home = mkdtempSync(join(tmpdir(), 'harness-norepo-'))
  const rec = captureHarnessIdentity({ home, env: { GIT_CEILING_DIRECTORIES: dirname(home) } })
  assert.equal(rec.commit, null)
  assert.match(rec.reason, /rev-parse HEAD failed/)
})

test('place writes <job>/harness.json with the launch commit and records drift at the end', (t) => {
  if (!gitAvailable()) return t.skip('git is not installed on this machine')
  const { repo, home } = makeRepo()
  const scratch = mkdtempSync(join(tmpdir(), 'harness-place-'))
  const captured = join(scratch, 'captured.json')
  const job = join(scratch, 'jobs', 'ts0915w0-20260915-120000')
  mkdirSync(job, { recursive: true })

  let r = spawnSync(process.execPath, [CLI, 'capture', '--home', home, '--out', captured, '--job', 'ts0915w0-20260915-120000'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const launch = git(repo, 'rev-parse', 'HEAD')

  // Another session commits while the job runs.
  write(join(home, 'post-trial-forensics.mjs'), 'export {}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'mid-job commit')

  r = spawnSync(process.execPath, [CLI, 'place', '--captured', captured, '--home', home, '--out', join(job, HARNESS_FILE)], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const stamp = readHarnessStamp(job)
  assert.equal(stamp.commit, launch, 'the job is stamped with the commit it LAUNCHED under')
  assert.equal(stamp.job, 'ts0915w0-20260915-120000')
  assert.equal(stamp.at_end.commit, git(repo, 'rev-parse', 'HEAD'))
  assert.equal(stamp.drifted_during_job, true)
})

test('place with git unavailable still writes commit:null plus a reason, and exits 0', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-place-nogit-'))
  const home = join(scratch, 'home')
  mkdirSync(home)
  const captured = join(scratch, 'captured.json')
  const job = join(scratch, 'job')
  mkdirSync(job)
  const env = { ...process.env, TB_HARNESS_GIT: NO_GIT }
  let r = spawnSync(process.execPath, [CLI, 'capture', '--home', home, '--out', captured], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  r = spawnSync(process.execPath, [CLI, 'place', '--captured', captured, '--home', home, '--out', join(job, HARNESS_FILE)], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const stamp = JSON.parse(readFileSync(join(job, HARNESS_FILE), 'utf8'))
  assert.equal(stamp.commit, null)
  assert.match(stamp.reason, /git/)
})

test('place with a lost launch capture still writes a record that says so', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-place-lost-'))
  const job = join(scratch, 'job')
  mkdirSync(job)
  const r = spawnSync(
    process.execPath,
    [CLI, 'place', '--captured', join(scratch, 'never-written.json'), '--home', scratch, '--out', join(job, HARNESS_FILE)],
    { encoding: 'utf8', env: { ...process.env, TB_HARNESS_GIT: NO_GIT } },
  )
  assert.equal(r.status, 0, r.stderr)
  const stamp = JSON.parse(readFileSync(join(job, HARNESS_FILE), 'utf8'))
  assert.equal(stamp.commit, null)
  assert.match(stamp.reason, /launch capture/)
})

test('place never creates a job directory harbor did not create, and never overwrites a stamp', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-place-nodir-'))
  const captured = join(scratch, 'captured.json')
  writeFileSync(captured, JSON.stringify(finalizeHarnessIdentity(null, { home: scratch, git: NO_GIT })))
  const missingJob = join(scratch, 'jobs', 'never-created')
  let r = spawnSync(process.execPath, [CLI, 'place', '--captured', captured, '--home', scratch, '--out', join(missingJob, HARNESS_FILE)], {
    encoding: 'utf8',
    env: { ...process.env, TB_HARNESS_GIT: NO_GIT },
  })
  assert.equal(r.status, 0)
  assert.equal(existsSync(missingJob), false, 'no job dir was invented')

  const job = join(scratch, 'jobs', 'existing')
  mkdirSync(job, { recursive: true })
  writeFileSync(join(job, HARNESS_FILE), '{"commit":"first-writer"}\n')
  r = spawnSync(process.execPath, [CLI, 'place', '--captured', captured, '--home', scratch, '--out', join(job, HARNESS_FILE)], {
    encoding: 'utf8',
    env: { ...process.env, TB_HARNESS_GIT: NO_GIT },
  })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(readFileSync(join(job, HARNESS_FILE), 'utf8')).commit, 'first-writer')
})

test('readHarnessStamp is null for a job with no stamp or an unreadable one', () => {
  const job = mkdtempSync(join(tmpdir(), 'harness-read-'))
  assert.equal(readHarnessStamp(job), null)
  writeFileSync(join(job, HARNESS_FILE), '{torn')
  assert.equal(readHarnessStamp(job), null)
})
