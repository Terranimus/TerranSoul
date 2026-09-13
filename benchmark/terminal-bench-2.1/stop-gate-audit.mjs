#!/usr/bin/env node
/**
 * `stop-gate-audit.mjs` — does the verify-before-stop gate ever stop anything,
 * and when it fires, does the agent go back to work?
 *
 *   usage: node stop-gate-audit.mjs [jobs-dir] [--agent <substr>] [--json]
 *
 * ⛔ THE QUESTION THIS ANSWERS, WHICH NOTHING ELSE DOES.
 *
 * `stop-hook.mjs` can return `{"decision":"block"}` and Claude Code re-injects
 * the reason as a meta user turn, so a blocked stop leaves a permanent mark in
 * the transcript. Nothing reads those marks back across trials. We know the
 * hook RUNS — `brain_verify_completion` appears in every proxy log — but
 * "the tool was invoked" is not "the gate enforced anything"
 * (`reference_advertisement_is_not_use`: 34 claimed vs 8 real, n=479).
 *
 * The number that matters for "continue on iteration 1 instead of giving up" is
 * not how often the gate blocks. It is the **silent give-up rate**: trials that
 * scored 0 having never been blocked once. Every one of those is a stop the
 * gate was consulted on and waved through, on work the grader then rejected.
 * That is the population any enforcement improvement has to move; blocks that
 * already happen are the part that already works.
 *
 * THREE OUTCOMES PER TRIAL, and they are not equally interesting:
 *
 *   reward 1, 0 blocks  — the gate was right to allow (the bulk of passes)
 *   reward 1, N blocks  — the gate blocked and the trial still passed. NOT
 *                         automatically a false block: the block may be why it
 *                         passed. `resumedAfterBlock` separates those.
 *   reward 0, 0 blocks  — SILENT GIVE-UP. The agent stopped, the gate allowed
 *                         it, the grader disagreed. This is the target.
 *   reward 0, N blocks  — the gate fired and the trial lost anyway: the block
 *                         reason did not carry enough signal to redirect.
 *
 * `resumedAfterBlock` is the one that tells you a block did WORK rather than
 * just annoying the agent into restating its claim. It is true only when a
 * `tool_use` appears after the last block — a text-only reply after being told
 * to check its work is precisely the failure mode the block exists to prevent,
 * and it is invisible in a block count.
 *
 * READ-ONLY. Walks trial directories and parses JSON. Writes nothing, calls no
 * brain, and takes no position on any individual trial — it reports what the
 * transcripts, the ledger rows and the task statements already contain.
 *
 * ⛔ ANCHORING IS RECOMPUTED, NEVER READ OFF A MARKER. The judge half of this
 * audit imports `judgeClaimAnchor` from the Stop hook's own
 * `judge-anchor.mjs` and asks it the same question the hook asks, against the
 * task's `instruction.md` (TB_TASKS_DIR). That import is DELIBERATELY HARD: an
 * earlier version read a marker constant with a placeholder fallback, so if the
 * constant went away the whole column read 0 forever while looking measured.
 * A missing dependency now fails loudly at load, which is the failure mode a
 * measurement tool should have — and the suite pins it by asserting that no
 * marker reader is exported at all.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STOP_FEEDBACK_PREFIX, JUDGE_BLOCK_PREFIX, LEDGER_BLOCK_PREFIX } from '../../packages/terransoul-cli/src/stop-hook.mjs'
import { judgeClaimAnchor, goalIsAnchorable } from '../../packages/terransoul-cli/src/judge-anchor.mjs'
import { outcomeOf } from './trial-outcome.mjs'
// ONE formatter for a probability, shared with the watch that wrote the rows:
// the number an operator reads live and the number this audit prints later must
// not disagree, and `toFixed(4)` renders the strongest alarms as `0.0000`.
import { formatP } from './refutation-watch.mjs'

/**
 * Flatten a transcript turn's content to text.
 *
 * Claude Code writes `content` as a bare string on some turns and an array of
 * typed blocks on others; a reader that handles only one shape silently sees
 * half the transcript, which is how a gate audit reports a clean bill of health
 * on a corpus full of blocks.
 */
export function turnText(event) {
  const c = event?.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
}

/** True when this turn is the harness re-injecting a blocked stop. */
export function isStopBlockTurn(event) {
  if (event?.type !== 'user') return false
  return turnText(event).includes(STOP_FEEDBACK_PREFIX)
}

/** Which half of the hook blocked: the judge, the ledger, or an unrecognised shape. */
export function blockKind(event) {
  const t = turnText(event)
  if (t.includes(JUDGE_BLOCK_PREFIX)) return 'judge'
  if (t.includes(LEDGER_BLOCK_PREFIX)) return 'ledger'
  return 'other'
}

/**
 * The product's own REFUTED banner and recount provenance line, as
 * `crates/memory/src/outcome_stamp.rs` writes them (`REFUTED_BANNER_PREFIX`
 * there, and the `[RECOUNTED ...]` head line `brain_recount_outcome` adds).
 *
 * ⛔ THIS IS THE SERVED CONSEQUENCE, AND IT IS THE HALF THE WATCH DOES NOT
 * MEASURE. `refutation-watch.mjs` records that it DECIDED; the alarm jsonl
 * records that it ACTED; neither can say whether a later trial was ever SHOWN
 * the banner those counters produce. That is measurable here and nowhere else,
 * because only the transcript holds what the agent was handed.
 *
 * The constants are duplicated across a language boundary, so a test reads the
 * Rust file and fails loudly if the literal there is renamed — a banner counter
 * that silently reads 0 forever is the defect this whole tool exists to avoid.
 */
export const REFUTED_BANNER_PREFIX = '[REFUTED '
export const RECOUNT_PREFIX = '[RECOUNTED '

/**
 * The text of every TOOL RESULT in a turn — what the agent was SHOWN.
 *
 * ⛔ ASSISTANT TURNS ARE DELIBERATELY NOT READ. An agent that quotes the banner
 * back in its own prose is evidence that it read it, not evidence that the
 * product served it; counting that would let the model inflate a measurement of
 * the serving layer.
 */
export function toolResultText(event) {
  if (event?.type !== 'user') return ''
  const c = event?.message?.content
  if (!Array.isArray(c)) return ''
  const out = []
  for (const b of c) {
    if (b?.type !== 'tool_result') continue
    const inner = b.content
    if (typeof inner === 'string') out.push(inner)
    else if (Array.isArray(inner)) {
      for (const x of inner) out.push(typeof x === 'string' ? x : (x?.text ?? ''))
    }
  }
  return out.join('\n')
}

function occurrences(haystack, needle) {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i >= 0) {
    n += 1
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/**
 * How many rows carrying the REFUTED banner (and the recount provenance line)
 * this trial was actually served.
 */
export function refutedBannerServings(events) {
  let banners = 0
  let recounts = 0
  for (const e of events ?? []) {
    const t = toolResultText(e)
    if (!t) continue
    banners += occurrences(t, REFUTED_BANNER_PREFIX)
    recounts += occurrences(t, RECOUNT_PREFIX)
  }
  return { banners, recounts }
}

/** True when the turn contains at least one tool call. */
export function hasToolUse(event) {
  if (event?.type !== 'assistant') return false
  const c = event?.message?.content
  return Array.isArray(c) && c.some((b) => b?.type === 'tool_use')
}

/**
 * Per-transcript gate behaviour.
 *
 * `resumedAfterBlock` deliberately looks only PAST the final block. An agent
 * blocked twice that worked after the first and merely replied after the second
 * still ended by giving up, and counting the earlier work would hide that.
 */
export function auditTranscript(events) {
  const blocks = []
  const blockDetails = []
  let lastBlockIndex = -1
  let assistantTurns = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e?.type === 'assistant') assistantTurns++
    if (isStopBlockTurn(e)) {
      const kind = blockKind(e)
      const text = turnText(e)
      blocks.push(kind)
      // ⛔ `blocks` STAYS A LIST OF KINDS. Its shape is asserted by three tests
      // and read by `summarise`; the richer record rides alongside it rather
      // than replacing it.
      //
      // A block records WHAT THE HOOK DID. Whether the judge's objection was
      // anchored is not a property of the block text and is not read from one:
      // it is recomputed from the ledger's own verdict rows against the task's
      // goal (`anchorJudgeDecisions`). The earlier version tested the block text
      // for a marker the shipped hook only ever puts on an ALLOW-path note, so
      // its anchored column was structurally 0 on every real trial.
      blockDetails.push({ kind, text })
      lastBlockIndex = i
    }
  }
  const resumedAfterBlock =
    lastBlockIndex >= 0 && events.slice(lastBlockIndex + 1).some((e) => hasToolUse(e))
  const served = refutedBannerServings(events)
  return {
    assistantTurns,
    blocks,
    blockDetails,
    blockCount: blocks.length,
    resumedAfterBlock,
    // The serving layer's half of the refutation loop, counted from the only
    // artifact that holds it.
    refutedBanners: served.banners,
    recountNotes: served.recounts,
  }
}

/**
 * Where the task statements live, so a judge's objection can be compared to the
 * goal it was supposed to be about. Overridable, because the clone's location
 * is a property of this machine and not of the audit.
 */
const TASKS_ROOT = process.env.TB_TASKS_DIR || 'D:/Git/terminal-bench-2-1/tasks'

const GOAL_CACHE = new Map()

/**
 * One task's own `instruction.md`, CR-stripped.
 *
 * ⛔ THE GOAL IS THE TASK'S, NOT OURS. The first user message a trial sees is
 * the instruction with this harness's extra-instruction appended, and 93.9% of
 * that text is us talking to ourselves. Anchoring against it would let our own
 * prose anchor the judge's objection. The task clone is CRLF; the CRs are
 * stripped so an excerpt printed from here matches one printed from anywhere
 * else.
 *
 * Cached: a sweep of 89 tasks asks for the same file once per trial.
 */
export function readGoal(task, root = TASKS_ROOT) {
  const key = `${root}\u0000${task}`
  if (GOAL_CACHE.has(key)) return GOAL_CACHE.get(key)
  let text = ''
  try {
    text = readFileSync(join(root, task, 'instruction.md'), 'utf8').replace(/\r/g, '').trim()
  } catch {
    // A task we cannot find is a residual, never an unanchored verdict.
  }
  GOAL_CACHE.set(key, text)
  return text
}

/**
 * The goal for ONE trial, found the way the runner recorded it.
 *
 * ⛔ `task_name` IS NAMESPACED AND THE DIRECTORY IS NOT. A real result.json
 * carries `task_name: 'terminal-bench/sam-cell-seg'` and
 * `task_id.path: 'D:\Git\terminal-bench-2-1\tasks\sam-cell-seg'`. Joining the
 * namespaced name onto the tasks root finds nothing, and "found nothing" is
 * indistinguishable from "the judge named no requirement from the goal" in any
 * counter that does not keep them apart — which is exactly why the missing-goal
 * residual is printed rather than folded into the unanchored column. The
 * recorded path is preferred because it is the directory the runner actually
 * used; the namespaced name and the trial's own prefix are fallbacks.
 */
export function goalForTrial(result, trialName, root = TASKS_ROOT) {
  const recorded = result?.task_id?.path
  if (typeof recorded === 'string' && recorded) {
    try {
      return readFileSync(join(recorded, 'instruction.md'), 'utf8').replace(/\r/g, '').trim()
    } catch {
      // Fall through to the name-based lookup: the clone may have moved.
    }
  }
  const named = String(result?.task_name ?? '').split('/').filter(Boolean).pop()
  for (const task of [named, String(trialName ?? '').split('__')[0]]) {
    if (!task) continue
    const goal = readGoal(task, root)
    if (goal) return goal
  }
  return ''
}

/**
 * Every JUDGE VERDICT a trial's proxy log recorded, with the evidence strings
 * the judge was shown.
 *
 * ⛔ THE LEDGER ROW IS THE DECISION. `verify:'verify'` rows carry the judge's
 * own `{verified, reason}` — the same pair `gateway.rs` asks for — so the
 * population this table describes is the judge's verdicts, not the hook's
 * announcements about them. A verdict that was SUPPRESSED (allowed despite
 * being negative) is in here exactly like one that spent a block, which is the
 * only way the suppressed population is countable at all.
 *
 * ATTRIBUTION DISCIPLINE, unchanged: a job holding more than one trial has one
 * shared log and no field identifies a trial within it, so it yields nothing
 * rather than a plausible-looking guess.
 */
export function judgeVerdictsFrom(logText, trialCount) {
  if (trialCount !== 1) return []
  const out = []
  const evidence = []
  for (const line of String(logText || '').split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let o
    try {
      o = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    if (typeof o?.verify !== 'string') continue
    // The proof the agent filed, in the order it filed it — what the judge was
    // looking at when it wrote the reason below.
    if (o.verify === 'record' && typeof o.command === 'string') evidence.push(o.command)
    if (o.verify !== 'verify' || typeof o.verified !== 'boolean') continue
    out.push({
      verified: o.verified,
      reason: typeof o.reason === 'string' ? o.reason : '',
      at: typeof o.at === 'string' ? o.at : null,
      evidence: [...evidence],
    })
  }
  return out
}

/**
 * Each verdict, with the anchoring question answered by RECOMPUTATION.
 *
 * @returns {Array<{verified, reason, anchored: boolean|null, anchor, kind,
 *   hardTokensUnbacked: string[], goalAnchorable: boolean}>}
 *
 * `anchored: null` means the question could not be asked — the goal is missing
 * or too short to supply an anchor. It is a RESIDUAL, never an unanchored
 * verdict: a rule that cannot tell "no requirement in the goal" from "no goal"
 * would report every trial whose instruction file we failed to read as the
 * judge inventing requirements (`goalIsAnchorable`, judge-anchor.mjs).
 */
export function anchorJudgeDecisions(verdicts, goal) {
  const anchorable = goalIsAnchorable(goal)
  return (verdicts ?? []).map((v) => {
    const reason = String(v.reason ?? '').trim()
    if (!reason || !anchorable) {
      return { ...v, anchored: null, anchor: null, kind: null, hardTokensUnbacked: [], goalAnchorable: anchorable }
    }
    const a = judgeClaimAnchor(reason, goal, v.evidence ?? [])
    return {
      ...v,
      anchored: a.anchored,
      anchor: a.anchor,
      kind: a.kind,
      // ⛔ PROVENANCE IS CARRIED, NOT DROPPED. `source` says whether the claim
      // was traced to the GOAL or to the EVIDENCE the judge was shown, and it is
      // the only observable difference between passing the evidence and not:
      // without it, dropping the third argument changes no field any reader or
      // test can see, and the evidence arm becomes a writer with no reader.
      source: a.source ?? null,
      hardTokensUnbacked: a.hardTokensUnbacked ?? [],
      goalAnchorable: true,
    }
  })
}

/**
 * WHAT THE SINGLE BLOCK WAS SPENT ON — the four-cell table, crossed with the
 * grader's verdict.
 *
 * ⛔ THE NUMBER THE ENFORCEMENT ARGUMENT TURNS ON. M3 maps 644 of 862 ledger
 * judge rows to trials: 165 negative, 29 of them the already-fail-open
 * `verdict_absent` shape, leaving 136 that spend a LIVE block — 110 of them on
 * trials that ULTIMATELY PASSED. Hand-read ground truth extrapolates ~20 of 136
 * (14.7%) to requirements that cannot be traced to the goal at all, ~17 of those
 * on passing trials. Blocking precision is at best 18.4%, and
 * judge-rejected-but-passing trials spend a median 28.8k output tokens against
 * 16.0k. So the budget is not the defect and must stay 1; the question this
 * table answers is what the one block is spent ON.
 *
 * ⛔ IT COUNTS DECISIONS, NOT BLOCKS, AND IT RECOMPUTES THEM. A negative verdict
 * that the hook suppressed is still a decision the judge made, and the earlier
 * marker-based version could see neither it nor the anchored column (the marker
 * rides an allow-path note, and does not exist at HEAD at all). Every cell here
 * comes from `judgeClaimAnchor(reason, goal, evidence)` over the ledger's own
 * rows, so it answers the same question on a corpus recorded before any marker
 * existed.
 *
 * EVERY POPULATION IS ACCOUNTED FOR. `negativeVerdicts` is the denominator and
 * the four cells plus `ungraded`, `goalMissing` and `verdictAbsent` add back up
 * to it — a residual that is not printed is a residual nobody checks.
 *
 * `hardTokensUnbacked` is TELEMETRY ONLY: the count of negative decisions that
 * rest on a token the goal never states. It is the number that decides whether
 * that clause is ever ALLOWED to gate, which is why it is measured before it is
 * trusted and never read from a field on a row.
 */
export function judgeDecisionTable(rows) {
  const t = {
    verdicts: 0,
    negativeVerdicts: 0,
    unanchoredOnPassing: 0,
    unanchoredOnFailing: 0,
    anchoredOnPassing: 0,
    anchoredOnFailing: 0,
    // The three residuals, printed rather than folded away.
    ungraded: 0,
    goalMissing: 0,
    verdictAbsent: 0,
    hardTokensUnbacked: 0,
    // Of the anchored decisions, the ones traced to the EVIDENCE the judge was
    // shown rather than to the task statement. Reported because it is the only
    // visible consequence of passing that evidence at all: an objection grounded
    // in the session's own failing output is the OPPOSITE of an invented
    // requirement, and a census that could not tell the two apart would count it
    // as one.
    anchoredViaEvidence: 0,
    // Blocks are counted separately, from the transcripts: a block is what the
    // hook DID, a verdict is what the judge decided, and pooling them hides
    // which of the two a number describes.
    judgeBlocks: 0,
    byKind: {},
  }
  for (const r of rows ?? []) {
    for (const b of r?.blockDetails ?? []) {
      t.byKind[b.kind] = (t.byKind[b.kind] ?? 0) + 1
      if (b.kind === 'judge') t.judgeBlocks += 1
    }
    const graded = !(r?.reward === null || r?.reward === undefined)
    for (const d of r?.judge?.decisions ?? []) {
      t.verdicts += 1
      if (d.verified) continue
      t.negativeVerdicts += 1
      if (d.hardTokensUnbacked?.length) t.hardTokensUnbacked += 1
      if (!String(d.reason ?? '').trim()) {
        t.verdictAbsent += 1
        continue
      }
      if (d.anchored === null) {
        t.goalMissing += 1
        continue
      }
      if (!graded) {
        t.ungraded += 1
        continue
      }
      const passing = r.reward > 0
      if (d.anchored) {
        t[passing ? 'anchoredOnPassing' : 'anchoredOnFailing'] += 1
        if (d.source === 'evidence') t.anchoredViaEvidence += 1
      } else t[passing ? 'unanchoredOnPassing' : 'unanchoredOnFailing'] += 1
    }
  }
  return t
}

/**
 * EVERY refutation decision a sweep recorded, firing or not, read back from the
 * jsonl rows `refutation-watch.mjs` appends beside each job's trials.
 *
 * ⛔ A FIRES-ONLY READER IS STRUCTURALLY BLIND TO THE MISCONFIGURATION THAT
 * PRODUCED ITS SILENCE. A decision that scanned no jobs root, or found no
 * credible base rate, can never fire — so the reader that filtered on `fires`
 * could not tell a sweep in which nothing was refuted from a sweep in which the
 * watch was pointed at the wrong directory for every trial. The rows carry
 * `scanned_jobs` and `reason` precisely so that difference is recoverable, and
 * until this existed nothing read either field.
 */
export function readRefutationDecisions(jobsDir) {
  const out = []
  let jobs
  try {
    jobs = readdirSync(jobsDir)
  } catch {
    return out
  }
  for (const job of jobs) {
    const path = join(jobsDir, job, 'memory-refutation-alerts.jsonl')
    if (!existsSync(path)) continue
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push({ ...JSON.parse(line), job })
      } catch {
        // A row truncated by a killed sweep is not a reason to drop the rest.
      }
    }
  }
  return out
}

/**
 * Every FIRING refutation alarm a sweep recorded.
 *
 * ⛔ A SWEEP THAT REFUTED A MEMORY AND DID NOT SAY SO IS THE SAME GAP ONE LEVEL
 * DOWN from the one the watch closes. Kept as the narrow reader it always was —
 * "alarms" means the rows that acted — and defined as a filter over
 * [`readRefutationDecisions`] so there is one parser, not two.
 */
export function readRefutationAlarms(jobsDir) {
  return readRefutationDecisions(jobsDir).filter((row) => row?.fires)
}

/** `x/y = 0.857`, or `n/a` when the row carries no control arm. */
function baseRateText(row) {
  const pass = row?.not_used?.pass
  const total = row?.not_used?.total
  const rate = typeof row?.base_rate === 'number' ? row.base_rate.toFixed(3) : 'n/a'
  return Number.isInteger(pass) && Number.isInteger(total)
    ? `${pass}/${total} = ${rate}`
    : `rate ${rate}`
}

/**
 * The REFUTATION ALARMS block, as lines.
 *
 * ⛔ WRITER WITH NO READER, AND THE WRITER WAS THE WATCH. The alert row carries
 * `applied`, `scanned_jobs`, `base_rate`, `lift`, `not_used`, `reason` and
 * `recount_scope`; the summary printed memory / task / streak / p and read none
 * of the rest. So a sweep in which every recount FAILED — the detector decided,
 * the ledger was never corrected, and the serving layer therefore annotates
 * nothing — printed a line identical to a sweep in which every recount landed.
 * That is the same defect class as the one the watch itself exists to close, one
 * level up (`reference_writer_with_no_reader_defect_class`).
 *
 * Returned as lines rather than printed so the rendering is testable — the point
 * of the block is WHAT IT SAYS.
 *
 * @param {object[]} decisions every recorded decision ([`readRefutationDecisions`])
 */
export function formatRefutationAlarms(decisions) {
  const rows = decisions ?? []
  const fired = rows.filter((r) => r?.fires)
  const applied = fired.filter((r) => r?.applied)
  const unapplied = fired.filter((r) => !r?.applied)
  const scannedNothing = rows.filter((r) => r?.scanned_jobs === 0)
  const out = [
    `  REFUTATION ALARMS: ${fired.length} fired of ${rows.length} decision(s) recorded — ` +
      `${applied.length} applied, ${unapplied.length} FIRED BUT NOT APPLIED`,
  ]
  for (const r of fired) {
    const lift = typeof r?.lift?.value === 'number' ? `, lift ${r.lift.value.toFixed(3)}` : ''
    const scope = r?.recount_scope
      ? recountScopeText(r.recount_scope, r.applied)
      : r?.applied
        ? ', scope not recorded'
        : ''
    const arms =
      Number.isInteger(r?.used?.total) && Number.isInteger(r?.scanned_jobs)
        ? `, used ${r.used.pass}/${r.used.total} of ${r.scanned_jobs} job(s) scanned`
        : ''
    out.push(
      `    ${r.applied ? '' : '⚠ '}memory ${r.memory_id} on ${r.task}, streak ${r.streak}, ` +
        `p=${formatP(r.p)}, not-used base ${baseRateText(r)}${arms}${lift} — ` +
        `${r.applied ? 'RECOUNTED' : 'NOT APPLIED'}${scope} (job ${r.job ?? '?'})`,
    )
  }
  if (unapplied.length) {
    out.push(
      `  ⚠ ${unapplied.length} of ${fired.length} firing alarm(s) never reached the store: the ` +
        `detector decided and the ledger was NOT corrected, so the serving layer annotates nothing ` +
        `and every later trial is served the same uncorrected counters. The watch's own ` +
        `"RECOUNT UNVERIFIED" line in the job log says which call failed.`,
    )
  }
  if (scannedNothing.length) {
    out.push(
      `  ⚠ ${scannedNothing.length} decision(s) SCANNED NOTHING — no directory named with the ` +
        `'jobs' prefix under the base the sweep resolved to. That is a misconfiguration (TB_JOBS_DIR), ` +
        `not a quiet corpus.`,
    )
  }
  // ── OUTCOME-VISIBLE-6 ──────────────────────────────────────────────────────
  //
  // ⛔ A COHORT THAT SHRANK IS INDISTINGUISHABLE FROM A CORPUS THAT WAS SMALLER
  // UNLESS SOMEBODY PRINTS THE DIFFERENCE. Reads that landed while the memory was
  // already refuted are in NEITHER arm — the tool surface served them the
  // `[REFUTED …]` verdict and a graded index, never the construction — so they
  // move no counter and pad no base rate. That is the correct treatment and it is
  // also invisible: the used arm is simply smaller than the number of trials that
  // touched the row. This is the reader (`reference_writer_with_no_reader_defect_class`).
  const exposedRows = rows.filter((r) => Number(r?.exposed_while_refuted) > 0)
  if (exposedRows.length) {
    const total = exposedRows.reduce((n, r) => n + Number(r.exposed_while_refuted), 0)
    const ids = [...new Set(exposedRows.map((r) => r.memory_id))].join(', ')
    out.push(
      `    ${total} exposed-while-refuted read(s) across ${exposedRows.length} decision(s) ` +
        `(memor${ids.includes(',') ? 'ies' : 'y'} ${ids}): served the refutation verdict and a ` +
        `graded index, not the construction — counted in neither arm, and crediting one would ` +
        `have released a quarantined body on a pass nobody built from it.`,
    )
  }
  // The non-firing reasons, folded — a sweep whose every decision said "no
  // credible base rate" is a different fact from one that had base rates and
  // found nothing wrong, and `reason` is the only field that distinguishes them.
  const quiet = rows.filter((r) => !r?.fires)
  if (quiet.length) {
    const byReason = new Map()
    for (const r of quiet) {
      const key = String(r?.reason ?? 'no reason recorded').replace(/\d+/g, 'N')
      byReason.set(key, (byReason.get(key) ?? 0) + 1)
    }
    out.push(
      `    ${quiet.length} decision(s) did not fire: ${[...byReason]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => `${n} × ${reason}`)
        .join('; ')}`,
    )
  }
  return out
}

/**
 * The recount's real scope — wider than the alarm's cohort, because the ledger
 * holds one row per memory. A row that did not apply carries the scope it WOULD
 * have written, which is not the same sentence and must not read like one.
 */
function recountScopeText(scope, applied) {
  // OUTCOME-VISIBLE-6: `trials` is what the walk FOUND and the fold counted
  // fewer, so the difference has to be on the same line or the two numbers look
  // like a bug. Omitted when zero, so the common line stays readable.
  const dropped = Number(scope?.exposed_while_refuted)
  const minus = Number.isFinite(dropped) && dropped > 0 ? `, ${dropped} exposed-while-refuted` : ''
  const what = `${scope.trials} used trial(s) across ${scope.tasks} task(s)${minus}`
  return applied
    ? `, over ${what} (the ledger row is per-memory, not per-task)`
    : `, the payload would have covered ${what}`
}

/** Parse a JSONL transcript, skipping unparseable lines rather than dying on one. */
export function readTranscript(path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A truncated final line is normal for a killed trial.
    }
  }
  return out
}

/**
 * The reward this trial CONTRIBUTES, or null when it was never graded.
 *
 * ⛔ NOT the raw `verifier_result` reward. A trial can be both passing and
 * errored — caffe-cifar-10 scored reward 1 after blowing the 3600s agent cap —
 * and the campaign rule is that errored trials count as 0 and are never
 * excluded. Reading the raw field alone reported this corpus as 46/46 when the
 * honest figure was 45/46. `trial-outcome.mjs` makes that one decision once.
 */
export function rewardOf(result) {
  return outcomeOf(result).counted
}

/**
 * The EVIDENCE TRAIL a trial filed with the verification ledger.
 *
 * ⛔ THIS IS THE READER for the `verify` lines the proxy writes. A logged field
 * nothing consumes is the most common silent defect class in this repo
 * (`reference_writer_with_no_reader_defect_class`), and the verdict logger
 * would be one without this.
 *
 * WHAT IT ANSWERS. `status`/`scope` are the ledger's structural verdict on each
 * check the agent filed, and `evidence:'self_selected'` is its judgement of
 * proof QUALITY — set when the ledger decides the agent chose its own check and
 * needs a corroboration nudge. "Every proof this failing trial filed was
 * self-selected and targeted" is a diagnosis; "it called record 6 times" is not.
 *
 * ATTRIBUTION DISCIPLINE. A job containing more than one trial has one shared
 * proxy log and no field identifies a trial within it — the peer address is
 * NAT-collapsed to 127.0.0.1 for every container (measured). So a multi-trial
 * job yields `attributed:false` rather than a plausible-looking guess, exactly
 * as `attribute-proxy-lines.mjs` does. One job per task makes this exact.
 */
export function evidenceTrail(logText, trialCount) {
  const trail = {
    ops: {},
    status: {},
    evidence: {},
    scope: {},
    // ⛔ `hardTokensUnbacked` USED TO BE COUNTED HERE, OFF THESE ROWS, AND
    // NOTHING EVER WROTE IT. The only producer puts it on the Stop hook's stderr
    // note; `grep -c hardTokensUnbacked` over a real terransoul-proxy-calls.jsonl
    // is 0, so the printed number was structurally zero while looking measured
    // (`reference_writer_with_no_reader_defect_class`, inverted). It is now
    // RECOMPUTED from the judge's own reason against the goal, in
    // `anchorJudgeDecisions`.
    attributed: trialCount === 1,
  }
  if (!trail.attributed) return trail
  for (const line of String(logText || '').split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let o
    try {
      o = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    if (typeof o?.verify !== 'string') continue
    const bump = (bucket, key) => {
      if (typeof key === 'string') bucket[key] = (bucket[key] ?? 0) + 1
    }
    bump(trail.ops, o.verify)
    bump(trail.status, o.status)
    bump(trail.evidence, o.evidence)
    bump(trail.scope, o.scope)
    // A judge verdict is a status too, and must not be lost among the ledger's
    // structural ones — it is the only one that reflects a reasoned opinion.
    if (typeof o.verified === 'boolean') {
      const key = `judge:${o.verified}`
      trail.status[key] = (trail.status[key] ?? 0) + 1
    }
  }
  return trail
}

/** The trial's transcript file, or null when the agent never started one. */
function findTranscript(trialDir) {
  const base = join(trialDir, 'agent', 'sessions', 'projects')
  if (!existsSync(base)) return null
  for (const proj of readdirSync(base)) {
    const dir = join(base, proj)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl')) return join(dir, f)
    }
  }
  return null
}

/** Every trial directory under a jobs root that produced a `result.json`. */
export function collectTrials(jobsDir, agentFilter, tasksRoot = TASKS_ROOT) {
  const rows = []
  if (!existsSync(jobsDir)) return rows
  for (const job of readdirSync(jobsDir)) {
    const jobDir = join(jobsDir, job)
    if (!statSync(jobDir).isDirectory()) continue
    // The job's own copy of its proxy log, and how many trials share it. One
    // trial per job (run-two-workers.sh) makes the evidence trail exact; more
    // than one makes it unattributable, and it is reported as such.
    const jobLogPath = join(jobDir, 'terransoul-proxy-calls.jsonl')
    const jobLog = existsSync(jobLogPath) ? readFileSync(jobLogPath, 'utf8') : ''
    const trialsInJob = readdirSync(jobDir).filter((d) =>
      existsSync(join(jobDir, d, 'result.json')),
    ).length
    for (const trial of readdirSync(jobDir)) {
      const trialDir = join(jobDir, trial)
      const resultPath = join(trialDir, 'result.json')
      if (!existsSync(resultPath) || !statSync(trialDir).isDirectory()) continue
      let result
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'))
      } catch {
        continue
      }
      const agent = result?.agent_info?.name ?? '?'
      // ⛔ THE IDENTITY FILTER IS NOT OPTIONAL. 60 trials in this corpus ran as
      // plain `claude-code` because `run-dg.sh`'s TB_AGENT fallback took effect,
      // and they measure baseline Claude Code with no hook installed at all.
      // Pooling them into a gate audit would report the gate as never firing on
      // trials where it was never installed.
      if (agentFilter && !agent.includes(agentFilter)) continue
      const transcriptPath = findTranscript(trialDir)
      const audit = transcriptPath
        ? auditTranscript(readTranscript(transcriptPath))
        : {
            assistantTurns: 0,
            blocks: [],
            blockDetails: [],
            blockCount: 0,
            resumedAfterBlock: false,
            refutedBanners: 0,
            recountNotes: 0,
          }
      const task = result?.task_name ?? trial.split('__')[0]
      // The judge's decisions, recomputed against THIS task's own goal. A job
      // holding several trials yields none, exactly as the evidence trail does.
      const decisions = anchorJudgeDecisions(
        judgeVerdictsFrom(jobLog, trialsInJob),
        goalForTrial(result, trial, tasksRoot),
      )
      rows.push({
        job,
        task,
        trial,
        agent,
        reward: rewardOf(result),
        hasTranscript: Boolean(transcriptPath),
        ...audit,
        evidence: evidenceTrail(jobLog, trialsInJob),
        judge: { decisions, attributed: trialsInJob === 1 },
      })
    }
  }
  return rows
}

/**
 * The four-cell table plus the two rates worth acting on.
 *
 * Trials with no graded reward are reported separately rather than folded in as
 * zeros: an ungraded trial is an infrastructure failure, and counting it as a
 * silent give-up would blame the gate for a container that never ran.
 */
export function summarise(rows) {
  const graded = rows.filter((r) => r.reward !== null)
  const cell = (pass, blocked) =>
    graded.filter((r) => (r.reward > 0) === pass && (r.blockCount > 0) === blocked).length
  const blockedRows = graded.filter((r) => r.blockCount > 0)
  const silent = graded.filter((r) => r.reward === 0 && r.blockCount === 0)
  return {
    trials: rows.length,
    graded: graded.length,
    ungraded: rows.length - graded.length,
    passNoBlock: cell(true, false),
    passBlocked: cell(true, true),
    failNoBlock: silent.length,
    failBlocked: cell(false, true),
    blockedTotal: blockedRows.length,
    resumedAfterBlock: blockedRows.filter((r) => r.resumedAfterBlock).length,
    byKind: blockedRows
      .flatMap((r) => r.blocks)
      .reduce((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {}),
    // The served half of the refutation loop: how many trials were handed a row
    // carrying the product's REFUTED banner, and how many rows that was. A sweep
    // that recounted a memory and never served the consequence is the same gap
    // one level down from the one the watch closes.
    refutedBannerTrials: rows.filter((r) => (r.refutedBanners ?? 0) > 0).length,
    refutedBannerRows: rows.reduce((n, r) => n + (r.refutedBanners ?? 0), 0),
    recountNoteRows: rows.reduce((n, r) => n + (r.recountNotes ?? 0), 0),
    silentGiveUpRate: graded.length ? silent.length / graded.length : 0,
    gateReach: graded.length ? blockedRows.length / graded.length : 0,
    evidence: evidenceSplit(graded),
    // Computed over ALL rows, not just graded ones: the ungraded trials carry no
    // cell but their evidence trails are still real telemetry.
    judge: judgeDecisionTable(rows),
  }
}

/**
 * The evidence trail split by OUTCOME — the comparison that carries the signal.
 *
 * A distribution over all trials says little; the same distribution split by
 * pass/fail is what shows whether trials that lost were filing weaker proof.
 * Trials whose job held several trials are excluded from both sides rather than
 * pooled in, since their trail cannot be attributed.
 */
export function evidenceSplit(graded) {
  const merge = (rows) => {
    const out = { trials: 0, ops: {}, status: {}, evidence: {}, scope: {} }
    for (const r of rows) {
      if (!r.evidence?.attributed) continue
      out.trials++
      for (const field of ['ops', 'status', 'evidence', 'scope']) {
        for (const [k, n] of Object.entries(r.evidence[field] ?? {})) {
          out[field][k] = (out[field][k] ?? 0) + n
        }
      }
    }
    return out
  }
  return {
    passed: merge(graded.filter((r) => r.reward > 0)),
    failed: merge(graded.filter((r) => r.reward === 0)),
    unattributable: graded.filter((r) => !r.evidence?.attributed).length,
  }
}

function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const agentIdx = argv.indexOf('--agent')
  const agentFilter = agentIdx >= 0 ? argv[agentIdx + 1] : 'terransoul'
  // ⛔ `agentIdx + 1` IS INDEX 0 WHEN THERE IS NO `--agent`, so the plain form
  // `stop-gate-audit.mjs <jobs-dir>` silently dropped its only argument and
  // audited `cwd/jobs` instead — reporting "0 trials" for a corpus that was
  // right there. Guarded on the flag actually being present.
  const valueIdx = agentIdx >= 0 ? agentIdx + 1 : -1
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== valueIdx)
  const jobsDir = positional[0] ?? join(process.cwd(), 'jobs')

  const rows = collectTrials(jobsDir, agentFilter)
  const s = summarise(rows)
  if (json) {
    console.log(JSON.stringify({ summary: s, rows }, null, 2))
    return
  }
  const pct = (n) => `${(n * 100).toFixed(1)}%`
  console.log(`[stop-gate] ${jobsDir}  agent~="${agentFilter}"`)
  console.log(`[stop-gate] ${s.trials} trials, ${s.graded} graded, ${s.ungraded} ungraded\n`)
  console.log('                      no block     blocked')
  console.log(`  reward 1            ${String(s.passNoBlock).padEnd(12)} ${s.passBlocked}`)
  console.log(`  reward 0            ${String(s.failNoBlock).padEnd(12)} ${s.failBlocked}`)
  console.log('')
  console.log(`  gate reach          ${s.blockedTotal}/${s.graded} graded trials (${pct(s.gateReach)})`)
  console.log(`  SILENT GIVE-UP      ${s.failNoBlock}/${s.graded} (${pct(s.silentGiveUpRate)}) — scored 0, never blocked`)
  console.log(`  resumed after block ${s.resumedAfterBlock}/${s.blockedTotal} blocked trials`)
  console.log(`  block kinds         ${JSON.stringify(s.byKind)}`)
  const ev = s.evidence
  console.log('')
  console.log(`  EVIDENCE TRAIL (attributable trials only; ${ev.unattributable} in multi-trial jobs excluded)`)
  if (!ev.passed.trials && !ev.failed.trials) {
    console.log('    none — no job in this corpus has one trial per proxy log yet')
  } else {
    const fmt = (o) => (Object.keys(o).length ? JSON.stringify(o) : '{}')
    for (const [label, side] of [['reward 1', ev.passed], ['reward 0', ev.failed]]) {
      console.log(`    ${label} (${side.trials} trials)`)
      console.log(`      ops      ${fmt(side.ops)}`)
      console.log(`      status   ${fmt(side.status)}`)
      console.log(`      evidence ${fmt(side.evidence)}`)
      console.log(`      scope    ${fmt(side.scope)}`)
    }
  }

  // ── WHAT THE JUDGE DECIDED, AND WHETHER IT WAS ABOUT THE GOAL ─────────
  const j = s.judge
  console.log('')
  // ⛔ THE HEADLINE MUST NOT POOL THE TWO POPULATIONS THE CODE KEEPS APART. A
  // VERDICT is what the judge decided (ledger rows, suppressed ones included); a
  // BLOCK is what the hook did (transcript turns). They are counted from
  // different artifacts and neither contains the other — on a real two-job
  // corpus the "subset" printed larger than the set it claimed to be part of
  // ("3 negative verdicts ... 4 of them spent a block"). They are now printed as
  // what they are: two counts, side by side, with their sources named.
  console.log(
    `  JUDGE DECISIONS (${j.negativeVerdicts} negative verdict(s) of ${j.verdicts} recorded in the ` +
      `ledger; anchoring RECOMPUTED against each task's instruction.md)`,
  )
  console.log(
    `  JUDGE BLOCKS    ${j.judgeBlocks} judge block(s) in the transcripts — a different population: a ` +
      `block is what the HOOK did, a verdict is what the JUDGE decided, and a suppressed verdict is in ` +
      `neither the other's count`,
  )
  console.log('                      on passing   on failing')
  console.log(`  unanchored          ${String(j.unanchoredOnPassing).padEnd(12)} ${j.unanchoredOnFailing}`)
  console.log(`  anchored to goal    ${String(j.anchoredOnPassing).padEnd(12)} ${j.anchoredOnFailing}`)
  // The residual, printed so the four cells can be reconciled against the
  // denominator by a reader rather than trusted.
  const cells =
    j.unanchoredOnPassing + j.unanchoredOnFailing + j.anchoredOnPassing + j.anchoredOnFailing
  console.log(
    `    residual            ${j.ungraded} ungraded + ${j.goalMissing} no recoverable goal + ` +
      `${j.verdictAbsent} verdict with no reason  (${cells} + residual = ${j.negativeVerdicts})`,
  )
  console.log(
    `  hardTokensUnbacked  ${j.hardTokensUnbacked} of ${j.negativeVerdicts} negative decision(s) rest on a ` +
      `token the goal never states — telemetry only, gates nothing`,
  )
  console.log(
    `  anchored via the EVIDENCE the judge was shown, not the goal: ${j.anchoredViaEvidence} of ` +
      `${j.anchoredOnPassing + j.anchoredOnFailing} anchored decision(s)`,
  )
  if (j.goalMissing) {
    console.log(
      `  ⚠ ${j.goalMissing} decision(s) had no recoverable task statement under ${process.env.TB_TASKS_DIR || 'the default tasks root'} — ` +
        `they are a residual, NOT unanchored verdicts (set TB_TASKS_DIR to the task clone).`,
    )
  }

  const decisions = readRefutationDecisions(jobsDir)
  console.log('')
  // ⛔ THE THREE STAGES OF THE REFUTATION LOOP, EACH FROM ITS OWN ARTIFACT, so a
  // stage that never happened cannot hide behind one that did: the watch DECIDED
  // (the alert jsonl), the store was CORRECTED (the recount provenance line the
  // serving layer renders), and a trial was SHOWN the banner (the transcript).
  console.log(
    `  REFUTED BANNER SERVED: ${s.refutedBannerRows} row(s) across ${s.refutedBannerTrials} trial(s); ` +
      `${s.recountNoteRows} served row(s) carried a [RECOUNTED ...] provenance line`,
  )
  // ⛔ THE THIRD STAGE IS "DID THE WRITE LAND", AND IT USED TO BE UNPRINTABLE.
  // Every field the watch records is read here: `applied` (the split below),
  // `base_rate` / `not_used` / `lift` (so the call can be re-judged without
  // re-walking the corpus), `recount_scope` (the ledger row is per-memory, so the
  // write is wider than the alarm), `scanned_jobs` and `reason` (a silence that is
  // a misconfiguration, not a measurement).
  for (const line of formatRefutationAlarms(decisions)) console.log(line)

  if (s.blockedTotal && s.resumedAfterBlock < s.blockedTotal) {
    console.log(
      `\n  ⚠ ${s.blockedTotal - s.resumedAfterBlock} blocked trial(s) made NO tool call after the ` +
        `final block — the agent replied instead of re-checking, which is the behaviour the block exists to prevent.`,
    )
  }
}

if (process.argv[1]?.endsWith('stop-gate-audit.mjs')) main()
