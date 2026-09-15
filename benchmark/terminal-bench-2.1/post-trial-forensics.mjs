#!/usr/bin/env node
/**
 * `post-trial-forensics.mjs` — freeze ONE finished trial into a record that can
 * be read beside every other finished trial.
 *
 *   usage: node post-trial-forensics.mjs <trial-dir> [--base <jobs-root>] [--json]
 *
 * ⛔ THE GAP THIS CLOSES: THE EVIDENCE IS SPREAD ACROSS SEVEN FILES AND TWO
 * DIRECTORIES, AND NOBODY EVER READS TWO FAILURES SIDE BY SIDE.
 *
 * `triage-trial.mjs` answers "where do I look?" for one trial, out loud, in
 * prose, once — and then the answer is gone, because nothing writes it down.
 * Every diagnosis in this campaign has therefore started by re-deriving the
 * same facts by hand: the reward from `verifier/reward.txt`, which check failed
 * from `verifier/ctrf.json`, whether the run was even sound from
 * `result.json`, what the agent wrote from `agent/trajectory.json`, what the
 * brain served it from the job's proxy log, what the Stop hook blocked from the
 * session jsonl, and what the agent CLAIMED from its last assistant turn.
 *
 * Seven readers already exist for those files. What did not exist was a step
 * that runs them all at the moment the trial finishes and keeps the answer.
 *
 * ⛔ AND THE PRECISION IS THE POINT. The 2026-09-13 failure this was built on
 * turned on the string `0.485378353934278` against a floor of `0.5` — a
 * difference of 0.0146, which `toFixed(2)` renders as "0.49 vs 0.50" and a
 * `Number()` round-trip through a report can silently shorten. Every value this
 * records is the SUBSTRING THE GRADER PRINTED, never a number re-rendered from
 * a parse (`reference_reported_value_that_is_really_a_choice`).
 *
 * ⛔ AND THE ORDINAL SEMANTICS ARE RECORDED, NOT ASSUMED. That same assertion
 * sits inside a `zip(...)` over rows, so the printed value is the FIRST row
 * that failed, not the aggregate — and `sam` had already burned a redo cycle on
 * a reader who took it for a mean. A record that prints the number without
 * saying which of the two it is invites exactly that reading, so the field is
 * mandatory and its third state is honestly `'unknown'`.
 *
 * ⛔ READ-ONLY, OFFLINE, AND IT CANNOT FAIL A RUN. It opens files under the
 * trial and its job, and writes exactly three things: `forensics.json` and
 * `forensics.md` INSIDE the trial directory, and one appended line in the jobs
 * root's `forensics-index.jsonl`. It never touches `verifier/` or `agent/`,
 * never opens a socket, never calls the brain, and reports its own failures
 * inside the record's `errors` array rather than by exiting non-zero — a
 * bookkeeping step must never be able to change a measured result.
 *
 * ⛔ PURITY, AND WHERE THE BOUNDARY ACTUALLY IS. This reads assertion VALUES out
 * of `verifier/ctrf.json`, which `triage-trial.mjs` deliberately does not. That
 * is safe here and would not be there, for one reason: this output is
 * HOST-SIDE and OPERATOR-FACING. A trial directory is written after its
 * container is destroyed and no later container ever mounts one, so nothing
 * here can reach an agent. Nothing in this file may ever be piped into the
 * instruction file, the Stop-hook feedback, or a brain write
 * (`rules/bench-agi-purity.md`, and the self-seeding incident recorded in
 * `project_tbench_agent_self_seeded_answer_key`).
 *
 * Its own RULES stay generic regardless: every suspect rule is a shape
 * ("a number the agent published that the grader never printed"), never a task,
 * never a mechanism, never a threshold. Benchmark task identifiers are redacted
 * out of every suspect before the record is written, so a rule can never carry
 * one even when a container path happened to embed it.
 */
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { runWasSound, isCleanPass } from './trial-outcome.mjs'
import {
  extractDeliverables,
  bashCommandsIn,
  bashWritesTo,
  parseMetadataBlocks,
} from './extract-deliverables.mjs'
import { readReward, readChecks, readException, splitDeliverables } from './triage-trial.mjs'
import { readMemoryIds, exposedWhileRefutedIds } from './credit-trial-outcome.mjs'
import { jobsWithTask } from './refutation-watch.mjs'
import { isStopBlockTurn, blockKind, turnText, readTranscript } from './stop-gate-audit.mjs'

/** Bumped whenever a field changes meaning — the index is append-only forever. */
export const FORENSICS_SCHEMA = 1

/** The head of a block message kept in the record. Asserted by the suite. */
export const BLOCK_HEAD_CHARS = 200

export const INDEX_FILE = 'forensics-index.jsonl'

/**
 * How many printed values one failed check contributes.
 *
 * ⛔ THE COUNT IS CAPPED; THE PRECISION NEVER IS. MEASURED on the first real
 * sweep this ran over: one trial's assertion trace printed a rejected list and
 * yielded 400+ integers, which went into the record, into the append-only index
 * and into a table cell — one check owning a whole artifact and burying the
 * value the operator opened it for. Truncating the LIST is a display decision;
 * truncating a VALUE would be falsifying evidence, and the two must never be
 * confused. `values_truncated` says how many were dropped, so the cap can never
 * read as "that is all the grader printed".
 */
export const MAX_CHECK_VALUES = 8

/** Bound on the number lists a claim carries, for the same reason. */
export const MAX_CLAIM_NUMBERS = 40

/**
 * Numeric literals, as they were PRINTED.
 *
 * ⛔ NEVER `Number()` AND NEVER `toFixed()`. `0.10000000000000000555` parses to
 * a double that renders as `0.1`, and a report that round-trips a grader's
 * value has changed the evidence. Everything this module calls a "value" is a
 * substring of the artifact it came from.
 */
const NUMERIC = /-?(?:\d+\.\d+(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?)/g

/** Loop constructs that make a printed assertion value the FIRST failing row. */
const LOOP_SHAPES = /\b(?:for|while)\b|\bzip\s*\(|\benumerate\s*\(|\.iterrows\s*\(|\.items\s*\(\)/

/**
 * Deep-walk any value, yielding every string.
 *
 * The twin of `extract-deliverables.mjs`'s private walker, and it has to be:
 * the metadata markers this module needs to TIME live inside nested tool-result
 * strings, and a `JSON.stringify` of the step would put the marker behind an
 * escaped newline where `parseMetadataBlocks` cannot see it.
 */
function* strings(value) {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) yield* strings(v)
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Numeric substrings of `text`, in order, deduplicated, never re-rendered. */
export function numericLiterals(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text ?? '').matchAll(NUMERIC)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    out.push(m[0])
  }
  return out
}

/**
 * The pytest failure lines of one CTRF test — the `>` source line and the `E`
 * lines pytest writes under it, which is where the concrete values live.
 */
function traceParts(trace) {
  const lines = String(trace ?? '').split(/\r?\n/)
  const markerIdx = lines.findIndex((l) => /^\s*(?:>|E\s)/.test(l))
  const before = markerIdx < 0 ? lines : lines.slice(0, markerIdx)
  const eLines = lines.filter((l) => /^\s*E\s/.test(l)).map((l) => l.replace(/^\s*E\s?/, '').trim())
  const srcLine = markerIdx >= 0 ? lines[markerIdx].replace(/^\s*>\s?/, '').trim() : ''
  return { before: before.join('\n'), eLines, srcLine }
}

/**
 * What one failed check actually said.
 *
 * `values` are every numeric literal the grader PRINTED in its own failure
 * lines, in the order printed — the observed one first, then whatever it was
 * compared against, because that is the order pytest writes them.
 *
 * `ordinal_semantics` answers the question a bare number cannot: is this the
 * first row that failed, or a figure computed over all of them? A loop, a
 * `zip`, an `enumerate` or a row iterator standing between the function head
 * and the assertion means the former. No trace at all means `'unknown'`, which
 * is the honest third state — asserting `'aggregate'` by default would put a
 * confident wrong label on every check whose trace the harness did not capture.
 */
export function describeCheck(check) {
  const trace = check?.trace ?? ''
  const { before, eLines, srcLine } = traceParts(trace)
  const values = numericLiterals(eLines.join('\n'))
  const assertion =
    eLines.filter((l) => /\bassert\b/.test(l)).pop() ??
    (srcLine || String(check?.message ?? '').trim())
  let ordinal = 'unknown'
  if (trace.trim()) ordinal = LOOP_SHAPES.test(before) ? 'first-failing' : 'aggregate'
  return {
    name: String(check?.name ?? '?'),
    values: values.slice(0, MAX_CHECK_VALUES),
    values_truncated: Math.max(0, values.length - MAX_CHECK_VALUES),
    assertion: String(assertion ?? '').slice(0, 400),
    ordinal_semantics: ordinal,
  }
}

/** `{total, passed, failed:[…]}` for one trial, status from CTRF, values from its trace. */
export function checksFor(trialDir) {
  const ctrf = readJson(join(trialDir, 'verifier', 'ctrf.json'))
  const tests = Array.isArray(ctrf?.results?.tests) ? ctrf.results.tests : []
  if (!tests.length) {
    // Status-only fallback: `readChecks` tolerates shapes this one cannot, and
    // a trial with names but no traces must still report its counts.
    const names = readChecks(trialDir)
    const failed = names.filter((c) => c.status !== 'passed')
    return {
      total: names.length,
      passed: names.length - failed.length,
      failed: failed.map((c) => ({
        name: c.name,
        values: [],
        values_truncated: 0,
        assertion: '',
        ordinal_semantics: 'unknown',
      })),
    }
  }
  const failed = tests.filter((t) => String(t?.status ?? '') !== 'passed')
  return {
    total: tests.length,
    passed: tests.length - failed.length,
    failed: failed.map(describeCheck),
  }
}

/**
 * FIRST and LAST trajectory step that touched each path.
 *
 * Built from the same two primitives `extractDeliverables` uses — the metadata
 * blocks for tool writes, `bashWritesTo` for shell writes — rather than from a
 * second notion of "a write", so the timing here and the bytes there can never
 * disagree about whether a file was touched. `extractDeliverables` keeps only
 * the LAST step per record, which cannot order two files against each other.
 */
export function writeTimeline(trajectory) {
  const spans = new Map()
  const mark = (path, step) => {
    const cur = spans.get(path)
    if (!cur) spans.set(path, { first: step, last: step })
    else cur.last = Math.max(cur.last, step)
  }
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : []
  steps.forEach((step, index) => {
    const stepId = typeof step?.step_id === 'number' ? step.step_id : index + 1
    for (const s of strings(step)) {
      if (!s.includes('[metadata] ')) continue
      for (const meta of parseMetadataBlocks(s)) {
        const path = meta?.filePath
        if (typeof path === 'string' && path) mark(path, stepId)
      }
    }
    for (const { command, cwd } of bashCommandsIn(step)) {
      for (const path of spans.keys()) if (bashWritesTo(command, path, cwd)) mark(path, stepId)
    }
  })
  return spans
}

/** Every recovered file the agent wrote, split into product and scratch. */
function deliverablesFor(trialDir, errors) {
  const trajPath = join(trialDir, 'agent', 'trajectory.json')
  if (!existsSync(trajPath)) return { files: [], product: [], scratch: [], trajectory: null }
  const trajectory = readJson(trajPath)
  if (!trajectory) {
    errors.push('agent/trajectory.json is present but unparsable')
    return { files: [], product: [], scratch: [], trajectory: null }
  }
  let files = []
  try {
    files = extractDeliverables(trajectory)
  } catch (e) {
    errors.push(`deliverable reconstruction failed: ${e?.message ?? e}`)
  }
  const { product, scratch } = splitDeliverables(files)
  return { files, product, scratch, trajectory }
}

/**
 * The task's most recent CLEAN PASS, across every `jobs*` root on this machine.
 *
 * ⛔ "MOST RECENT TRIAL" IS THE WRONG BASELINE AND IT IS THE EASY ONE TO WRITE.
 * A redo campaign runs the same task repeatedly, so the newest trial is usually
 * the previous FAILURE — and diffing today's failure against yesterday's
 * failure reports "no change" about two runs that both lost. The comparison a
 * regression question needs is against the last run that actually WORKED, and a
 * stale `reward.txt` over a container that never started already produced one
 * phantom pass in this corpus.
 *
 * ⛔ "WORKED" IS THE CAMPAIGN'S DEFINITION (`isCleanPass`), NOT `runWasSound`.
 * `runWasSound` answers "was this a fair test", and it short-circuits to true on
 * `reward > 0` whatever the exception says. A trial with reward 1 that ended in
 * AgentTimeoutError is therefore "sound" — and `outcomeOf` scores it 0. Picked
 * as a baseline, it made `regressed_vs_baseline` accuse a failure of regressing
 * against another failure (measured: a real task's baseline had reward 1 plus
 * AgentTimeoutError). `isCleanPass` reads the graded reward AND the exception,
 * and it rejects the phantom pass above too (no verifier result -> ungraded).
 */
export function findBaseline(baselineBase, task, selfTrialName) {
  let jobs
  try {
    jobs = jobsWithTask(baselineBase, task)
  } catch {
    // No readable corpus on this machine is not an error: the record simply
    // carries no baseline, which `null` already says.
    return null
  }
  let best = null
  for (const job of jobs) {
    for (const name of job.trials) {
      if (name === selfTrialName) continue
      const dir = join(job.jobDir, name)
      const result = readJson(join(dir, 'result.json'))
      const reward = readReward(dir)
      if (!(typeof reward === 'number' && reward > 0)) continue
      // The campaign's pass, not merely a fair run: see the docstring above.
      if (!isCleanPass(result)) continue
      const at = Date.parse(result?.started_at ?? '') || 0
      if (!best || at > best.at) best = { at, dir, name, reward }
    }
  }
  return best
}

/**
 * A LINE-MULTISET delta between two sets of recovered files.
 *
 * Deliberately NOT an LCS diff and named so in the record's own prose: the
 * inputs are RECONSTRUCTIONS, one of which may be flagged incomplete, and
 * spending an LCS on bytes whose producer will not vouch for them would dress
 * a guess as a measurement. Counting lines present on one side and not the
 * other answers the only question asked of it — how far apart are these two
 * attempts — and cannot be misread as `git diff` output.
 */
export function diffstat(baseFiles, newFiles) {
  const byPath = (files) => new Map(files.map((f) => [f.path, String(f.content ?? '')]))
  const a = byPath(baseFiles)
  const b = byPath(newFiles)
  let added = 0
  let removed = 0
  let changed = 0
  const counts = (text) => {
    const m = new Map()
    const lines = text.split('\n')
    // A file ending in a newline splits to a trailing empty element that is not
    // a line. Counting it makes a one-line file read as two and silently
    // cancels one line of the delta against any other file that also ends in a
    // newline — which is every file — so the number would be right by accident
    // on the common case and wrong on the empty one.
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) m.set(line, (m.get(line) ?? 0) + 1)
    return m
  }
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const ca = counts(a.get(path) ?? '')
    const cb = counts(b.get(path) ?? '')
    let plus = 0
    let minus = 0
    for (const [line, n] of cb) plus += Math.max(0, n - (ca.get(line) ?? 0))
    for (const [line, n] of ca) minus += Math.max(0, n - (cb.get(line) ?? 0))
    if (!a.has(path)) minus = 0
    if (!b.has(path)) plus = 0
    added += plus
    removed += minus
    if (plus || minus) changed += 1
  }
  return { added, removed, changed_files: changed }
}

/** Every id under `keys`, from the mixed-shape proxy log. */
function idsForKeys(logText, keys) {
  const ids = new Set()
  for (const line of String(logText || '').split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let obj
    try {
      obj = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    for (const key of keys) {
      if (!Array.isArray(obj?.[key])) continue
      for (const id of obj[key]) if (Number.isInteger(id)) ids.add(id)
    }
    // A row that flags the read as refuted contributes its ids to the refuted
    // set whichever key carried them — the proxy writes `read_refuted` today,
    // and a row shaped `{read:[…], refuted_at_read:true}` must not slip past a
    // reader that only knows the current spelling.
    if (keys.includes('__refuted__') && obj?.refuted_at_read === true) {
      for (const key of ['read', 'read_refuted']) {
        if (!Array.isArray(obj?.[key])) continue
        for (const id of obj[key]) if (Number.isInteger(id)) ids.add(id)
      }
    }
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * What the brain served this trial, and what may be credited for its outcome.
 *
 * ⛔ `credited` EXCLUDES EVERY ID THE BRAIN SERVED WHILE REFUTED. A refuted
 * entry reaches the agent under a banner telling it not to follow the body, so
 * the fact that it was on screen says nothing about whether it helped or hurt
 * — crediting it either way is the laundering defect
 * (`project_tbench_observe_outcome_launders_self_reported_success`). This
 * mirrors `credit-trial-outcome.mjs`'s `USED_KEYS` minus `EXPOSED_KEYS` so a
 * reader of this record and the script that actually writes to the brain cannot
 * disagree about who gets the blame.
 */
export function memoryFor(logText) {
  const served = idsForKeys(logText, ['served'])
  const read = readMemoryIds(logText)
  const authored = idsForKeys(logText, ['authored'])
  const refuted = [...new Set([...exposedWhileRefutedIds(logText), ...idsForKeys(logText, ['__refuted__'])])].sort(
    (a, b) => a - b,
  )
  const refutedSet = new Set(refuted)
  const credited = [...new Set([...read, ...authored])].filter((id) => !refutedSet.has(id)).sort((a, b) => a - b)
  return { served, read, refuted_at_read: refuted, authored, credited }
}

/** The session transcript this trial produced, or `[]`. */
function sessionEvents(trialDir) {
  const dir = join(trialDir, 'agent', 'sessions', 'projects', '-app')
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    try {
      out.push(...readTranscript(join(dir, name)))
    } catch {
      // A truncated transcript is normal for a killed trial.
    }
  }
  return out
}

/**
 * Every Stop-hook block, with its kind, its timestamp and a bounded head.
 *
 * The detection is `stop-gate-audit.mjs`'s, imported rather than re-spelled:
 * that file reads the marker constants straight out of the shipped hook, so a
 * renamed prefix breaks loudly there instead of silently reading zero here.
 *
 * `head` is truncated because a block message is a paragraph and a hundred of
 * them would make the record unreadable — but it is truncated to a CONSTANT
 * that the suite asserts, so a widened head can never quietly become the whole
 * message in an index that is appended to forever.
 */
export function blocksFrom(events, transcriptText = '') {
  const out = []
  for (const e of events ?? []) {
    if (!isStopBlockTurn(e)) continue
    out.push({
      kind: blockKind(e),
      at: typeof e?.timestamp === 'string' ? e.timestamp : null,
      head: turnText(e).trim().slice(0, BLOCK_HEAD_CHARS),
    })
  }
  if (out.length || !transcriptText) return out
  // Fallback for a trial whose session jsonl did not survive: the flat
  // transcript holds the same injected text, without turn structure.
  const marker = 'Stop hook feedback:'
  let i = transcriptText.indexOf(marker)
  while (i >= 0) {
    const chunk = transcriptText.slice(i, i + 4000)
    out.push({
      kind: blockKind({ type: 'user', message: { content: chunk } }),
      at: null,
      head: chunk.trim().slice(0, BLOCK_HEAD_CHARS),
    })
    i = transcriptText.indexOf(marker, i + marker.length)
  }
  return out
}

/** The agent's last non-empty assistant turn — what it finally CLAIMED. */
export function finalAssistantText(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type !== 'assistant') continue
    const t = turnText(e).trim()
    if (t) return t
  }
  return ''
}

/**
 * The agent's published numbers against the grader's.
 *
 * ⛔ ONLY DECIMALS COUNT AS A CLAIM. A final message is full of bare integers —
 * row counts, seeds, table indices — and treating those as measurements makes
 * `unmatched_numbers` a list of noise that nobody reads, which is the same as
 * not having the field. A decimal is a measured quantity, and a measured
 * quantity the grader never printed is the shape worth surfacing.
 */
export function claimsFrom(finalText, graderText) {
  const numbers = numericLiterals(finalText)
  const graderNumbers = numericLiterals(graderText)
  const graderSet = new Set(graderNumbers)
  const files = [...new Set(String(finalText ?? '').match(/(?:\/[A-Za-z0-9_.+-]+){2,}/g) ?? [])]
  // ⛔ MATCHED AGAINST THE FULL GRADER SET, THEN TRUNCATED. Capping
  // `grader_numbers` first and comparing against the cap would report a number
  // the grader DID print as unmatched — the field would then be manufacturing
  // its own findings, which is the exact defect recorded in
  // `project_judge_truncation_manufactured_a_finding`.
  const unmatched = numbers.filter((n) => n.includes('.') && !graderSet.has(n))
  return {
    numbers: numbers.slice(0, MAX_CLAIM_NUMBERS),
    files: files.slice(0, MAX_CLAIM_NUMBERS),
    unmatched_numbers: unmatched.slice(0, MAX_CLAIM_NUMBERS),
    unmatched_total: unmatched.length,
    grader_numbers: graderNumbers.slice(0, MAX_CLAIM_NUMBERS),
    grader_numbers_total: graderNumbers.length,
  }
}

/**
 * `ident = 3.14159` / `ident: 3.14159` — a constant bound to a name, as printed.
 *
 * ⛔ TRIVIAL LITERALS ARE NOT CONSTANTS FOR THIS PURPOSE, AND INCLUDING THEM
 * DESTROYS THE RULE. Measured on the first real trial this ran against:
 * `mean = 0.0`, `std = 1.0`, `drop_prob = 0.0` and `keep_prob = 1.0` all
 * "reappeared in a fixture", because `0.0` and `1.0` appear in every numeric
 * file ever written. Four suspects, zero signal, and a reader who learns to
 * skip the rule stops reading the one instance that matters.
 *
 * A constant that was FITTED carries precision — that is what fitting means —
 * so the bar is three or more SIGNIFICANT fractional digits. Trailing zeros are
 * not precision: `0.500` is the same round number as `0.5` written longer, and
 * counting its width rather than its significance lets every rounded threshold
 * back in through the side the filter was supposed to close. Generic, stated as
 * a property of the literal, and true of no particular task.
 */
export function assignedConstants(text) {
  const out = []
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(-?\d+\.\d+(?:[eE][-+]?\d+)?)/g
  for (const m of String(text ?? '').matchAll(re)) {
    const fraction = (m[2].split('.')[1] ?? '').replace(/[eE].*$/, '').replace(/0+$/, '')
    if (fraction.length < 3) continue
    out.push({ name: m[1], literal: m[2] })
  }
  return out
}

/**
 * Benchmark task identifiers, removed.
 *
 * A suspect is a RULE, and a rule that names a task is a per-task heuristic no
 * matter how it was derived (`rules/bench-agi-purity.md`). Container paths and
 * check names are agent-written strings, so one CAN carry the identifier; this
 * is what makes that structurally impossible rather than merely unlikely.
 */
export function redactTaskNames(text, names) {
  let out = String(text ?? '')
  for (const name of [...(names ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(name).join('<task>')
  }
  return out
}

/**
 * GENERIC suspect rules. Every one is a SHAPE of failure, evaluated from fields
 * the record already holds — no task, no mechanism, no threshold, nothing that
 * would have to be rewritten for the next benchmark.
 */
export function suspectsFor(ctx) {
  const s = []
  const add = (rule, evidence) => s.push({ rule, evidence })

  if (ctx.isVoid) {
    add('void_run', `the run was not a fair test (${ctx.voidWhy ?? 'no usable agent result'})`)
  }
  if (ctx.reward === 0 && ctx.checks.passed > 0 && ctx.checks.failed.length) {
    add(
      'partial_pass',
      `${ctx.checks.passed} of ${ctx.checks.total} checks passed; the failing half is ${ctx.checks.failed
        .map((c) => c.name)
        .join(', ')}`,
    )
  }
  if (ctx.reward === 0 && ctx.scratch.length && ctx.checks.failed.length) {
    add(
      'self_check_passed_grader_failed',
      `the agent wrote ${ctx.scratch.length} check file(s) of its own and the grader still failed ${ctx.checks.failed.length}`,
    )
  }
  if (ctx.reward === 0 && ctx.claims.unmatched_numbers.length) {
    add(
      'self_graded_number_absent_from_grader',
      `the final message publishes ${ctx.claims.unmatched_total} decimal(s) the grader never printed: ${ctx.claims.unmatched_numbers
        .slice(0, 6)
        .join(', ')}`,
    )
  }
  for (const hit of ctx.fittedConstants) {
    add(
      'constant_fitted_to_self_built_fixture',
      `${hit.name} = ${hit.literal} in ${hit.deliverable} also appears in ${hit.fixture}, which was written afterwards`,
    )
  }
  if (ctx.unchangedSinceBlock) {
    add(
      'deliverable_unchanged_since_last_block',
      `after the final ${ctx.unchangedSinceBlock} block the agent made no tool call naming a deliverable`,
    )
  }
  if (ctx.memory.refuted_at_read.length) {
    add(
      'used_memory_refuted_at_read',
      `${ctx.memory.refuted_at_read.length} memor(y/ies) were served under a refutation banner: ${ctx.memory.refuted_at_read.join(', ')}`,
    )
  }
  if (ctx.baseline && ctx.reward === 0) {
    // The baseline's IDENTITY is in `baseline.trial`, one field away, and is
    // deliberately not repeated here: a trial name begins with its task's name,
    // so quoting it would put a benchmark identifier inside a rule's evidence
    // and the redactor would then render it as an unreadable `<task>__xxxx`.
    add('regressed_vs_baseline', 'a CLEAN pass of this task exists on disk (see baseline.trial) and this trial scored 0')
  }
  if (ctx.incomplete.length) {
    add(
      'reconstruction_incomplete',
      `${ctx.incomplete.length} recovered file(s) are NOT the bytes the grader judged`,
    )
  }
  return s.map((x) => ({
    rule: redactTaskNames(x.rule, ctx.taskNames),
    evidence: redactTaskNames(x.evidence, ctx.taskNames),
  }))
}

/**
 * Did the agent touch a deliverable after the last Stop-hook block?
 *
 * Returns the block's kind when it did NOT, and null when it did, when there
 * was no block, or when the transcript is missing — three different "no" cases
 * that must all stay quiet rather than firing a suspect on absent evidence.
 */
function unchangedSinceLastBlock(events, productPaths) {
  if (!events?.length || !productPaths.length) return null
  let last = -1
  for (let i = 0; i < events.length; i++) if (isStopBlockTurn(events[i])) last = i
  if (last < 0) return null
  for (const e of events.slice(last + 1)) {
    if (e?.type !== 'assistant') continue
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use') continue
      const text = JSON.stringify(b?.input ?? null) ?? ''
      if (productPaths.some((p) => text.includes(p))) return null
    }
  }
  return blockKind(events[last])
}

/** Deliverable constants that reappear in a scratch file written LATER. */
function fittedConstants(product, scratch, spans) {
  const hits = []
  for (const p of product) {
    const pFirst = spans.get(p.path)?.first ?? 0
    for (const c of assignedConstants(p.content)) {
      for (const sFile of scratch) {
        const sFirst = spans.get(sFile.path)?.first ?? 0
        if (sFirst <= pFirst) continue
        if (!String(sFile.content ?? '').includes(c.literal)) continue
        hits.push({ ...c, deliverable: p.path, fixture: sFile.path })
        break
      }
    }
  }
  return hits
}

/**
 * The whole record for one finished trial.
 *
 * @param {string} trialDir
 * @param {{base?: string, baselineBase?: string, write?: boolean, index?: boolean,
 *          taskNames?: string[]}} [opts]
 *
 * `base` is the JOBS ROOT the index lives in (`…/jobs`), which defaults to this
 * trial's own job's parent. `baselineBase` is the directory that CONTAINS the
 * jobs roots, because the baseline search spans `jobs` and every `jobs-*`
 * sibling — two different directories on purpose, and conflating them is how a
 * baseline search silently returns nothing.
 */
export function forensicsForTrial(trialDir, opts = {}) {
  const errors = []
  const dir = String(trialDir).replace(/[/\\]+$/, '')
  const jobDir = dirname(dir)
  const base = opts.base ?? dirname(jobDir)
  const baselineBase = opts.baselineBase ?? dirname(base)
  const trialName = basename(dir)

  const result = readJson(join(dir, 'result.json'))
  const jobResult = readJson(join(jobDir, 'result.json'))
  const reward = readReward(dir)
  const sound = runWasSound(result, reward)
  const outTokens = result?.agent_result?.n_output_tokens ?? jobResult?.stats?.n_output_tokens ?? null

  // ⛔ `void` IS STRICTER THAN `sound`, AND THE TWO FIELDS BOTH SHIP.
  // `runWasSound` short-circuits on `reward > 0` because the campaign rule it
  // serves must never drop a genuine pass. A FORENSIC record asks a different
  // question — was there anything here to diagnose — and a trial that emitted
  // zero output tokens has nothing to diagnose no matter what `reward.txt`
  // says. That exact contradiction has already occurred once in this corpus
  // (a stale reward over a container that never started), so the record keeps
  // both readings side by side rather than picking one and hiding the other.
  const zeroTokens = outTokens === 0
  const isVoid = !sound || zeroTokens
  const voidWhy = zeroTokens
    ? 'the agent produced ZERO output tokens'
    : !sound
      ? `the run was unsound (${result?.exception_info?.exception_type ?? 'no agent result'})`
      : null

  const rawTask = String(result?.task_name ?? '').split('/').pop() || trialName.split('__')[0]
  const task = rawTask
  const checks = checksFor(dir)
  const { product, scratch, trajectory } = deliverablesFor(dir, errors)

  const logText = readText(join(jobDir, 'terransoul-proxy-calls.jsonl'))
  const memory = memoryFor(logText)

  const events = sessionEvents(dir)
  const transcript = readText(join(dir, 'agent', 'claude-code.txt'))
  const blocks = blocksFrom(events, transcript)
  const finalText = finalAssistantText(events)

  const graderText = [
    readText(join(dir, 'verifier', 'test-stdout.txt')),
    checks.failed.map((c) => `${c.assertion} ${c.values.join(' ')}`).join('\n'),
  ].join('\n')
  const claims = claimsFrom(finalText, graderText)

  let baseline = null
  try {
    const found = findBaseline(baselineBase, task, trialName)
    if (found) {
      const baseFiles = deliverablesFor(found.dir, []).product
      baseline = {
        trial: found.name,
        reward: found.reward,
        diffstat: diffstat(baseFiles, product),
      }
    }
  } catch (e) {
    errors.push(`baseline search failed: ${e?.message ?? e}`)
  }

  const spans = trajectory ? writeTimeline(trajectory) : new Map()
  const suspects = suspectsFor({
    reward,
    isVoid,
    voidWhy,
    checks,
    scratch,
    claims,
    memory,
    baseline: baseline ? { name: baseline.trial } : null,
    incomplete: [...product, ...scratch].filter((f) => f.fidelity === 'incomplete'),
    fittedConstants: fittedConstants(product, scratch, spans),
    unchangedSinceBlock: unchangedSinceLastBlock(events, product.map((f) => f.path)),
    taskNames: [task, ...(opts.taskNames ?? [])],
  })

  const record = {
    schema: FORENSICS_SCHEMA,
    trial: trialName,
    task,
    job: basename(jobDir),
    started_at: result?.started_at ?? jobResult?.started_at ?? null,
    finished_at: result?.finished_at ?? jobResult?.finished_at ?? null,
    reward,
    sound,
    void: isVoid,
    exception: result?.exception_info?.exception_type ?? readException(dir)?.kind ?? null,
    tokens: {
      input: result?.agent_result?.n_input_tokens ?? jobResult?.stats?.n_input_tokens ?? null,
      output: outTokens,
      cost_usd: result?.agent_result?.cost_usd ?? jobResult?.stats?.cost_usd ?? null,
    },
    checks,
    deliverables: product.map((f) => ({
      path: f.path,
      bytes: String(f.content ?? '').length,
      sha256: sha256(f.content),
      fidelity: f.fidelity ?? 'unknown',
    })),
    baseline,
    memory,
    blocks,
    claims,
    suspects,
    errors,
  }

  if (opts.write !== false) {
    try {
      writeFileSync(join(dir, 'forensics.json'), `${JSON.stringify(record, null, 2)}\n`)
      writeFileSync(join(dir, 'forensics.md'), renderMarkdown(record))
    } catch (e) {
      record.errors.push(`could not write the trial's forensics files: ${e?.message ?? e}`)
    }
  }
  if (opts.index !== false) {
    try {
      appendIndex(base, record)
    } catch (e) {
      record.errors.push(`could not append the forensics index: ${e?.message ?? e}`)
    }
  }
  return record
}

/** The one line this record contributes to the jobs root's append-only index. */
export function indexLine(record) {
  return {
    schema: FORENSICS_SCHEMA,
    at: new Date().toISOString(),
    started_at: record.started_at,
    task: record.task,
    trial: record.trial,
    job: record.job,
    reward: record.reward,
    sound: record.sound,
    void: record.void,
    failed: record.checks.failed.map((c) => ({
      name: c.name,
      values: c.values,
      values_truncated: c.values_truncated ?? 0,
    })),
    suspects: record.suspects.map((s) => s.rule),
    blocks: record.blocks.length,
    tokens: record.tokens,
    baseline: record.baseline
      ? { trial: record.baseline.trial, diffstat: record.baseline.diffstat }
      : null,
  }
}

export function appendIndex(base, record) {
  mkdirSync(base, { recursive: true })
  appendFileSync(join(base, INDEX_FILE), `${JSON.stringify(indexLine(record))}\n`)
}

/** One line an operator can read at the bottom of a run log. */
export function summaryLine(record) {
  const failed = record.checks.failed
    .map((c) => `${c.name}${c.values.length ? `=${c.values[0]}` : ''}`)
    .join(', ')
  return [
    `${record.trial} reward=${record.reward ?? 'none'}${record.void ? ' VOID' : ''}`,
    failed ? `failed: ${failed}` : `failed: none of ${record.checks.total}`,
    record.suspects.length ? `suspects: ${record.suspects.map((s) => s.rule).join(', ')}` : 'suspects: none',
  ].join(' | ')
}

export function renderMarkdown(r) {
  const L = []
  L.push(`# forensics — ${r.trial}`)
  L.push('')
  L.push(
    `reward **${r.reward ?? 'none'}**${r.void ? ' · **VOID** (not a fair test)' : ''}` +
      `${r.exception ? ` · exception \`${r.exception}\`` : ''} · ` +
      `${r.tokens.output ?? '?'} output tokens · ${r.checks.passed}/${r.checks.total} checks passed`,
  )
  L.push('')
  if (r.checks.failed.length) {
    L.push('## failed checks')
    L.push('')
    for (const c of r.checks.failed) {
      const more = c.values_truncated ? ` (+${c.values_truncated} more printed)` : ''
      L.push(
        `- **${c.name}** — values \`${c.values.join('`, `') || 'none printed'}\`${more} (${c.ordinal_semantics})`,
      )
      if (c.assertion) L.push(`  - \`${c.assertion}\``)
    }
    L.push('')
  }
  if (r.suspects.length) {
    L.push('## suspects')
    L.push('')
    for (const s of r.suspects) L.push(`- **${s.rule}** — ${s.evidence}`)
    L.push('')
  }
  if (r.baseline) {
    L.push('## baseline (most recent CLEAN pass)')
    L.push('')
    L.push(
      `- \`${r.baseline.trial}\` reward ${r.baseline.reward} — line delta +${r.baseline.diffstat.added}/-${r.baseline.diffstat.removed} across ${r.baseline.diffstat.changed_files} file(s)`,
    )
    L.push('')
  }
  if (r.deliverables.length) {
    L.push('## deliverables recovered')
    L.push('')
    for (const d of r.deliverables) {
      L.push(`- \`${d.path}\` — ${d.bytes} bytes, sha256 ${d.sha256.slice(0, 12)}, fidelity **${d.fidelity}**`)
    }
    L.push('')
  }
  L.push('## memory')
  L.push('')
  const ids = (x) => (x.length ? x.join(', ') : 'none')
  L.push(`- served: ${ids(r.memory.served)}`)
  L.push(`- read: ${ids(r.memory.read)} · refuted at read: ${ids(r.memory.refuted_at_read)}`)
  L.push(`- authored: ${ids(r.memory.authored)} · creditable: ${ids(r.memory.credited)}`)
  L.push('')
  if (r.blocks.length) {
    L.push(`## Stop-hook blocks (${r.blocks.length})`)
    L.push('')
    for (const b of r.blocks) L.push(`- **${b.kind}**${b.at ? ` at ${b.at}` : ''} — ${b.head.replace(/\n/g, ' ')}`)
    L.push('')
  }
  if (r.claims.unmatched_numbers.length) {
    L.push('## numbers the agent published that the grader never printed')
    L.push('')
    L.push(`\`${r.claims.unmatched_numbers.slice(0, 24).join('`, `')}\``)
    L.push('')
  }
  if (r.errors.length) {
    L.push('## errors while collecting')
    L.push('')
    for (const e of r.errors) L.push(`- ${e}`)
    L.push('')
  }
  return `${L.join('\n')}\n`
}

function main() {
  const args = process.argv.slice(2)
  const trialDir = args.find((a) => !a.startsWith('--'))
  const baseIdx = args.indexOf('--base')
  const base = baseIdx >= 0 ? args[baseIdx + 1] : undefined
  if (!trialDir) {
    console.error('usage: post-trial-forensics.mjs <trial-dir> [--base <jobs-root>] [--json]')
    process.exit(2)
  }
  if (!existsSync(trialDir)) {
    console.error(`[forensics] no such trial dir: ${trialDir}`)
    // Exit 0: this step is advisory and must never change a run's outcome.
    process.exit(0)
  }
  let record
  try {
    record = forensicsForTrial(trialDir, { base })
  } catch (e) {
    console.error(`[forensics] failed (non-fatal): ${e?.message ?? e}`)
    process.exit(0)
  }
  if (args.includes('--json')) console.log(JSON.stringify(record, null, 2))
  else console.log(summaryLine(record))
  process.exit(0)
}

if (process.argv[1]?.endsWith('post-trial-forensics.mjs')) main()
