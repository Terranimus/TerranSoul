/**
 * `harness-era.mjs` — which harness a trial ran under, and counting only the
 * trials that ran AFTER a given harness fix.
 *
 * ⛔ THE CONFOUND THIS CLOSES — MEASURED 2026-09-15 (workflow wf_dba5b1f9-a84,
 * critic verdict). A taxonomy of 102 failing trials ranked 17 proposed gates by
 * reach. Every failure cluster already had a shipped harness fix, and counted
 * only over trials that ran after that fix each mechanism reached about 0-6
 * trials; since 2026-09-12 only 7 of 79 graded trials failed. So the ranking
 * was mostly a count of mechanisms that were ALREADY FIXED. Nothing recorded
 * which harness commit a trial ran under, and the era was rebuilt by hand from
 * git-log dates.
 *
 * Two sources, never confused:
 *
 *   * EXACT — `jobs/<job>/harness.json`, written by run-dg.sh at job launch
 *     (harness-stamp.mjs). Always wins. An exact commit need not be ON the
 *     timeline (a docs-only HEAD, an unmerged branch): `filterByEra` counts it
 *     at its nearest timeline ancestor and it stays `estimated: false`.
 *   * ESTIMATED — for history: the latest first-parent commit on the campaign
 *     branch that touched benchmark/ or packages/terransoul-cli/ with committer
 *     date <= the trial's started_at. Every estimate carries
 *     `estimated: true` and its basis, because it is an inference with known
 *     failure modes: a commit can land on another checkout first, a sweep's
 *     run-dg.sh is a snapshot older than its commit, and a dirty tree is
 *     invisible to git log.
 *
 * READ-ONLY with respect to the corpus. It reads `forensics-index.jsonl` as a
 * stream and at most one `harness.json` per job, and never lists a jobs root
 * recursively.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { statSync, createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_SCOPES } from './harness-stamp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The campaign's branch. Its first-parent history is the harness timeline. */
export const CAMPAIGN_BRANCH = 'root-cause-sweep-2026-08-31'

export const ERA_SIDECAR_FILE = 'harness-era-estimates.jsonl'

function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  )
}

export function estimateBasis(branch = CAMPAIGN_BRANCH) {
  return `latest first-parent commit on ${branch} touching benchmark/ or packages/terransoul-cli/ with committer date <= trial started_at`
}

/**
 * A trial's `started_at` as epoch ms, with how it was read.
 *
 * ⛔ HARBOR WRITES TWO SHAPES. Most rows carry an explicit zone (`…Z`); some
 * carry a NAIVE stamp, which is the host's LOCAL time — measured on this corpus
 * against job names, which `date +%Y%m%d-%H%M%S` writes in local time. A naive
 * stamp read as UTC shifts the trial by the host offset (10 h here) and picks
 * the wrong era, so the basis is recorded on every estimate and an explicit
 * offset can pin it.
 */
export function parseStartedAt(value, { naiveOffsetMinutes = null } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null
  const s = value.trim().replace(/(\.\d{3})\d+/, '$1')
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? { ms, basis: 'explicit-zone' } : null
  }
  if (typeof naiveOffsetMinutes === 'number' && Number.isFinite(naiveOffsetMinutes)) {
    const ms = Date.parse(`${s}Z`)
    if (!Number.isFinite(ms)) return null
    const sign = naiveOffsetMinutes >= 0 ? '+' : ''
    return { ms: ms - naiveOffsetMinutes * 60000, basis: `naive-offset${sign}${naiveOffsetMinutes}m` }
  }
  const ms = new Date(s).getTime()
  return Number.isFinite(ms) ? { ms, basis: 'naive-host-local' } : null
}

/** `+10:00` / `-05:30` / `600` -> minutes; null when absent or malformed. */
export function parseOffset(text) {
  if (text == null || text === '') return null
  const m = String(text).match(/^([+-])(\d{2}):?(\d{2})$/)
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** `%H<TAB>%cI` lines -> `[{sha, date, ms}]`, in the order given. */
export function parseCommitLog(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const [sha, date = ''] = line.split('\t')
      return { sha: sha.trim(), date: date.trim(), ms: Date.parse(date.trim()) }
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha) && Number.isFinite(c.ms))
}

/**
 * The harness timeline: first-parent commits of `branch` touching the harness
 * scopes, OLDEST FIRST, each with its first-parent ordinal `ord`.
 *
 * `--first-parent` matters twice: a side branch's own commits never ran as the
 * checked-out harness, and a merge is judged against its FIRST parent, so a
 * merge that brought harness changes in is on the timeline.
 */
export function loadFirstParentCommits({
  repo,
  branch = CAMPAIGN_BRANCH,
  paths = HARNESS_SCOPES,
  git = process.env.TB_HARNESS_GIT || 'git',
} = {}) {
  try {
    // ⛔ `:/` MAKES EACH SCOPE REPOSITORY-ROOT-RELATIVE. Without it git resolves
    // a pathspec against `-C <repo>`, and the default repo is this benchmark
    // SUBDIRECTORY — the first real corpus run matched nothing and reported
    // 1383 of 1383 trials unknown-era with no error at all.
    const out = execFileSync(
      git,
      ['-C', repo, 'log', '--first-parent', '--format=%H%x09%cI', branch, '--', ...paths.map((p) => `:/${p}`)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
    )
    const commits = parseCommitLog(out)
      .reverse()
      .map((c, ord) => ({ ...c, ord }))
    if (!commits.length) {
      // An empty timeline turns every trial into unknown-era; say so as an
      // error instead of letting it read like a corpus with no history.
      return { commits, error: `git log returned no commits for ${branch} touching ${paths.join(', ')}`, branch, paths }
    }
    return { commits, error: null, branch, paths }
  } catch (e) {
    return {
      commits: [],
      error: `git log failed: ${firstLine(e?.stderr) || firstLine(e?.message) || 'unknown'}`,
      branch,
      paths,
    }
  }
}

const SORTED = new WeakMap()
const BY_SHA = new WeakMap()
const BY_ORD = new WeakMap()

function sortedByDate(commits) {
  let s = SORTED.get(commits)
  if (!s) {
    s = [...commits].sort((a, b) => a.ms - b.ms || a.ord - b.ord)
    SORTED.set(commits, s)
  }
  return s
}

function bySha(commits) {
  let m = BY_SHA.get(commits)
  if (!m) {
    m = new Map(commits.map((c) => [c.sha, c]))
    BY_SHA.set(commits, m)
  }
  return m
}

function byOrd(commits) {
  let s = BY_ORD.get(commits)
  if (!s) {
    s = [...commits].sort((a, b) => a.ord - b.ord)
    BY_ORD.set(commits, s)
  }
  return s
}

/**
 * The latest timeline commit that is an ancestor of, or equal to, `commit`:
 * the harness a job stamped with `commit` ran, as far as the timeline can say.
 *
 * ⛔ WHY — MEASURED 2026-09-15 (adversarial review of this layer). An exact
 * `harness.json` stamp is the HEAD a job launched at, and HEAD is often NOT a
 * harness commit. The campaign branch HEAD that day (ca380253) was a docs
 * commit, and 43 of 215 first-parent commits since 2026-08-31 touch neither
 * benchmark/ nor packages/terransoul-cli/. Looking a stamp up on the timeline
 * by sha alone marked those EXACT stamps unknown-era, so the most reliable era
 * in the corpus fell out of both columns unless the caller happened to pass an
 * ancestry check.
 *
 * Binary search is sound because the timeline is ONE first-parent chain: each
 * timeline commit is an ancestor of every later one, so "is an ancestor of
 * `commit`" holds for a prefix of the timeline and fails after it. That costs
 * about log2(timeline length) ancestry checks per distinct stamp.
 *
 * @param {string} commit
 * @param {object[]} commits the timeline (`loadFirstParentCommits().commits`)
 * @param {(ancestor: string, descendant: string) => boolean|null} isAncestor
 * @returns {{commit: object|null, answered: boolean}} `answered: false` when
 *   the check could not answer, e.g. a commit this repository does not have.
 */
export function nearestTimelineAncestor(commit, commits, isAncestor) {
  const direct = bySha(commits).get(commit)
  if (direct) return { commit: direct, answered: true }
  const s = byOrd(commits)
  let lo = 0
  let hi = s.length - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const a = isAncestor(s[mid].sha, commit)
    if (a !== true && a !== false) return { commit: null, answered: false }
    if (a) {
      found = s[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return { commit: found, answered: true }
}

/**
 * The estimated era of a trial that started at `startedAt`: the commit with the
 * greatest committer date that is <= the start. Never a later one.
 */
export function estimateEra(startedAt, commits, { branch = CAMPAIGN_BRANCH, naiveOffsetMinutes = null } = {}) {
  const unknown = (basis, startedBasis = null) => ({
    commit: null,
    commit_date: null,
    ord: null,
    estimated: true,
    basis,
    started_at_basis: startedBasis,
  })
  const t = parseStartedAt(startedAt, { naiveOffsetMinutes })
  if (!t) {
    return unknown(startedAt ? `unparseable started_at ${JSON.stringify(startedAt)}` : 'no started_at on the trial')
  }
  const s = sortedByDate(commits)
  let lo = 0
  let hi = s.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s[mid].ms <= t.ms) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (idx < 0) {
    return unknown(
      commits.length
        ? `trial started before the first harness commit on ${branch}`
        : `no harness commits loaded for ${branch}`,
      t.basis,
    )
  }
  const c = s[idx]
  return {
    commit: c.sha,
    commit_date: c.date,
    ord: c.ord,
    estimated: true,
    basis: estimateBasis(branch),
    started_at_basis: t.basis,
  }
}

/**
 * The era of one indexed trial: its job's exact stamp when it has one, the
 * date-based estimate otherwise.
 *
 * @param {{job?: string, started_at?: string|null}} trial an index row
 * @param {{commits: object[], stampOf?: (job: string) => object|null,
 *          branch?: string, naiveOffsetMinutes?: number|null}} opts
 */
export function eraForTrial(trial, { commits, stampOf = () => null, branch = CAMPAIGN_BRANCH, naiveOffsetMinutes = null } = {}) {
  const stamp = trial?.job ? stampOf(trial.job) : null
  if (stamp && typeof stamp.commit === 'string' && stamp.commit) {
    const known = bySha(commits).get(stamp.commit)
    return {
      commit: stamp.commit,
      commit_date: known?.date ?? null,
      ord: known?.ord ?? null,
      estimated: false,
      basis: 'harness.json written by run-dg.sh at job launch',
      dirty: stamp.dirty ?? null,
      driver_matches_head: stamp.driver?.matches_head ?? null,
      drifted_during_job: stamp.drifted_during_job ?? null,
    }
  }
  const e = estimateEra(trial?.started_at ?? null, commits, { branch, naiveOffsetMinutes })
  if (stamp) e.basis = `${e.basis}; harness.json has commit:null (${stamp.reason ?? 'no reason recorded'})`
  return e
}

/**
 * Only the trials whose harness era is AT OR AFTER `fix`, plus how many were
 * excluded and why.
 *
 * @param {Array<{trial?: string, job?: string, era?: {commit: string|null, basis?: string}}>} trials
 * @param {string} fix a commit (full or abbreviated sha on the timeline) or an
 *   ISO date. A DATE means "the harness as it stood at that date": it resolves
 *   to the latest timeline commit <= the date, so a trial that ran that same
 *   harness is not excluded merely because its commit predates the date.
 * @param {{commits: object[], isAncestor?: (ancestor: string, descendant: string) => boolean|null,
 *          repo?: string, git?: string}} opts
 *   An era commit that is NOT on the timeline (an exact stamp taken at a
 *   docs-only HEAD, or on another branch) is counted at its nearest timeline
 *   ancestor (`nearestTimelineAncestor`). By DEFAULT that is answered by
 *   `git merge-base --is-ancestor` in `repo`, so no caller has to remember to
 *   pass anything; `isAncestor` replaces the git check. Each placement is
 *   listed in `placed`, and the trial's own era object is never changed, so an
 *   exact stamp stays `estimated: false`. A fix commit off the timeline is still
 *   refused unless `isAncestor` is passed.
 */
export function filterByEra(trials, fix, { commits, isAncestor = null, repo = HERE, git = undefined } = {}) {
  const explicitAncestry = typeof isAncestor === 'function'
  const ancestry = explicitAncestry ? isAncestor : gitIsAncestor({ repo, git })
  let fixInfo
  const text = String(fix ?? '').trim()
  if (/^[0-9a-f]{7,40}$/i.test(text)) {
    const lower = text.toLowerCase()
    const matches = commits.filter((c) => c.sha.startsWith(lower))
    if (matches.length > 1) throw new Error(`fix ${text} is ambiguous on the first-parent chain`)
    if (matches.length === 1) {
      fixInfo = { kind: 'commit', commit: matches[0].sha, date: matches[0].date, ord: matches[0].ord }
    } else if (explicitAncestry) {
      fixInfo = { kind: 'commit', commit: text, date: null, ord: null }
    } else {
      throw new Error(`fix commit ${text} is not on the first-parent chain of the harness timeline`)
    }
  } else {
    if (!parseStartedAt(text)) throw new Error(`fix ${JSON.stringify(text)} is neither a commit nor an ISO date`)
    const at = estimateEra(text, commits)
    fixInfo = { kind: 'date', date: text, commit: at.commit, ord: at.commit ? at.ord : -1 }
  }

  const placements = new Map()
  const placeOf = (sha) => {
    if (!placements.has(sha)) placements.set(sha, nearestTimelineAncestor(sha, commits, ancestry))
    return placements.get(sha)
  }
  const included = []
  const excludedTrials = []
  const placed = []
  let older = 0
  let unknownEra = 0
  const exclude = (tr, why) => excludedTrials.push({ trial: tr?.trial ?? null, job: tr?.job ?? null, why })
  for (const tr of trials) {
    const era = tr?.era
    if (!era || !era.commit) {
      unknownEra++
      exclude(tr, `unknown-era: ${era?.basis ?? 'no era recorded'}`)
      continue
    }
    const short = era.commit.slice(0, 10)
    let atOrAfter = null
    let via = ''
    let unknownWhy = `unknown-era: harness commit ${short} is not on the first-parent chain`
    if (fixInfo.ord !== null) {
      const p = placeOf(era.commit)
      if (p.commit) {
        atOrAfter = p.commit.ord >= fixInfo.ord
        if (p.commit.sha !== era.commit) {
          via = ` (nearest timeline ancestor ${p.commit.sha.slice(0, 10)})`
          placed.push({ trial: tr?.trial ?? null, job: tr?.job ?? null, commit: era.commit, timeline_commit: p.commit.sha })
        }
      } else {
        unknownWhy = p.answered
          ? `unknown-era: no timeline commit is an ancestor of harness commit ${short}`
          : `unknown-era: harness commit ${short} is not on the first-parent chain and git could not place it`
      }
    } else if (fixInfo.commit) {
      atOrAfter = ancestry(fixInfo.commit, era.commit)
    }
    if (atOrAfter === null || atOrAfter === undefined) {
      unknownEra++
      exclude(tr, unknownWhy)
    } else if (atOrAfter) {
      included.push(tr)
    } else {
      older++
      exclude(tr, `older: harness commit ${short}${via} predates ${fixInfo.commit ? fixInfo.commit.slice(0, 10) : fixInfo.date}`)
    }
  }
  return { fix: fixInfo, included, excluded: { older, unknownEra }, excludedTrials, placed }
}

/** `git merge-base --is-ancestor`, cached; null when git cannot answer. */
export function gitIsAncestor({ repo, git = process.env.TB_HARNESS_GIT || 'git' }) {
  const cache = new Map()
  return (ancestor, descendant) => {
    const key = `${ancestor}..${descendant}`
    if (!cache.has(key)) {
      const r = spawnSync(git, ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], {
        stdio: 'ignore',
        windowsHide: true,
      })
      cache.set(key, r.status === 0 ? true : r.status === 1 ? false : null)
    }
    return cache.get(key)
  }
}

/**
 * Is a job in the counting scope?
 *
 * `skipJobsAtOrAfter` names a job-series prefix (`ts091516`): a job in the SAME
 * series (same letters, then a digit) whose name sorts at or after it is out of
 * scope, because a live sweep may still be writing it. A job of another series
 * (`tsb0903…`) is never compared. `skipModifiedWithinHours` excludes a job
 * directory touched recently — one stat of that one directory, never a scan.
 */
export function jobInScope(job, { jobsRoot = null, skipJobsAtOrAfter = null, skipModifiedWithinHours = 0, now = Date.now() } = {}) {
  const name = String(job ?? '')
  if (skipJobsAtOrAfter) {
    const stem = String(skipJobsAtOrAfter).match(/^[A-Za-z]+/)?.[0] ?? ''
    if (stem && new RegExp(`^${stem}\\d`).test(name) && name.slice(0, skipJobsAtOrAfter.length) >= skipJobsAtOrAfter) {
      return { inScope: false, why: `job series ${stem} at or after ${skipJobsAtOrAfter} (a live sweep may be writing it)` }
    }
  }
  if (skipModifiedWithinHours > 0 && jobsRoot) {
    try {
      const st = statSync(join(jobsRoot, name))
      if (now - st.mtimeMs < skipModifiedWithinHours * 3600e3) {
        return { inScope: false, why: `job directory modified within the last ${skipModifiedWithinHours} h` }
      }
    } catch {
      // a job with no directory stays in scope; reading its trial will say so
    }
  }
  return { inScope: true, why: null }
}

/**
 * Every row of a forensics index, read as a STREAM, one row per job/trial.
 * The index is append-only and a forensics re-run appends a second row for the
 * same trial; the LAST row wins, the count of folded duplicates is reported.
 */
export async function readIndexRows(indexPath) {
  const rows = new Map()
  let lines = 0
  let bad = 0
  if (!existsSync(indexPath)) return { rows: [], lines, bad, duplicates: 0 }
  const rl = createInterface({ input: createReadStream(indexPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    lines++
    let r
    try {
      r = JSON.parse(line)
    } catch {
      bad++
      continue
    }
    if (!r || typeof r.trial !== 'string' || typeof r.job !== 'string') {
      bad++
      continue
    }
    rows.set(`${r.job}/${r.trial}`, r)
  }
  return { rows: [...rows.values()], lines, bad, duplicates: lines - bad - rows.size }
}

/** An era sidecar (backfill output) as `Map<"job/trial", row>`. */
export async function readEraSidecar(path) {
  const m = new Map()
  if (!path || !existsSync(path)) return m
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && typeof r.trial === 'string' && typeof r.job === 'string') m.set(`${r.job}/${r.trial}`, r)
    } catch {
      // a torn line is skipped, never fatal
    }
  }
  return m
}
