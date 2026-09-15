/**
 * `trial-evidence.mjs` — the on-disk facts `classifyTrial` (trial-outcome.mjs)
 * decides from. READ-ONLY: it opens files under ONE trial directory and never
 * lists anything above it.
 *
 * ⛔ WHY THIS EXISTS — MEASURED 2026-09-15 (workflow wf_dba5b1f9-a84, critic
 * verdict). A taxonomy of 102 trials where "the agent's own last check passed
 * but the grader failed" proposed 17 gates that on paper covered 100/102. Seven
 * of those 102 were never a capability failure at all:
 *
 *   * SIX had verifier reward 1 — every grader test passed — and were zeroed
 *     by AgentTimeoutError (5) or UnknownApiError (1). Reading `reward`
 *     together with `exception_info` already says so (`outcomeOf`); nothing
 *     turned that joint reading into a CLASS a taxonomy could be filtered on.
 *   * ONE was never graded: its `verifier/test-stdout.txt` shows curl failing
 *     to reach the network, the test runner's installer failing, and
 *     `uvx: command not found`. The verifier then wrote `reward.txt = 0`, so
 *     every reader that stops at the reward scored a capability failure for a
 *     run whose tests never executed.
 *
 * The second shape is only visible in the VERIFIER'S OWN OUTPUT, which is what
 * this module reads. Every signal here is a SHAPE of test-runner output (a
 * pytest session banner, a collected-items line, a tool-not-found line, a
 * network failure line) — never a task name, never a task-specific string
 * (`rules/bench-agi-purity.md`). The suite asserts the module carries none.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Host-side capture written by terransoul_hook.py from a failed agent command's raw stdout. */
export const EXEC_FAILURE_SIDECAR = '.terransoul-exec-failure.json'

/** Bound on one evidence string, so a runaway line cannot own a record. */
export const EVIDENCE_CHARS = 200

/** Bound on how many matched failure lines one trial contributes. */
export const MAX_FAILURE_LINES = 5

/**
 * Lines that mean a TOOL or the NETWORK failed, not a test.
 *
 * Only consulted when no test ran (no session banner, no collected line, no
 * CTRF tests), because inside a real pytest run these same words can be the
 * subject of a legitimate failing assertion (a server task whose test connects
 * to it). Outside a test run there is no assertion for them to belong to.
 */
export const TOOL_OR_NETWORK_FAILURE = [
  /\bcommand not found\b/i,
  /\bCould not resolve host\b/i,
  /\bFailed to connect to\b/i,
  /\bTemporary failure in name resolution\b/i,
  /\bName or service not known\b/i,
  /\bNetwork is unreachable\b/i,
  /\bConnection (?:refused|timed out)\b/i,
  /\bfailed to download\b/i,
  /\bUnable to (?:fetch|locate package)\b/i,
]

const PYTEST_SESSION = /^=+ test session starts =+\s*$/m
const COLLECTED = /\bcollected (\d+) items?\b/
const SUMMARY_LINE = /^=+ (.+?) =+\s*$/
const SUMMARY_COUNT = /(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)\b/g

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** One evidence string: trimmed, first line only, bounded to EVIDENCE_CHARS. */
export function clipEvidence(text) {
  const s = String(text ?? '').split(/\r?\n/)[0].trim()
  return s.length > EVIDENCE_CHARS ? `${s.slice(0, EVIDENCE_CHARS)}…` : s
}
const clip = clipEvidence

/**
 * Did this attempt produce agent work? `{worked, evidence}`.
 *
 * ⛔ A PORT, NOT A NEW DEFINITION. This is `trial_agent_produced_work` from
 * `merge-sweep.sh`, itself a read-only mirror of `terransoul_hook.py`'s
 * `_agent_produced_work` (TBENCH-LATE-API-RETRY-1): the same three evidence
 * sources in the same order, and the same fail-closed reading of absent
 * evidence. It exists so the non-run call made BY HAND in
 * root-cause-findings-2026-09-07.md §26 (commit f9dccd98, "0 input and 0
 * output tokens … the harness read it as a non-run rather than a failure") is
 * made the same way in all three places. Change one, change all three.
 *
 * @param {string|null} trialDir the trial directory (sources 2 and 3 need it)
 * @param {object|null|undefined} result the parsed result.json; read from
 *   `trialDir` when undefined, exactly as merge-sweep does
 */
export function agentProducedWork(trialDir, result = undefined) {
  if (trialDir && !existsSync(trialDir)) {
    return { worked: false, evidence: 'trial directory not found under this job' }
  }
  // 1. agent_result.n_output_tokens — harbor's parse of the transcript,
  //    populated even on a failed exit.
  const r = result === undefined && trialDir ? readJson(join(trialDir, 'result.json')) : result
  const tokens = r?.agent_result?.n_output_tokens
  if (tokens) return { worked: true, evidence: `${tokens} output tokens in agent_result` }
  if (trialDir) {
    // 2. the host-side capture sidecar, written from RAW stdout — independent
    //    of `docker cp`, which is what cannot run during a host spawn outage.
    try {
      const rows = JSON.parse(readFileSync(join(trialDir, 'agent', EXEC_FAILURE_SIDECAR), 'utf8'))
      const turns = Math.max(
        0,
        ...(Array.isArray(rows) ? rows : [])
          .filter((row) => row && typeof row === 'object')
          .map((row) => Number.parseInt(row.assistant_turns ?? 0, 10) || 0),
      )
      if (turns > 0) return { worked: true, evidence: `${turns} model turn(s) in the host-side capture` }
    } catch {
      // absent or unreadable evidence is not evidence
    }
    // 3. an `agent` step in trajectory.json.
    try {
      const traj = JSON.parse(readFileSync(join(trialDir, 'agent', 'trajectory.json'), 'utf8'))
      const steps = Array.isArray(traj?.steps) ? traj.steps : []
      const agentSteps = steps.filter((s) => s && typeof s === 'object' && s.source === 'agent').length
      if (agentSteps) return { worked: true, evidence: `${agentSteps} agent step(s) in trajectory.json` }
    } catch {
      // absent or unreadable evidence is not evidence
    }
  }
  return {
    worked: false,
    evidence: 'no output tokens, no model turn in the host capture, no agent step in the trajectory',
  }
}

/** Non-empty regular files directly under `dir`, sorted by name; [] when the directory is absent. */
function nonEmptyFilesIn(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const d of entries) {
    if (!d.isFile()) continue
    try {
      const size = statSync(join(dir, d.name)).size
      if (size > 0) out.push({ name: d.name, size })
    } catch {
      // a file that vanished or cannot be read is not output
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Did the agent leave ANY output of its own? `{present, evidence}`.
 *
 * A WEAKER question than `agentProducedWork`, asked only when result.json is
 * unreadable (`classifyUnreadable` in trial-outcome.mjs). Without result.json
 * there is no token count, so a trial may be called a non-run only when EVERY
 * trace of agent output is absent; anything the agent wrote keeps it out.
 *
 *   1. `agentProducedWork`: a model turn in the host capture, or an agent step
 *      in the trajectory.
 *   2. a non-empty `.txt` file directly under agent/: the agent's raw stdout,
 *      as the agent adapter or the host capture writes it there.
 *
 * Subdirectories of agent/ are NOT read. They hold the harness installing the
 * agent (a setup log is not agent output) and the agent's session store, whose
 * existence the raw stdout already covers. The host-capture sidecar counts only
 * through its turn count in (1), never by its size: it records a FAILED command,
 * which can be the install step.
 */
export function agentOutput(trialDir) {
  const work = agentProducedWork(trialDir, null)
  if (work.worked) return { present: true, evidence: work.evidence }
  const stdout = nonEmptyFilesIn(join(trialDir, 'agent')).find((f) => /\.txt$/i.test(f.name))
  if (stdout) return { present: true, evidence: `agent/${stdout.name} holds ${stdout.size} bytes of agent output` }
  return {
    present: false,
    evidence: 'no model turn in the host capture, no agent step in the trajectory, no non-empty agent/*.txt',
  }
}

/** An unindented `pkg.module.SomeError: message` line, the way a Python traceback ends. */
const EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception)(?::|$)/

/** The first exception-class line of a traceback file; null when it has none or cannot be read. */
function firstExceptionLine(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).find((l) => EXCEPTION_LINE.test(l)) ?? null
  } catch {
    return null
  }
}

/**
 * Evidence that the run RAISED, read without result.json. `string[]`, empty
 * when there is none.
 *
 *   * `exception.txt` in the trial directory: the traceback harbor writes when
 *     a trial raises. The first line naming an `…Error` or `…Exception` class is
 *     quoted, and a file with no such line still counts.
 *   * the host-side capture sidecar: terransoul_hook.py writes it ONLY for a
 *     failed agent command, immediately before harbor raises.
 */
export function exceptionEvidence(trialDir) {
  const out = []
  const excPath = join(trialDir, 'exception.txt')
  if (existsSync(excPath)) {
    const line = firstExceptionLine(excPath)
    out.push(line ? `exception.txt: ${line}` : 'exception.txt present, with no exception class line')
  }
  try {
    const rows = JSON.parse(readFileSync(join(trialDir, 'agent', EXEC_FAILURE_SIDECAR), 'utf8'))
    if (Array.isArray(rows) && rows.length) out.push(`${rows.length} failed agent command(s) in the host-side capture`)
  } catch {
    // absent or unreadable evidence is not evidence
  }
  return out
}

/**
 * Pytest's own account of whether it ran, from the text it printed.
 * Exported for the suite; `readVerifierEvidence` is the caller.
 */
export function pytestSignals(text) {
  const s = String(text ?? '')
  const collectedMatch = s.match(COLLECTED)
  let summary = null
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(SUMMARY_LINE)
    if (!m) continue
    if (/\bno tests ran\b/.test(m[1]) || new RegExp(SUMMARY_COUNT.source).test(m[1])) summary = m[1].trim()
  }
  const counts = { passed: 0, failed: 0, errors: 0, skipped: 0 }
  if (summary) {
    for (const m of summary.matchAll(SUMMARY_COUNT)) {
      const kind = m[2].startsWith('error') ? 'errors' : m[2]
      if (kind in counts) counts[kind] += Number(m[1])
    }
  }
  return {
    session: PYTEST_SESSION.test(s),
    collected: collectedMatch ? Number(collectedMatch[1]) : null,
    summary,
    counts,
    noTestsRan: Boolean(summary && /\bno tests ran\b/.test(summary)),
  }
}

/** Lines of `text` naming a tool or network failure, clipped and bounded. */
export function toolOrNetworkFailures(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (TOOL_OR_NETWORK_FAILURE.some((re) => re.test(line))) {
      out.push(clip(line))
      if (out.length >= MAX_FAILURE_LINES) break
    }
  }
  return out
}

/**
 * Everything the verifier left behind, reduced to the facts a class needs.
 *
 * @param {string} verifierDir `<trial>/verifier`
 */
export function readVerifierEvidence(verifierDir) {
  const stdoutPath = join(verifierDir, 'test-stdout.txt')
  const stdoutPresent = existsSync(stdoutPath)
  let stdout = ''
  if (stdoutPresent) {
    try {
      stdout = readFileSync(stdoutPath, 'utf8')
    } catch {
      stdout = ''
    }
  }
  const rewardPath = join(verifierDir, 'reward.txt')
  const rewardTxtPresent = existsSync(rewardPath)
  let rewardTxt = null
  if (rewardTxtPresent) {
    try {
      const raw = readFileSync(rewardPath, 'utf8').trim()
      const n = raw ? Number(raw) : Number.NaN
      rewardTxt = Number.isFinite(n) ? n : null
    } catch {
      rewardTxt = null
    }
  }
  const ctrfJson = readJson(join(verifierDir, 'ctrf.json'))
  const tests = Array.isArray(ctrfJson?.results?.tests) ? ctrfJson.results.tests : null
  const ctrf = tests
    ? {
        total: tests.length,
        passed: tests.filter((t) => String(t?.status ?? '') === 'passed').length,
        failed: tests.filter((t) => !['passed', 'skipped', 'pending'].includes(String(t?.status ?? ''))).length,
      }
    : null
  const pytest = pytestSignals(stdout)
  return {
    stdoutPresent,
    rewardTxtPresent,
    rewardTxt,
    ctrf,
    pytest,
    toolFailures: pytest.session ? [] : toolOrNetworkFailures(stdout),
    // Every non-empty file the verifier left, by name: "did the verifier write
    // anything at all" must not depend on the three files read above.
    outputFiles: nonEmptyFilesIn(verifierDir).map((f) => f.name),
  }
}
