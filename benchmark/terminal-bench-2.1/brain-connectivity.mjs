/**
 * brain-connectivity.mjs — F5 of TBENCH-K1-100-LOOP-1's brain-connectivity
 * fixes: a first-class, structured field recording whether the brain was
 * actually reachable during a trial.
 *
 * ⛔ WHY THIS EXISTS. Forensics over the 2026-09 corpus found 22 trials
 * corpus-wide that started with the in-container MCP connection NEVER
 * established: Claude Code got ConnectionRefused at its first `initialize`
 * call and never retries, so `terransoul-proxy-calls.jsonl` (the proxy's
 * tool-call witness log, copied per trial by run-dg.sh) stayed completely
 * EMPTY — a connection that never happened produces nothing to log. Nothing
 * read that distinction: `check-terransoul-used.sh`'s own fallback message
 * says "The brain may have CONNECTED, but it was never called" for EVERY
 * zero-call trial, which is simply wrong when the container never reached
 * the proxy at all. A separate diagnostic pass ("witness-3") went further and
 * mislabelled these as "predates instrumentation" — treating an EXISTING,
 * EMPTY, per-trial log the same as one that was never created at all. Both
 * defects come from the same place: nothing named the distinction as data.
 *
 * THE SIGNAL THIS READS. Claude Code's MCP client always sends `initialize`
 * as its first call the instant a connection succeeds — the existing
 * check-terransoul-used.sh header states this as fact ("initialize /
 * tools/list / resources/list / prompts/list are emitted by merely
 * connecting"), and mcp-auth-proxy.mjs::noteCall records every non-tools/call
 * method verbatim (`{"method":"initialize","allowed":true}`). So the proxy's
 * OWN log already carries the distinction this file names:
 *
 *   - an `initialize` line present            -> the handshake completed:  CONNECTED
 *   - the log EXISTS (run-dg.sh always creates
 *     and truncates it before starting the
 *     proxy) but holds NOT ONE recorded line   -> the container never
 *                                                 reached the proxy at all: NEVER_CONNECTED
 *   - handshake completed, but the proxy's own
 *     lifecycle log (fix F2, terransoul-proxy-status.jsonl) records a crash
 *     for this trial                          -> DROPPED_MID_TRIAL
 *   - neither file exists at all              -> genuinely predates this
 *                                                 instrumentation:          UNKNOWN
 *
 * This module only READS evidence files under one trial directory; it makes
 * no network or MCP calls itself.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const BRAIN_STATUS = Object.freeze({
  CONNECTED: 'connected',
  NEVER_CONNECTED: 'never-connected',
  DROPPED_MID_TRIAL: 'dropped-mid-trial',
  UNKNOWN: 'unknown',
})

/** Parse a JSONL file into objects, skipping any line that does not parse
 *  (a torn last line from a killed process is not fatal to the ones before
 *  it). Returns `null` when the file cannot be read at all (ENOENT etc). */
function readJsonlOrNull(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // A torn line is skipped, not fatal — matches mcp-auth-proxy.mjs's own
      // spool-reading convention (readSpool).
    }
  }
  return out
}

function handshakeSeen(callLines) {
  return callLines.some(l => l && (l.method === 'initialize' || l.method === 'notifications/initialized'))
}

/** Any evidence the proxy forwarded or recorded ANYTHING at all — a looser
 *  fallback than the exact `initialize` method, for the corner case of a
 *  truncated first line. Still requires a real recorded interaction, not
 *  merely a non-empty file (a file holding only unparseable garbage is not
 *  evidence of a connection). */
function anyInteractionSeen(callLines) {
  return callLines.some(l => l && (typeof l.method === 'string' || typeof l.tool === 'string'))
}

function crashSeen(statusLines) {
  return statusLines.some(l => l && l.event === 'crash')
}

/**
 * @param {{trialDir?: string, proxyCallsPath?: string, proxyStatusPath?: string}} input
 *   `trialDir` locates the two per-trial copies run-dg.sh writes
 *   (terransoul-proxy-calls.jsonl, terransoul-proxy-status.jsonl); explicit
 *   paths override that for a caller that already has them (or a test).
 * @returns {{status: string, reason: string, evidence: string[]}}
 */
export function classifyBrainStatus(input = {}) {
  const callsPath = input.proxyCallsPath ?? (input.trialDir ? join(input.trialDir, 'terransoul-proxy-calls.jsonl') : null)
  const statusPath = input.proxyStatusPath ?? (input.trialDir ? join(input.trialDir, 'terransoul-proxy-status.jsonl') : null)

  const callsExist = Boolean(callsPath && existsSync(callsPath))
  const statusExist = Boolean(statusPath && existsSync(statusPath))

  if (!callsExist && !statusExist) {
    return {
      status: BRAIN_STATUS.UNKNOWN,
      reason: 'no-proxy-evidence-files',
      evidence: ['neither terransoul-proxy-calls.jsonl nor terransoul-proxy-status.jsonl exists for this trial'],
    }
  }

  const callLines = callsPath ? readJsonlOrNull(callsPath) ?? [] : []
  const statusLines = statusPath ? readJsonlOrNull(statusPath) ?? [] : []

  const connected = handshakeSeen(callLines) || anyInteractionSeen(callLines)
  if (!connected) {
    return {
      status: BRAIN_STATUS.NEVER_CONNECTED,
      reason: callsExist
        ? 'proxy-calls-log-exists-but-holds-no-recorded-interaction'
        : 'proxy-calls-log-missing-but-status-log-present',
      evidence: [
        `terransoul-proxy-calls.jsonl: ${callLines.length} parsed line(s)`,
        'no "initialize", "notifications/initialized" or any recorded method/tool call — ' +
          'the container never reached this proxy (Claude Code sends initialize the instant a connection succeeds)',
      ],
    }
  }

  if (crashSeen(statusLines)) {
    const crashLine = statusLines.find(l => l && l.event === 'crash')
    return {
      status: BRAIN_STATUS.DROPPED_MID_TRIAL,
      reason: 'handshake-completed-then-proxy-crashed',
      evidence: [
        'a real MCP handshake was recorded, so the brain WAS reachable at some point',
        `terransoul-proxy-status.jsonl records a crash: ${JSON.stringify(crashLine?.reason ?? 'no reason recorded')}`,
      ],
    }
  }

  return {
    status: BRAIN_STATUS.CONNECTED,
    reason: 'handshake-completed-no-crash-recorded',
    evidence: [`${callLines.length} recorded proxy interaction(s), including the MCP handshake`],
  }
}

// ── CLI (fix F4's requeue check) ────────────────────────────────────────────
//
// usage: node brain-connectivity.mjs never-connected-and-not-passed <job_dir>
//
// Exit 0 and print "trial_name\tstatus\treason" when this job's ONE trial (one
// job = one trial, per run-two-workers.sh's own design) is BOTH
// NEVER_CONNECTED and not a clean pass — the exact shape fix F4 requeues: a
// trial that never had a working brain connection must not be counted as a
// graded failure for a capability it never actually had access to. Exit 1
// otherwise. Mirrors rate-limit-evidence.py's `killed-with-work` CLI contract
// (same exit-code convention) so run-two-workers.sh reads both the same way.
async function main() {
  const [, , cmd, jobDir] = process.argv
  if (cmd !== 'never-connected-and-not-passed' || !jobDir) {
    console.error('usage: node brain-connectivity.mjs never-connected-and-not-passed <job_dir>')
    process.exit(2)
  }
  // Dynamic and deferred to runtime on purpose: trial-outcome.mjs imports
  // this module statically (for classifyBrainStatus/BRAIN_STATUS), so a
  // top-level import back would be circular. Only the CLI path needs
  // isCleanPass, and only after both modules have finished loading.
  const { isCleanPass } = await import('./trial-outcome.mjs')

  let entries = []
  try {
    entries = readdirSync(jobDir, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch {
    process.exit(1)
  }
  for (const entry of entries) {
    const trialDir = join(jobDir, entry.name)
    let result
    try {
      result = JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'))
    } catch {
      result = null
    }
    if (result && isCleanPass(result)) continue // a real pass is never requeued for this reason
    // The proxy's evidence files live at the JOB level (run-dg.sh copies them
    // there, not into the per-trial subdirectory), so classify from jobDir.
    const brain = classifyBrainStatus({ trialDir: jobDir })
    if (brain.status === BRAIN_STATUS.NEVER_CONNECTED) {
      console.log(`${entry.name}\t${brain.status}\t${brain.reason}`)
      process.exit(0)
    }
  }
  process.exit(1)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (isMain || (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/brain-connectivity.mjs'))) {
  main()
}
