#!/usr/bin/env node
/**
 * `era-counts.mjs` — per-task outcome-class counts, split BEFORE and AFTER a
 * harness fix.
 *
 *   usage: node era-counts.mjs [--jobs <jobs-root>] [--index <file>]
 *            [--era <sidecar.jsonl>] [--fix <commit|ISO date>] [--repo <dir>]
 *            [--branch <name>] [--naive-offset +HH:MM]
 *            [--skip-jobs-at-or-after <prefix>] [--skip-modified-within-hours <h>]
 *            [--json]
 *
 * ⛔ WHY — MEASURED 2026-09-15 (workflow wf_dba5b1f9-a84): 17 proposed gates were
 * ranked by how many of 102 failing trials each covered. The critic found the
 * counts meaningless for ranking: 7 of the 102 were not capability failures at
 * all, and each cluster already had a shipped fix, so counted only AFTER that
 * fix each mechanism reached about 0-6 trials. A reach number that pools
 * pre-fix trials measures a problem that no longer exists. This prints the two
 * populations side by side, and names what it could not place.
 *
 * Classes come from `classifyTrial` (trial-outcome.mjs), or from a forensics
 * row's own `outcome_class` when it has one. Eras follow `resolveEra`'s ONE
 * fixed precedence: an EXACT stamp (the job's harness.json, then the row's
 * `harness_commit`) always wins; a sidecar row is used only when nothing exact
 * exists AND it names a commit; otherwise a live estimate is made.
 *
 * READ-ONLY: streams the index, reads one trial directory at a time, writes
 * nothing.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readIndexRows,
  readEraSidecar,
  loadFirstParentCommits,
  filterByEra,
  eraForTrial,
  jobInScope,
  gitIsAncestor,
  parseOffset,
  CAMPAIGN_BRANCH,
} from './harness-era.mjs'
import { classifyTrial, OUTCOME_CLASS } from './trial-outcome.mjs'
import { readHarnessStamp } from './harness-stamp.mjs'
import { INDEX_FILE } from './post-trial-forensics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const CLASS_ORDER = [
  OUTCOME_CLASS.CLEAN_PASS,
  OUTCOME_CLASS.CAPABILITY_FAIL,
  OUTCOME_CLASS.EXCEPTION_ZEROED_GRADER_PASSED,
  OUTCOME_CLASS.VERIFIER_NEVER_RAN,
  OUTCOME_CLASS.API_CUTOFF_UNGRADED,
  OUTCOME_CLASS.NON_RUN,
  OUTCOME_CLASS.UNGRADED_OTHER,
]

const SHORT = ['CP', 'CF', 'EZ', 'VNR', 'API', 'NR', 'UO']

const zero = () => Object.fromEntries(CLASS_ORDER.map((c) => [c, 0]))

/**
 * The era of one indexed trial, by ONE fixed precedence.
 *
 * ⛔ THE DEFECT THIS CLOSES — MEASURED 2026-09-15 (adversarial review of this
 * layer). eraCounts read the backfill sidecar FIRST and a row's exact
 * `harness_commit` only when the sidecar had no row, and it never read
 * harness.json once a sidecar row existed. So a sidecar ESTIMATE beat an EXACT
 * stamp, and a sidecar row with commit:null (a trial with no started_at, or a
 * backfill that loaded no timeline) blocked every fallback. The sidecar is
 * written once and goes stale; a stamp is a recorded fact.
 *
 *   1. EXACT: the job's harness.json, when it names a commit.
 *   2. EXACT: the forensics row's `harness_commit`.
 *   3. the sidecar row, only when it names a commit (an estimate, or an exact
 *      stamp copied at backfill time whose harness.json is gone; either way it
 *      says which in `estimated`).
 *   4. a live estimate, when a timeline is loaded (`estimate`). A null sidecar
 *      commit is disclosed in that estimate's basis and masks nothing.
 *   5. otherwise the sidecar's null row as it is (it carries its basis), or null.
 */
export function resolveEra({
  row,
  sidecarRow = null,
  stamp = null,
  commits = [],
  branch = CAMPAIGN_BRANCH,
  naiveOffsetMinutes = null,
  estimate = true,
}) {
  const opts = { commits, branch, naiveOffsetMinutes }
  if (stamp && typeof stamp.commit === 'string' && stamp.commit) {
    return eraForTrial(row, { ...opts, stampOf: () => stamp })
  }
  if (typeof row?.harness_commit === 'string' && row.harness_commit) {
    const e = eraForTrial(row, { ...opts, stampOf: () => ({ commit: row.harness_commit }) })
    e.basis = 'forensics row harness_commit, copied from harness.json when the trial finished'
    return e
  }
  if (sidecarRow && typeof sidecarRow.commit === 'string' && sidecarRow.commit) return sidecarRow
  if (estimate) {
    const e = eraForTrial(row, { ...opts, stampOf: () => stamp })
    if (sidecarRow) e.basis = `${e.basis}; sidecar row had commit:null (${sidecarRow.basis ?? 'no basis recorded'})`
    return e
  }
  return sidecarRow ?? null
}

/** `{total, byClass, byTask}` for a set of classified trials. */
export function countClasses(trials) {
  const byClass = zero()
  const byTask = {}
  for (const t of trials) {
    byClass[t.class] = (byClass[t.class] ?? 0) + 1
    const task = t.task ?? '?'
    byTask[task] ??= zero()
    byTask[task][t.class] = (byTask[task][t.class] ?? 0) + 1
  }
  return { total: trials.length, byClass, byTask }
}

export async function eraCounts({
  jobsRoot,
  indexPath = join(jobsRoot, INDEX_FILE),
  eraPath = null,
  fix = null,
  repo = HERE,
  branch = CAMPAIGN_BRANCH,
  naiveOffsetMinutes = null,
  scope = {},
}) {
  const { rows, lines, bad, duplicates } = await readIndexRows(indexPath)
  const sidecar = await readEraSidecar(eraPath)
  const timeline = fix ? loadFirstParentCommits({ repo, branch }) : { commits: [], error: null }
  if (fix && !timeline.commits.length) throw new Error(timeline.error ?? `no harness commits on ${branch}`)
  const stamps = new Map()
  const stampOf = (job) => {
    if (!stamps.has(job)) stamps.set(job, readHarnessStamp(join(jobsRoot, job)))
    return stamps.get(job)
  }

  const trials = []
  const skipped = {}
  for (const r of rows) {
    const s = jobInScope(r.job, { jobsRoot, ...scope })
    if (!s.inScope) {
      skipped[s.why] = (skipped[s.why] ?? 0) + 1
      continue
    }
    const c = r.outcome_class
      ? { class: r.outcome_class, reason: r.outcome_reason ?? null, exceptionType: r.outcome_exception ?? r.exception ?? null }
      : classifyTrial(join(jobsRoot, r.job, r.trial))
    const era = resolveEra({
      row: r,
      sidecarRow: sidecar.get(`${r.job}/${r.trial}`) ?? null,
      stamp: stampOf(r.job),
      commits: timeline.commits,
      branch,
      naiveOffsetMinutes,
      estimate: Boolean(fix),
    })
    trials.push({
      trial: r.trial,
      job: r.job,
      task: r.task ?? String(r.trial).split('__')[0],
      class: c.class,
      reason: c.reason,
      exceptionType: c.exceptionType ?? null,
      era,
    })
  }

  const out = {
    scope: { index_lines: lines, unparseable_lines: bad, duplicate_rows_folded: duplicates, skipped },
    all: countClasses(trials),
    trials,
  }
  if (!fix) return out
  const f = filterByEra(trials, fix, { commits: timeline.commits, isAncestor: gitIsAncestor({ repo }) })
  const reasons = new Map(f.excludedTrials.map((x) => [`${x.job}/${x.trial}`, x.why]))
  const older = trials.filter((t) => reasons.get(`${t.job}/${t.trial}`)?.startsWith('older'))
  const unknown = trials.filter((t) => reasons.get(`${t.job}/${t.trial}`)?.startsWith('unknown-era'))
  return {
    ...out,
    fix: f.fix,
    before: countClasses(older),
    after: countClasses(f.included),
    unknown: countClasses(unknown),
    excluded: f.excluded,
  }
}

function row(cells, widths) {
  return cells.map((c, i) => String(c).padStart(i === 0 ? 0 : widths[i]).padEnd(i === 0 ? widths[0] : 0)).join(' ')
}

function render(r) {
  const L = []
  const skippedN = Object.values(r.scope.skipped).reduce((a, b) => a + b, 0)
  L.push(`[era-counts] ${r.all.total} trial(s) in scope (${skippedN} skipped, ${r.scope.duplicate_rows_folded} duplicate index row(s) folded)`)
  for (const [why, n] of Object.entries(r.scope.skipped)) L.push(`  skipped ${n}: ${why}`)
  L.push(`  classes: ${CLASS_ORDER.map((c, i) => `${SHORT[i]}=${c}`).join('  ')}`)
  const tasks = Object.keys(r.all.byTask).sort()
  const w = [Math.max(12, ...tasks.map((t) => t.length)), ...CLASS_ORDER.map(() => 4)]
  if (!r.fix) {
    L.push('')
    L.push(row(['task', ...SHORT], w))
    for (const t of tasks) L.push(row([t, ...CLASS_ORDER.map((c) => r.all.byTask[t][c])], w))
    L.push(row(['TOTAL', ...CLASS_ORDER.map((c) => r.all.byClass[c])], w))
    return L.join('\n')
  }
  const fixText = r.fix.kind === 'date' ? `date ${r.fix.date} -> harness ${r.fix.commit?.slice(0, 10) ?? '(before the first commit)'}` : `commit ${r.fix.commit.slice(0, 10)}${r.fix.date ? ` (${r.fix.date})` : ''}`
  L.push(`  fix: ${fixText}`)
  L.push(`  before the fix : ${r.before.total}`)
  L.push(`  after the fix  : ${r.after.total}`)
  L.push(`  unknown era    : ${r.unknown.total}   (excluded from both columns)`)
  L.push('')
  const half = (set, t) => CLASS_ORDER.map((c) => set.byTask[t]?.[c] ?? 0)
  L.push(`${row(['task', ...SHORT], w)}  |  ${row(['', ...SHORT], [0, ...w.slice(1)])}`)
  const span = CLASS_ORDER.length * 5 - 1
  L.push(`${' '.repeat(w[0])} ${'before'.padStart(span)}  |  ${'after'.padStart(span)}`)
  for (const t of tasks) {
    L.push(`${row([t, ...half(r.before, t)], w)}  |  ${row(['', ...half(r.after, t)], [0, ...w.slice(1)])}`)
  }
  L.push(
    `${row(['TOTAL', ...CLASS_ORDER.map((c) => r.before.byClass[c])], w)}  |  ${row(['', ...CLASS_ORDER.map((c) => r.after.byClass[c])], [0, ...w.slice(1)])}`,
  )
  return L.join('\n')
}

function arg(args, name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const jobsRoot = arg(args, 'jobs') ?? join(HERE, 'jobs')
  try {
    const r = await eraCounts({
      jobsRoot,
      indexPath: arg(args, 'index') ?? join(jobsRoot, INDEX_FILE),
      eraPath: arg(args, 'era') ?? null,
      fix: arg(args, 'fix') ?? null,
      repo: arg(args, 'repo') ?? HERE,
      branch: arg(args, 'branch') ?? CAMPAIGN_BRANCH,
      naiveOffsetMinutes: parseOffset(arg(args, 'naive-offset')),
      scope: {
        skipJobsAtOrAfter: arg(args, 'skip-jobs-at-or-after') ?? null,
        skipModifiedWithinHours: Number(arg(args, 'skip-modified-within-hours') ?? 0) || 0,
      },
    })
    if (args.includes('--json')) {
      const { trials, ...rest } = r
      console.log(JSON.stringify(args.includes('--with-trials') ? r : rest, null, 2))
      void trials
    } else {
      console.log(render(r))
    }
  } catch (e) {
    console.error(`[era-counts] ${e?.message ?? e}`)
    process.exit(1)
  }
}

if (process.argv[1]?.endsWith('era-counts.mjs')) main()
