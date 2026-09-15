#!/usr/bin/env node
/**
 * `backfill-harness-era.mjs` — ESTIMATE, for every indexed trial, the harness
 * commit it most likely ran under, into a SIDECAR.
 *
 *   usage: node backfill-harness-era.mjs [--jobs <jobs-root>] [--index <file>]
 *            [--repo <dir>] [--branch <name>] [--out <sidecar.jsonl>]
 *            [--naive-offset +HH:MM] [--skip-jobs-at-or-after <prefix>]
 *            [--skip-modified-within-hours <h>]
 *
 * ⛔ WHY — MEASURED 2026-09-15 (workflow wf_dba5b1f9-a84): every failure cluster
 * in a 102-trial taxonomy already had a shipped harness fix, and nothing in the
 * corpus recorded which commit a trial ran under, so the "after the fix" counts
 * that decide whether a lever is still worth building were rebuilt by hand from
 * git-log dates. `harness-stamp.mjs` records the era exactly from now on; this
 * is the labelled estimate for everything before it.
 *
 * THE ESTIMATE: the latest first-parent commit on the campaign branch touching
 * benchmark/ or packages/terransoul-cli/ with committer date <= the trial's
 * started_at. Every such row says `estimated: true` and carries that basis. A
 * job with a `harness.json` stamp gets the stamp instead (`estimated: false`),
 * always.
 *
 * ⛔ IT NEVER REWRITES THE CORPUS. It reads `forensics-index.jsonl` as a stream
 * and at most one `harness.json` per job, and writes exactly one file: the
 * sidecar. It refuses to write the sidecar over the index it reads.
 */
import { writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readIndexRows,
  loadFirstParentCommits,
  eraForTrial,
  jobInScope,
  parseOffset,
  CAMPAIGN_BRANCH,
  ERA_SIDECAR_FILE,
} from './harness-era.mjs'
import { readHarnessStamp } from './harness-stamp.mjs'
import { INDEX_FILE } from './post-trial-forensics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * @returns {Promise<{rows: object[], summary: object}>}
 */
export async function backfillHarnessEra({
  jobsRoot,
  indexPath = join(jobsRoot, INDEX_FILE),
  repo = HERE,
  branch = CAMPAIGN_BRANCH,
  outPath = join(jobsRoot, ERA_SIDECAR_FILE),
  naiveOffsetMinutes = null,
  scope = {},
}) {
  if (resolve(outPath) === resolve(indexPath)) {
    throw Object.assign(new Error('refusing to write the era sidecar over the forensics index it reads'), { code: 'CLOBBER' })
  }
  const { rows: indexRows, lines, bad, duplicates } = await readIndexRows(indexPath)
  const { commits, error } = loadFirstParentCommits({ repo, branch })
  const stamps = new Map()
  const stampOf = (job) => {
    if (!stamps.has(job)) stamps.set(job, readHarnessStamp(join(jobsRoot, job)))
    return stamps.get(job)
  }
  const rows = []
  const summary = {
    index_lines: lines,
    unparseable_lines: bad,
    duplicate_rows_folded: duplicates,
    commits_on_timeline: commits.length,
    git_error: error,
    trials: 0,
    estimated: 0,
    exact: 0,
    unknown: 0,
    skipped: 0,
    skipped_why: {},
  }
  for (const r of indexRows) {
    const s = jobInScope(r.job, { jobsRoot, ...scope })
    if (!s.inScope) {
      summary.skipped++
      summary.skipped_why[s.why] = (summary.skipped_why[s.why] ?? 0) + 1
      continue
    }
    const era = eraForTrial(r, { commits, stampOf, branch, naiveOffsetMinutes })
    if (!era.commit) summary.unknown++
    else if (era.estimated) summary.estimated++
    else summary.exact++
    rows.push({ trial: r.trial, job: r.job, task: r.task ?? null, started_at: r.started_at ?? null, ...era })
  }
  summary.trials = rows.length
  writeFileSync(outPath, rows.length ? `${rows.map((x) => JSON.stringify(x)).join('\n')}\n` : '')
  return { rows, summary }
}

function arg(args, name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const jobsRoot = arg(args, 'jobs') ?? join(HERE, 'jobs')
  const outPath = arg(args, 'out') ?? join(jobsRoot, ERA_SIDECAR_FILE)
  try {
    const { summary } = await backfillHarnessEra({
      jobsRoot,
      indexPath: arg(args, 'index') ?? join(jobsRoot, INDEX_FILE),
      repo: arg(args, 'repo') ?? HERE,
      branch: arg(args, 'branch') ?? CAMPAIGN_BRANCH,
      outPath,
      naiveOffsetMinutes: parseOffset(arg(args, 'naive-offset')),
      scope: {
        skipJobsAtOrAfter: arg(args, 'skip-jobs-at-or-after') ?? null,
        skipModifiedWithinHours: Number(arg(args, 'skip-modified-within-hours') ?? 0) || 0,
      },
    })
    console.log(
      `[era] ${summary.trials} trial(s): ${summary.estimated} estimated, ${summary.exact} exact, ${summary.unknown} unknown`,
    )
    console.log(
      `[era] index lines ${summary.index_lines} (${summary.duplicate_rows_folded} duplicate row(s) folded, ${summary.unparseable_lines} unparseable); ` +
        `${summary.commits_on_timeline} harness commit(s) on the timeline${summary.git_error ? ` — ${summary.git_error}` : ''}`,
    )
    if (summary.skipped) {
      for (const [why, n] of Object.entries(summary.skipped_why)) console.log(`[era] skipped ${n}: ${why}`)
    }
    console.log(`[era] sidecar: ${outPath}`)
  } catch (e) {
    console.error(`[era] ${e?.message ?? e}`)
    process.exit(e?.code === 'CLOBBER' ? 2 : 1)
  }
}

if (process.argv[1]?.endsWith('backfill-harness-era.mjs')) main()
