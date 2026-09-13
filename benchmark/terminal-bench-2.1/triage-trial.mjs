#!/usr/bin/env node
/**
 * `triage-trial.mjs` — answer "where do I look?" for ONE failed trial.
 *
 *   usage: node triage-trial.mjs <trial-dir> [--out <dir>]
 *
 * ⛔ THE GAP THIS CLOSES: A FAILED TRIAL REPORTS A SCORE, NOT A DIRECTION.
 *
 * `reward=0` is compatible with four completely different situations that need
 * four different responses, and telling them apart took ~15 hand-run commands
 * on 2026-09-01 before any actual diagnosis could begin:
 *
 *   1. the trial ERRORED and the agent never ran   -> infrastructure, not capability
 *   2. every grader check failed                   -> the approach is wrong
 *   3. SOME checks passed                          -> a half-solution; the failing
 *                                                     check names which half
 *   4. checks failed while the agent's OWN checks
 *      passed                                      -> its acceptance criterion
 *                                                     disagrees with the grader's
 *
 * Case 4 is the expensive one, because from inside the trial it is
 * indistinguishable from success — the agent tests what it believes and its
 * belief is what is wrong. It is exactly what `filter-js-from-html` had been
 * doing for 50 trials: a filter that changed zero bytes, passed the agent's own
 * no-op test, and failed the grader's, because "unchanged" meant something
 * different to each of them.
 *
 * This prints all four signals together so the case is obvious in one read.
 *
 * ⛔ SCOPE, AND WHY IT IS SAFE. It reads pass/fail STATUS and check NAMES from
 * `verifier/ctrf.json` — nothing else from `verifier/`. Surfacing which named
 * check failed is already sanctioned for the agent-facing feedback path (owner
 * decision 2026-08-09, recorded in `attempt-feedback-counts.test.sh`: the task
 * prompt already states the requirements, so naming which one held decomposes a
 * score the agent already receives). This tool is for a HUMAN triaging after
 * the fact and does not feed the agent at all, so it is strictly inside that
 * boundary. It never reads expected values, thresholds, or assertion bodies
 * (`rules/bench-agi-purity.md`).
 *
 * READ-ONLY. Opens files, writes nothing unless `--out` is given, contacts no
 * brain, records no outcome. Pointing it at a trial cannot alter a measurement.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { runWasSound } from './trial-outcome.mjs'
import { extractDeliverables, safeRelative } from './extract-deliverables.mjs'

/** The graded reward, or null when the trial produced none. */
/**
 * Did this trial give the agent a fair run? Read from `result.json` so a GRADED
 * non-run is caught: `readException` only sees `exception.txt`, and a trial can
 * be scored 0 with a perfectly ordinary check report while the agent never
 * produced a token.
 *
 * ⛔ THE CASE THIS FILE MISSED. classify() branches on `reward === null` for the
 * errored path, so a trial that WAS graded fell straight through to
 * 'all-checks-failed' and read as a capability result. Measured 2026-09-08: 40
 * such trials on disk — a 429 session limit and a 401 revoked OAuth token among
 * them — and one of them was two thirds of a 2% "regression" that did not exist.
 */
export function readRunSoundness(trialDir) {
  let result = null
  try {
    result = JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'))
  } catch {
    return { sound: true, why: null }
  }
  const reward = readReward(trialDir)
  if (runWasSound(result, reward)) return { sound: true, why: null }
  const out = result?.agent_result?.n_output_tokens
  return {
    sound: false,
    why: out === 0
      ? 'the agent produced ZERO output tokens — it never ran'
      : `the API cut the run off (${result?.exception_info?.exception_type})`,
  }
}

export function readReward(trialDir) {
  const p = join(trialDir, 'verifier', 'reward.txt')
  if (!existsSync(p)) return null
  const raw = readFileSync(p, 'utf8').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** `[{name, status}]` from the CTRF report, or `[]`. Status only — never bodies. */
export function readChecks(trialDir) {
  const p = join(trialDir, 'verifier', 'ctrf.json')
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const tests = j?.results?.tests
    if (!Array.isArray(tests)) return []
    return tests.map((t) => ({ name: String(t?.name ?? '?'), status: String(t?.status ?? '?') }))
  } catch {
    return []
  }
}

/**
 * The exception class a trial died of, or null when it produced a grade.
 *
 * The LAST matching line wins: a Python traceback ends with the exception that
 * actually propagated, and the earlier frames are the call path to it.
 */
export function readException(trialDir) {
  const p = join(trialDir, 'exception.txt')
  if (!existsSync(p)) return null
  let text = ''
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/([A-Za-z_][\w.]*(?:Error|Exception))\b/)
    if (m) {
      const exit = lines[i].match(/exit (\d+)/)
      return { kind: m[1], exit: exit ? Number(exit[1]) : null, line: lines[i].slice(0, 200) }
    }
  }
  return { kind: 'unknown', exit: null, line: (lines[0] ?? '').slice(0, 200) }
}

/**
 * ⛔ BRAIN CALL COUNTS ARE NOT DERIVABLE FROM A TRIAL DIRECTORY. Do not add it.
 *
 * The obvious move is to count `brain_*` in `agent/trajectory.json`. It does
 * not work, and it fails in BOTH directions:
 *
 *   * counting bare occurrences OVER-reports — checked on the 2026-09-01
 *     filter-js trial, all 19 `brain_search` and 12 `brain_verify_completion`
 *     hits are the INSTRUCTION text listing the tools, not calls. That is the
 *     "advertisement is not use" measurement (34 claimed vs 8 real) reproducing
 *     exactly;
 *   * counting structured invocations UNDER-reports — that trial really made 8
 *     forwarded calls and the trajectory contains zero `"type":"tool_use"`
 *     blocks and zero `"name":"mcp__terransoul__*"` fields, so a strict counter
 *     returns 0 for a trial that used the brain heavily.
 *
 * A first draft of this file printed that 0, which would have told the reader
 * "the brain was never called, fix that FIRST" about a trial where it was
 * called throughout — inventing an infrastructure bug on top of a real defect.
 *
 * run-dg.sh's own witness block gets this right by reading the HOST-SIDE PROXY
 * LOG, and explicitly labels the job-dir signal "mentions ... not a call
 * count". That log lives outside the trial directory, so this tool cannot see
 * it and says so instead of guessing.
 */
export const BRAIN_USAGE_SOURCE =
  'not derivable from a trial dir — use the run log\'s witness block or check-terransoul-used.sh'

/**
 * Split what the agent wrote into the deliverable and its own scratch checks.
 *
 * HEURISTIC, AND LABELLED AS ONE IN THE OUTPUT. It classifies by location:
 * scratch directories hold the agent's private rigs, and anything else is a
 * candidate deliverable. It cannot be exact — the goal names the real
 * deliverable and this tool deliberately does not parse the goal — but it does
 * not need to be: the point is to make "the agent validated itself" visible,
 * and a misfiled path still shows up in the listing above it.
 */
export function splitDeliverables(files) {
  const scratch = []
  const product = []
  for (const f of files) {
    if (/^\/(tmp|var\/tmp|root|home\/[^/]+)\//.test(f.path)) scratch.push(f)
    else product.push(f)
  }
  return { product, scratch }
}

/** The four cases, as a direction to look rather than a verdict. */
export function classify({ reward, checks, exception, soundness = null }) {
  // ⛔ BEFORE ANY OTHER READING. A trial the agent never ran, or that the API cut
  // off, is not a capability result in either direction — and unlike the errored
  // branch below it arrives here GRADED, so nothing else would catch it.
  if (soundness && soundness.sound === false && !(reward > 0)) {
    return {
      case: 'never-a-fair-test',
      headline: `NOT A CAPABILITY RESULT — ${soundness.why}.`,
      look:
        'Do not triage the approach and do not count this against the task. Re-run it. ' +
        'reference_run_that_never_happened_is_not_a_failure — and note it is graded, so ' +
        'a reward of 0 here looks exactly like a real failure until you read result.json.',
    }
  }
  if (reward === null) {
    const infra = exception?.exit === 137 || exception?.exit === 143
    return {
      case: 'errored',
      headline: `NO GRADE — the trial errored (${exception?.kind ?? 'unknown'}${exception?.exit !== null && exception?.exit !== undefined ? `, exit ${exception.exit}` : ''}).`,
      look: infra
        ? 'Exit 137 is SIGKILL (container OOM) and 143 is SIGTERM (timed out). If it died in the agent INSTALL the agent never ran, so this is infrastructure and not a capability result — see the stock-install retry in terransoul_hook.py.'
        : 'The agent may or may not have run. Read exception.txt before treating this as a task failure.',
    }
  }
  if (reward > 0) return { case: 'passed', headline: `PASSED (reward=${reward}).`, look: 'Nothing to triage.' }

  const passed = checks.filter((c) => c.status === 'passed')
  const failed = checks.filter((c) => c.status !== 'passed')

  if (!checks.length) {
    return {
      case: 'scored-zero-no-checks',
      headline: 'SCORED 0, and no per-check report was produced.',
      look: 'Without ctrf.json the score cannot be decomposed. Check the verifier ran at all.',
    }
  }
  if (!passed.length) {
    return {
      case: 'all-checks-failed',
      headline: `SCORED 0 — all ${failed.length} check(s) failed.`,
      look: 'Nothing landed. Look at the approach, not at a detail. Confirm the brain was actually called (see the witness block in the run log) before reading this as a capability result.',
    }
  }
  return {
    case: 'partial',
    headline: `SCORED 0 — but ${passed.length} of ${checks.length} check(s) PASSED.`,
    look:
      `This is a half-solution, and the failing check names the half: ${failed.map((c) => c.name).join(', ')}. ` +
      'If the agent ran its own checks and they passed (see below), its acceptance criterion disagrees with the ' +
      "grader's — settle what the requirement is actually compared against before changing the implementation.",
  }
}

function main() {
  const args = process.argv.slice(2)
  const trialDir = args.find((a) => !a.startsWith('--'))
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null
  if (!trialDir) {
    console.error('usage: triage-trial.mjs <trial-dir> [--out <dir>]')
    process.exit(2)
  }
  if (!existsSync(trialDir)) {
    console.error(`[triage] no such trial dir: ${trialDir}`)
    process.exit(1)
  }

  const reward = readReward(trialDir)
  const checks = readChecks(trialDir)
  const exception = readException(trialDir)

  let files = []
  const traj = join(trialDir, 'agent', 'trajectory.json')
  if (existsSync(traj)) {
    try {
      files = extractDeliverables(JSON.parse(readFileSync(traj, 'utf8')))
    } catch {
      files = []
    }
  }
  const { product, scratch } = splitDeliverables(files)
  const verdict = classify({ reward, checks, exception, soundness: readRunSoundness(trialDir) })

  console.log(`\n  ${verdict.headline}`)
  console.log(`  -> ${verdict.look}\n`)

  if (checks.length) {
    console.log('  grader checks')
    for (const c of checks) console.log(`    ${c.status === 'passed' ? 'PASS' : 'FAIL'}  ${c.name}`)
    console.log('')
  }

  console.log(`  brain usage: ${BRAIN_USAGE_SOURCE}
`)

  // ⛔ A RECONSTRUCTION ITS OWN PRODUCER CALLS INCOMPLETE MUST NOT BE PRINTED AS
  // THE GRADED FILE. `extractDeliverables` replays the metadata history and
  // flags any path the shell patched in a window it cannot reconstruct
  // (`fidelity:'incomplete'`). Printing those bytes as "deliverables the agent
  // wrote" is the confident-wrong-file defect one level up: six of seven scripted
  // trials were recovered as the wrong bytes before the replay landed, and one
  // stale recovery flipped a PASS to a FAIL. The flag travels with the line.
  const fidelityNote = (f) =>
    f.fidelity === 'incomplete'
      ? `   ⚠ INCOMPLETE — NOT the bytes the grader judged (${f.nomatch ?? 0} unmatched edit(s), ${f.lateWrites ?? 0} unreconstructable shell write(s))`
      : ''
  if (product.length) {
    console.log('  deliverables the agent wrote')
    for (const f of product) console.log(`    ${String(f.content.length).padStart(7)} bytes  ${f.path}${fidelityNote(f)}`)
  }
  if (scratch.length) {
    console.log('  checks the agent wrote for ITSELF (heuristic: scratch locations)')
    for (const f of scratch) console.log(`    ${String(f.content.length).padStart(7)} bytes  ${f.path}${fidelityNote(f)}`)
    if (verdict.case === 'partial' || verdict.case === 'all-checks-failed') {
      console.log('    ^ these passed while the grader failed: the acceptance criterion is the suspect,')
      console.log('      not the implementation. Reproduce the GRADER\'s comparison before editing code.')
    }
  }
  if (!files.length) console.log('  (no files recovered from the trajectory)')

  if (outDir) {
    for (const f of files) {
      const dest = join(outDir, safeRelative(f.path))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, f.content)
    }
    console.log(`\n  wrote ${files.length} recovered file(s) to ${outDir}`)
    const suspect = files.filter((f) => f.fidelity === 'incomplete')
    if (suspect.length) {
      console.log(
        `  ⚠ ${suspect.length} of them are INCOMPLETE reconstructions (${suspect
          .map((f) => f.path)
          .join(', ')}) — do NOT diff these against the grader's expectation as if they were final.`,
      )
    }
  }
  console.log('')
}

if (process.argv[1]?.endsWith('triage-trial.mjs')) main()
