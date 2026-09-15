#!/usr/bin/env node
/**
 * `harness-stamp.mjs` — record WHICH HARNESS a job ran under, once, when the
 * job is launched, into `jobs/<job>/harness.json`.
 *
 *   usage: node harness-stamp.mjs capture --home <driver-home> --out <file>
 *                                 [--driver <executing run-dg.sh>] [--job <name>]
 *          node harness-stamp.mjs place --captured <file> --home <driver-home>
 *                                 --out <jobs/<job>/harness.json> [--job <name>]
 *
 * ⛔ THE GAP THIS CLOSES — MEASURED 2026-09-15 (workflow wf_dba5b1f9-a84). Every
 * failure cluster in a 102-trial taxonomy already had a shipped harness fix, so
 * the only honest count of a mechanism was over trials that ran AFTER its fix —
 * about 0-6 trials each, and only 7 of 79 graded trials failed after
 * 2026-09-12. Nothing in the corpus recorded which harness commit a trial ran
 * under, so the era was rebuilt by hand from `git log` dates. That makes every
 * later reach or precision number depend on a reconstruction. This file makes
 * the era a recorded fact for every job from now on; `backfill-harness-era.mjs`
 * estimates it, labelled as an estimate, for the history.
 *
 * WHY THE STAMP IS TAKEN PER JOB IN run-dg.sh, AND NOT PER SWEEP IN
 * run-two-workers.sh. run-two-workers.sh snapshots ONLY run-dg.sh into a temp
 * file at sweep start, and exports TB_DRIVER_HOME pointing at the LIVE
 * benchmark directory. So a job executes TWO generations of harness at once:
 *
 *   * run-dg.sh itself — frozen at SWEEP start, possibly hours and many commits
 *     earlier (a 20-40 h sweep is routine);
 *   * everything run-dg.sh calls through "$HERE/..." — the proxy, the hook, the
 *     instruction file, the forensics, and packages/terransoul-cli — read from
 *     the live tree at the moment THIS job launches, on a checkout other
 *     sessions commit to while the sweep runs.
 *
 * A sweep-level stamp would describe neither. So the commit is read at JOB
 * launch, from TB_DRIVER_HOME, and the EXECUTING driver copy is hashed and
 * compared with the committed run-dg.sh (`driver.matches_head`), which states
 * the frozen generation instead of assuming it matches.
 *
 * WHY TWO STEPS. `capture` runs immediately before harbor launches and writes a
 * temp file; `place` runs after harbor has exited and copies it into the job
 * directory. The job directory is created by harbor, and run-two-workers.sh
 * reads "no job directory" as "run-dg.sh refused before harbor ran". Creating
 * the directory ahead of harbor to hold a stamp would change that verdict for a
 * harbor that dies at start-up, so `place` writes ONLY into a directory harbor
 * already created, never overwrites an existing stamp, and re-reads git at the
 * end: `drifted_during_job` is true when HEAD or the dirty flag moved while the
 * trial ran.
 *
 * ⛔ IT CANNOT FAIL A TRIAL. Every git call is caught; a missing git, a
 * directory that is not a repository, or a timeout becomes `commit: null` plus a
 * `reason`. Both commands exit 0 unconditionally, and run-dg.sh discards their
 * status. git runs with GIT_OPTIONAL_LOCKS=0 so `git status` never takes the
 * index lock on a checkout that concurrent sessions are committing to.
 *
 * DIRTY IS TRACKED FILES ONLY (`--untracked-files=no`), scoped to benchmark/ and
 * packages/terransoul-cli/. The live benchmark directory accumulates untracked
 * sweep logs by the dozen; counting them would make every stamp dirty, and an
 * untracked scan would also walk the job tree the stamp is being written into.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

export const HARNESS_FILE = 'harness.json'
export const HARNESS_SCHEMA = 1

/** Repository-root-relative directories whose state defines "the harness". */
export const HARNESS_SCOPES = ['benchmark', 'packages/terransoul-cli']

/** The dirty-file list is a pointer, not an inventory. */
export const MAX_DIRTY_FILES = 20

export const DIRTY_BASIS =
  'tracked files under benchmark/ and packages/terransoul-cli/ (git status --untracked-files=no)'

const GIT_TIMEOUT_MS = 15000

function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  )
}

function runGit(git, home, args, env) {
  try {
    const out = execFileSync(git, ['-C', home, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
    })
    return { ok: true, out: String(out) }
  } catch (e) {
    return { ok: false, why: firstLine(e?.stderr) || firstLine(e?.message) || 'unknown git failure' }
  }
}

function emptyRecord({ home, job, now }) {
  return {
    schema: HARNESS_SCHEMA,
    captured_at: now.toISOString(),
    job: job ?? null,
    driver_home: home ?? null,
    commit: null,
    reason: null,
    branch: null,
    dirty: null,
    dirty_basis: DIRTY_BASIS,
    dirty_files: [],
    dirty_files_total: null,
    driver: null,
  }
}

/**
 * The executing driver copy against the committed one. `blob` uses
 * `git hash-object --path=<repo path>` so the same clean filters (line-ending
 * conversion) apply as to the committed file; a raw sha1 of the bytes would
 * report a mismatch on every CRLF checkout.
 */
function driverIdentity({ git, home, driver, driverName, env }) {
  const d = { path: driver, name: driverName, blob: null, head_blob: null, matches_head: null, reason: null }
  if (!existsSync(driver)) {
    d.reason = 'the executing driver path does not exist'
    return d
  }
  const prefix = runGit(git, home, ['rev-parse', '--show-prefix'], env)
  if (!prefix.ok) {
    d.reason = `git rev-parse --show-prefix failed: ${prefix.why}`
    return d
  }
  const repoPath = `${prefix.out.trim()}${driverName}`
  const blob = runGit(git, home, ['hash-object', `--path=${repoPath}`, driver], env)
  if (blob.ok) d.blob = blob.out.trim()
  else d.reason = `git hash-object failed: ${blob.why}`
  const headBlob = runGit(git, home, ['rev-parse', `HEAD:${repoPath}`], env)
  if (headBlob.ok) d.head_blob = headBlob.out.trim()
  else d.reason = d.reason ?? `${repoPath} is not committed at HEAD: ${headBlob.why}`
  if (d.blob && d.head_blob) d.matches_head = d.blob === d.head_blob
  return d
}

/**
 * The harness identity of the tree at `home`, now. Never throws.
 *
 * @param {{home: string, driver?: string|null, driverName?: string, job?: string|null,
 *          git?: string, env?: object, now?: Date}} opts
 */
export function captureHarnessIdentity({
  home,
  driver = null,
  driverName = 'run-dg.sh',
  job = null,
  git = process.env.TB_HARNESS_GIT || 'git',
  env = {},
  now = new Date(),
} = {}) {
  const rec = emptyRecord({ home, job, now })
  if (!home) {
    rec.reason = 'no driver home given'
    return rec
  }
  const head = runGit(git, home, ['rev-parse', 'HEAD'], env)
  if (!head.ok) {
    rec.reason = `git rev-parse HEAD failed: ${head.why}`
    return rec
  }
  rec.commit = head.out.trim()
  const branch = runGit(git, home, ['rev-parse', '--abbrev-ref', 'HEAD'], env)
  if (branch.ok) rec.branch = branch.out.trim()
  const status = runGit(
    git,
    home,
    ['status', '--porcelain=v1', '--untracked-files=no', '--', ...HARNESS_SCOPES.map((s) => `:/${s}`)],
    env,
  )
  if (status.ok) {
    // Porcelain v1 paths are always repository-root-relative; `XY path`.
    const files = status.out
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.slice(3))
    rec.dirty = files.length > 0
    rec.dirty_files = files.slice(0, MAX_DIRTY_FILES)
    rec.dirty_files_total = files.length
  } else {
    rec.reason = `git status failed: ${status.why}`
  }
  if (driver) rec.driver = driverIdentity({ git, home, driver, driverName, env })
  return rec
}

/**
 * The launch record plus a second reading taken as the stamp is placed.
 *
 * @param {object|null} captured the launch record, or null when it was lost
 */
export function finalizeHarnessIdentity(captured, { home, git, env = {}, job = null, now = new Date() } = {}) {
  const rec =
    captured && typeof captured === 'object'
      ? { ...captured }
      : {
          ...emptyRecord({ home, job, now }),
          captured_at: null,
          reason: "launch capture missing or unreadable — the job's launch identity is unknown",
        }
  if (job && !rec.job) rec.job = job
  const end = captureHarnessIdentity({
    home: home ?? rec.driver_home,
    git: git ?? (process.env.TB_HARNESS_GIT || 'git'),
    env,
    now,
  })
  rec.at_end = {
    captured_at: end.captured_at,
    commit: end.commit,
    dirty: end.dirty,
    dirty_files_total: end.dirty_files_total,
    reason: end.reason,
  }
  rec.drifted_during_job =
    rec.commit && end.commit ? rec.commit !== end.commit || rec.dirty !== end.dirty : null
  rec.placed_at = now.toISOString()
  return rec
}

/**
 * Write a stamp into a job directory that ALREADY exists, never over one that
 * is already there. `{written, why}`.
 */
export function writeHarnessStamp(outPath, record) {
  if (!existsSync(dirname(outPath))) {
    return { written: false, why: `job directory ${dirname(outPath)} does not exist — harbor never created it` }
  }
  try {
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    return { written: true, why: null }
  } catch (e) {
    return {
      written: false,
      why: e?.code === 'EEXIST' ? `${outPath} already exists; the first stamp stands` : `${e?.message ?? e}`,
    }
  }
}

/** A job's stamp, or null when it has none or it cannot be parsed. */
export function readHarnessStamp(jobDir) {
  try {
    const j = JSON.parse(readFileSync(join(jobDir, HARNESS_FILE), 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1]
      i++
    } else {
      out._.push(a)
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  try {
    if (cmd === 'capture' && args.out) {
      const rec = captureHarnessIdentity({
        home: args.home,
        driver: args.driver ?? null,
        driverName: args['driver-name'] ?? 'run-dg.sh',
        job: args.job ?? null,
      })
      writeFileSync(args.out, `${JSON.stringify(rec, null, 2)}\n`)
      console.log(`captured ${rec.commit ?? `commit:null (${rec.reason})`}`)
    } else if (cmd === 'place' && args.out) {
      let captured = null
      try {
        captured = JSON.parse(readFileSync(args.captured, 'utf8'))
      } catch {
        captured = null
      }
      const job = args.job ?? captured?.job ?? basename(dirname(args.out))
      const rec = finalizeHarnessIdentity(captured, { home: args.home, job })
      const w = writeHarnessStamp(args.out, rec)
      console.log(
        w.written
          ? `wrote ${args.out} (commit ${rec.commit ?? `null: ${rec.reason}`}${rec.drifted_during_job ? '; the harness DRIFTED during the job' : ''})`
          : `not written: ${w.why}`,
      )
    } else {
      console.error('usage: harness-stamp.mjs capture --home <dir> --out <file> [--driver <path>] [--job <name>]')
      console.error('       harness-stamp.mjs place --captured <file> --home <dir> --out <job>/harness.json [--job <name>]')
    }
  } catch (e) {
    console.error(`[harness] failed (non-fatal): ${e?.message ?? e}`)
  }
  // Advisory bookkeeping: never able to change a run's outcome.
  process.exit(0)
}

if (process.argv[1]?.endsWith('harness-stamp.mjs')) main()
