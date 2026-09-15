#!/usr/bin/env node
/**
 * `credit-trial-outcome.mjs` — teach the brain what the GRADER said, not what
 * the agent believed.
 *
 *   usage: node credit-trial-outcome.mjs <trial-dir> <proxy-log> [--apply]
 *          [--dry-run] [--refute-watch] [--refute-observe]
 *
 * `--refute-watch` runs the online refutation watch at the end of this script,
 * after the trial's own verdict has been credited; `--refute-observe` makes that
 * watch DETECT AND RECORD without writing the recount — the observe-only arm a
 * sweep needs when its numbers must stay independent of any mid-sweep repair.
 *
 * ⛔ THE DEFECT THIS CLOSES: THE NEGATIVE SIGNAL HAD NO PATH INTO MEMORY.
 *
 * `store.rs::confidence_buckets` promotes a memory with `success_count >= 1`
 * and `failure_count == 0` into a ranking bucket ABOVE untested rows — its own
 * doc comment cites a `filter-js-from-html` redo as the reason it exists. The
 * only writer of those counters during a bench run is `brain_observe_outcome`,
 * and BOTH of its inputs come from the agent: `outcome` and `used_memory_ids`
 * are read straight off the caller's arguments (mcp/tools.rs:4093-4107).
 *
 * So the loop closes on self-assessment. An agent that passes tests it wrote
 * itself reports `success` and names its own sources, and those sources are
 * promoted. Nothing anywhere writes the grader's verdict back.
 *
 * MEASURED 2026-09-01, and it is not hypothetical. Memory 26531 advises
 * "do NOT build a tree ... never emit the parser's serialisation". That advice
 * is the DIRECT CAUSE of this task's failure: the grader's equality target is
 * `str(BeautifulSoup(original, "html.parser"))`, so a byte-faithful filter
 * loses on bs4's void-element `/` and alphabetical attribute sorting no matter
 * how correct its XSS handling is. A reconstructed run of the agent's filter
 * changed ZERO bytes in all 12 clean samples and still failed 5 of them.
 *
 * That memory carries `success_count=2, failure_count=0` after 54 consecutive
 * graded failures, sits in the top bucket, and is served at rank 1 to every new
 * attempt. The self-improve loop did not merely fail to learn — it actively
 * taught each attempt the approach that cannot pass.
 *
 * WHAT THIS DOES. Reads the trial's own `verifier/reward.txt` (the graded
 * number, never the exit code — `run-dg.sh` says so at length) and the `served`
 * lines the proxy appended for each `brain_search`, then records that real
 * outcome against exactly the memories the agent was SHOWN.
 *
 * WHY THE PROXY'S RECORD AND NOT `used_memory_ids`. The agent chooses what to
 * call "used", and an agent that has just failed is the least reliable witness
 * to which of its inputs misled it. What the proxy logged at the time is an
 * observed fact.
 *
 * ⛔ BUT "SHOWN" IS NOT "USED", AND THE FIRST VERSION OF THIS FILE CONFLATED
 * THEM (OUTCOME-VISIBLE-2). It credited every `served` id, on the argument that
 * over-attribution is the safe direction for a FAILURE signal. That argument
 * does not survive contact with a PASS: a success credited to a row the agent
 * only glanced past is a promotion nobody earned, and `confidence_buckets`
 * ranks a clean success above everything untested. See [`USED_KEYS`] for the
 * measurement — a MobileSAM notebook reading 9 successes / 6 failures, of which
 * seven successes came from tasks it had nothing to do with.
 *
 * So the credit set is now USE — opened (`brain_get_entry`) or written
 * (`brain_ingest_lesson` / `brain_append`) — and the exposed-but-unused ids are
 * counted and reported rather than dropped in silence.
 *
 * DRY BY DEFAULT. Without `--apply` it prints what it would record and writes
 * nothing, because a tool that mutates ranking state must not do so as a
 * side effect of someone reading its output.
 *
 * ── AND THE VERDICT HAS TO REACH THE TEXT, NOT ONLY THE COUNTERS ────────────
 *
 * OUTCOME-VISIBLE-1. Crediting moves `success_count` / `failure_count`, which
 * `confidence_buckets` reads for RANKING. Nothing the agent READS changed:
 * `brain_search` hits and `brain_get_entry` carried no outcome at all, and an
 * `[Update <ms> · agent-session]` block carried no grade, so advice appended by
 * a failing attempt was indistinguishable from advice appended by a passing
 * one.
 *
 * MEASURED 2026-09-11: one 68 KB notebook held twenty appended blocks written
 * by ~11 attempts at a single task. Attempt N read the block attempt N-1 had
 * left, reproduced its construction, and failed the grader at the IDENTICAL
 * number — twice. The information that would have stopped it existed in this
 * pipeline the whole time and had no path into the text.
 *
 * So after crediting, this also STAMPS: for every memory the trial itself
 * appended to or created, `brain_stamp_outcome` rewrites the headers of the
 * blocks written inside the trial's own window to carry the verdict. Only
 * AUTHORED ids are stamped — a row the trial merely read is where it looked,
 * not what it wrote, and stamping that would attribute this verdict to advice
 * the trial may have explicitly rejected.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { idsForTrial } from './attribute-proxy-lines.mjs'
import { runWasSound } from './trial-outcome.mjs'
import { runRefutationWatch, transportFor } from './refutation-watch.mjs'
import { EXPOSED_WHILE_REFUTED, seededRefutationThreshold } from './recount-outcomes.mjs'

/** The graded reward, or null when the trial produced none. */
export function readReward(trialDir) {
  const p = join(trialDir, 'verifier', 'reward.txt')
  if (!existsSync(p)) return null
  const raw = readFileSync(p, 'utf8').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * What counts as USE (OUTCOME-VISIBLE-2): the trial OPENED the memory
 * (`brain_get_entry`) or WROTE to it (`brain_ingest_lesson` / `brain_append`).
 *
 * ⛔ BEING SHOWN A ROW IS NOT USING IT. `brain_search` puts up to ten entries
 * in front of an agent and this script used to credit every one of them with
 * the trial's graded outcome.
 *
 * MEASURED 2026-09-12 on memory 26809, a MobileSAM notebook. Nineteen trials
 * touched it. Twelve were its own task: 3 passes, 9 failures, and every single
 * one of the twelve AUTHORED it. The other seven belonged to unrelated tasks
 * (caffe-cifar-10 twice, mteb-retrieve, bn-fit-modify, video-processing,
 * winning-avg-corewars, pytorch-model-cli); every one passed, and every one had
 * merely seen the row in a search result. All seven were credited as successes.
 *
 * The stored ledger therefore read 9 successes / 6 failures. On its own task
 * the entry is 3 of 12 with four consecutive failures — REFUTED under the rule
 * `SERVER_INSTRUCTIONS` states — and the agent reading it at 01:05 was told
 * "9/6, last failure" instead. A segmentation notebook was being paid for a
 * CIFAR pass.
 *
 * The exposed-but-unused ids are still COUNTED and reported, so narrowing the
 * credit set cannot quietly become "we stopped looking at most of the data".
 *
 * ── OUTCOME-VISIBLE-6: AND A READ OF A *REFUTED* ENTRY IS NOT USE EITHER ─────
 *
 * ⛔ THE SERVED GUIDANCE IS WHY. `SERVER_INSTRUCTIONS` and both tool schemas
 * state the rule this harness is calibrated to: an entry whose graded record
 * shows a `consecutive_failures` streak at or above the seeded refutation
 * threshold is a REFUTED construction, its served text begins with a
 * `[REFUTED …]` line, and since OUTCOME-VISIBLE-5 "a refuted entry's text is
 * withheld from tool surfaces until its next graded success; what is served is
 * the verdict plus a graded index of the entry's own update blocks". So a trial
 * that opens a refuted memory is handed a WARNING AND A TABLE OF CONTENTS. It
 * cannot have built from the construction, because no tool call returns it.
 *
 * MEASURED 2026-09-13. Entry 26809 was refuted (10 consecutive graded failures)
 * and quarantined. Trial `redo09130830` read it, got the quarantined view,
 * authored 27007 and PASSED 9/9. This script then logged
 * `[credit] reward=1 -> success for 2 used memories: 26809, 27007` — USED being
 * `authored ∪ read` — so 26809 went to graded_successes 3 /
 * consecutive_failures 0 / last_outcome success, `MemoryOutcome::is_refuted`
 * answered no, the banner and the quarantine LIFTED, and the brain served the
 * full body again.
 *
 * That oscillates rather than repairs: release → the next reader builds from the
 * body → loses twice → re-quarantined → a reader of the index passes → released.
 * A success earned by a reader who never saw the body must not release that body.
 *
 * THE RULE. A read of a memory that was REFUTED AT THE TIME OF THE READ is
 * EXPOSURE, not use: it credits neither success nor failure to that memory (the
 * reader used the verdict and the index, not the construction), and it is
 * reported in this log as `exposed-while-refuted` with the id. AUTHORED appends
 * are unaffected — an author who appends to a refuted entry is still crediting it
 * — though OUTCOME-VISIBLE-3's banner tells authors to record a NEW entry
 * instead, which is exactly what 27007 is.
 *
 * ⛔ CONSEQUENCE, STATED HERE BECAUSE IT IS THE WHOLE POINT: a refuted entry is
 * released only by a graded success credited through AUTHORSHIP (somebody
 * appended to it and passed) or by an explicit recount
 * (`recount-outcomes.mjs --apply`). Nothing a reader of the quarantined index
 * does can hand the body back.
 *
 * `read_refuted` is deliberately NOT in this list — see [`EXPOSED_KEYS`].
 */
export const USED_KEYS = ['authored', 'read']

/**
 * Proxy keys that record EXPOSURE to a refuted entry (OUTCOME-VISIBLE-6).
 *
 * `mcp-auth-proxy.mjs::noteReadMemory` writes `read_refuted` instead of `read`
 * when the view the brain handed back carried the refutation banner or the
 * quarantine line. Keeping it out of [`USED_KEYS`] is what makes the rule hold
 * for every consumer of that constant at once — `recountRows`, the watch's
 * cohorts and this script all narrow together — while the ids stay countable and
 * reportable here.
 */
export const EXPOSED_KEYS = ['read_refuted']

/** Ids this log shows were READ, whether or not the entry was refuted. */
export function readMemoryIds(proxyLogText) {
  return memoryIdsForKeys(proxyLogText, ['read'])
}

/** Ids the proxy logged as read WHILE REFUTED, job-wide. */
export function exposedWhileRefutedIds(proxyLogText) {
  return memoryIdsForKeys(proxyLogText, EXPOSED_KEYS)
}

/**
 * Ids read on a row written by a proxy that PREDATES the refutation check.
 *
 * ⛔ PRECEDENCE, AND IT IS ONE RULE IN ONE PLACE: THE PROXY KEY WINS; THE LEDGER
 * IS CONSULTED ONLY FOR LEGACY ROWS. A row written by the current proxy carries
 * `refuted_at_read` (on both shapes — see `noteReadMemory`), so `read` means "and
 * the brain served it unbannered" and needs no second opinion. A row without that
 * field was written before the check existed and says nothing about the entry's
 * state, so those ids — and ONLY those — fall back to the live ledger.
 *
 * Getting the precedence the other way round would be worse than either source
 * alone: the ledger is TODAY's counters, so a row refuted since the trial ran
 * would retroactively decredit a read the brain answered in full.
 *
 * Job-wide rather than windowed, and the caller intersects with its own trial's
 * read ids. One proxy binary writes every row in a job's log, so a given id's
 * rows in one log are all legacy or all current; splitting the scan per trial
 * would add a windowing pass that cannot change the answer.
 */
export function legacyReadIds(proxyLogText) {
  const ids = new Set()
  for (const line of String(proxyLogText || '').split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let obj
    try {
      obj = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    if (!Array.isArray(obj?.read) || 'refuted_at_read' in obj) continue
    for (const id of obj.read) if (Number.isInteger(id)) ids.add(id)
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * Does this ledger row say the memory was refuted BEFORE the trial started?
 *
 * @param {object|null} outcome the `outcome` object `brain_get_entry` returns
 * @param {number} trialStartMs the trial's own `started_at`
 * @param {number} threshold the seeded refutation threshold
 *
 * ⛔ BOTH HALVES OF `MemoryOutcome::is_refuted`, because a streak alone cannot
 * say which way the LAST grading went: a row re-confirmed after nine losses is
 * not refuted, and `last_outcome` is absent on rows graded before V71 — absence
 * of a direction is not a verdict.
 *
 * ⛔ AND THE STREAK MUST PREDATE THE TRIAL. This script runs BEFORE the trial's
 * own verdict is recorded, so the counters it reads are pre-trial by
 * construction — but a concurrent sweep's later verdict could still have landed
 * in between, and crediting THIS trial's read as exposure on the strength of a
 * grading that happened after it read is backwards. `last_outcome_at` bounds it:
 * a streak whose most recent grading is newer than this trial's start is not
 * evidence about what this trial was served.
 */
export function refutedBeforeTrial(outcome, trialStartMs, threshold) {
  if (!outcome || !(threshold > 0)) return false
  const streak = Number(outcome.consecutive_failures)
  if (!Number.isFinite(streak) || streak < threshold) return false
  if (outcome.last_outcome !== 'failure') return false
  const at = Number(outcome.last_outcome_at)
  if (Number.isFinite(at) && Number.isFinite(trialStartMs) && at > trialStartMs) return false
  return true
}

/**
 * The live ledger's `outcome` for one memory, or null.
 *
 * A read-only `brain_get_entry`, over the transport this script already opens.
 * Every failure yields null — a bookkeeping lookup must never be able to fail a
 * measured trial, and null means "classified by the proxy key alone", which is
 * exactly the pre-change behaviour.
 */
export async function fetchEntryOutcome(callTool, id) {
  try {
    const { res, text } = await callTool({ name: 'brain_get_entry', arguments: { id } })
    if (!res?.ok || String(text).includes('"isError":true')) return null
    const inner = JSON.parse(JSON.parse(text)?.result?.content?.[0]?.text ?? '{}')
    return inner?.outcome ?? null
  } catch {
    return null
  }
}

/**
 * Which of this trial's reads were EXPOSURE — the one place the two sources meet.
 *
 * @returns {{ids: number[], ledgerChecked: number, ledgerSkipped: number[]}}
 *
 * SOURCE (a), THE PROXY KEY: `read_refuted` rows, written at the moment the view
 * was served, with the served bytes in hand. Authoritative wherever it exists.
 *
 * SOURCE (b), THE LEDGER: for LEGACY rows only (a plain `read` with no
 * `refuted_at_read` marker), `brain_get_entry` is asked for the memory's current
 * `outcome` and [`refutedBeforeTrial`] applies the serving layer's own predicate
 * against the seeded threshold. Legacy rows are the whole corpus written before
 * OUTCOME-VISIBLE-6, so without this the rule would apply to new sweeps only and
 * every archived job would keep releasing quarantined bodies on recount.
 *
 * AUTHORSHIP OUTRANKS BOTH. An id this trial appended to is credited however it
 * was served: the append is itself an endorsement, and the entry's own banner
 * already tells authors to record a new entry instead.
 *
 * With no transport (a dry run with no MCP env) the legacy ids are reported as
 * UNCHECKED rather than assumed either way — a classifier that guessed here
 * would make the dry run's answer differ from the live one, and those two must
 * agree or neither can be audited.
 */
export async function classifyExposedWhileRefuted({
  readIds = [],
  authored = [],
  readRefutedIds = [],
  legacyIds = [],
  callTool = null,
  trialStartMs = NaN,
  threshold = undefined,
  log = console,
}) {
  const k = threshold ?? seededRefutationThreshold()
  const authoredSet = new Set(authored)
  const exposed = new Set(readRefutedIds.filter((id) => !authoredSet.has(id)))
  const legacy = new Set(legacyIds)
  const candidates = readIds.filter(
    (id) => legacy.has(id) && !authoredSet.has(id) && !exposed.has(id),
  )
  if (!candidates.length) return { ids: sortedIds(exposed), ledgerChecked: 0, ledgerSkipped: [] }
  if (!callTool) {
    log.error?.(
      `[credit] ⚠ ${candidates.length} read(s) came from a proxy log written before the ` +
        `refutation check (${candidates.join(', ')}) and no MCP transport is open, so the ledger ` +
        `fallback could not run. They are credited as ordinary reads; ` +
        `recount-outcomes.mjs re-derives them from the artefacts.`,
    )
    return { ids: sortedIds(exposed), ledgerChecked: 0, ledgerSkipped: candidates }
  }
  for (const id of candidates) {
    if (refutedBeforeTrial(await fetchEntryOutcome(callTool, id), trialStartMs, k)) exposed.add(id)
  }
  return { ids: sortedIds(exposed), ledgerChecked: candidates.length, ledgerSkipped: [] }
}

function sortedIds(set) {
  return [...set].sort((a, b) => a - b)
}

/**
 * Ids this log shows were USED, job-wide. The fallback twin of
 * [`servedMemoryIds`], for a log that cannot be split per trial.
 */
export function usedMemoryIds(proxyLogText) {
  return memoryIdsForKeys(proxyLogText, USED_KEYS)
}

/** Ids that were shown but never opened or written — reported, never credited. */
export function exposedOnly(servedIds, usedIds) {
  const used = new Set(usedIds)
  return servedIds.filter((id) => !used.has(id))
}

/** Shared line scanner for every id-bearing key the proxy writes. */
function memoryIdsForKeys(proxyLogText, keys) {
  const ids = new Set()
  for (const line of String(proxyLogText || '').split('\n')) {
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
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * Memory ids the proxy recorded as SERVED to the agent, deduplicated.
 *
 * Tolerates every other line shape in the log: the file is a mixed stream of
 * proxy diagnostics and only some lines are JSON.
 */
export function servedMemoryIds(proxyLogText) {
  const ids = new Set()
  for (const line of String(proxyLogText || '').split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    let obj
    try {
      obj = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    // ⛔ AUTHORED counts too. A lesson the trial WROTE is not in its `served`
    // set, so without this a failing attempt's own write-up enters the store
    // with no outcome and outranks rows that DO carry recorded failures.
    // MEASURED 2026-09-03 on extract-elf: the trial scored 0 for precisely the
    // approach it then filed as good practice ("only ~7% ... coverage stays
    // ~93% -- well over a 75% floor. Free removal of an entire failure mode.";
    // the grader measured 66.67%). The new row 26654 sat untouched at
    // success 0 / failure 0 while the four SERVED rows were debited.
    for (const key of ['served', 'authored']) {
      if (!Array.isArray(obj?.[key])) continue
      for (const id of obj[key]) if (Number.isInteger(id)) ids.add(id)
    }
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * The trial directory's own name, used as the observation's session id.
 *
 * Handles BOTH separators and a trailing one: `run-dg.sh` iterates the job
 * directory with a trailing-slash glob, so every path arrives ending in a
 * separator, and on Windows the same path can arrive with backslashes. Getting
 * this wrong yields an empty session id, which the tool rejects — the failure
 * mode this function exists to avoid.
 *
 * (Deliberately describing that glob in words: writing it literally would put a
 * comment-closing sequence inside this block and end the comment early, which
 * is exactly how the first version of this file failed to parse.)
 */
export function trialBasename(dir) {
  const parts = String(dir || '')
    .split(/[/\\]+/)
    .filter(Boolean)
  return parts[parts.length - 1] || 'trial'
}

/**
 * The call this would make. Separated from the doing so it can be asserted
 * without a brain, and so the dry run and the real run cannot diverge.
 */
export function verdictFor(reward) {
  return reward > 0 ? 'success' : 'failure'
}

export function buildObservation(reward, ids, trialName = 'trial') {
  if (reward === null || !ids.length) return null
  const verdict = verdictFor(reward)
  return {
    name: 'brain_observe_outcome',
    arguments: {
      // ⛔ session_id / context / action / response ARE REQUIRED, and omitting
      // them cost a run. The first version of this sent only `outcome` and
      // `used_memory_ids` — the two fields that do the crediting — and the tool
      // answered `missing required param: session_id`, so the attribution never
      // landed. It surfaced only because this script fails LOUD; a quiet
      // version would have reported success while writing nothing, which is the
      // exact defect it was built to remove.
      //
      // The trial name is the session id: unique per trial, so the tool's
      // "three identical consecutive observations" dead-end detector cannot be
      // tripped by this bookkeeping call, and any row it does write is
      // traceable back to the trial that caused it.
      session_id: `graded:${trialName}`,
      context: 'terminal-bench trial, graded by the task verifier',
      action: 'trial completed and scored',
      response: `reward=${reward} (${verdict})`,
      // The grader's verdict. A trial that scored 0 taught its inputs nothing
      // good, and that is precisely the signal the brain has never received.
      // Deliberately NOT 'fatal', which would ingest a negative memory at
      // importance 10 — a scored 0 is an ordinary graded result, not a
      // catastrophe, and inflating it would poison the store this exists to
      // keep honest.
      outcome: verdict,
      used_memory_ids: ids,
    },
  }
}

/**
 * The trial's own wall-clock window, as `{from_ms, to_ms}`, or null.
 *
 * ⛔ THE TRIAL-LEVEL WINDOW, NOT THE AGENT-EXECUTION ONE, AND THE TWO ARE USED
 * FOR DIFFERENT JOBS. `attribute-proxy-lines.mjs` splits the shared proxy log
 * by `agent_execution`, which is deliberately TIGHT: a wider window would
 * manufacture overlaps between trials that never ran at the same time, and
 * overlap makes attribution refuse.
 *
 * Stamping is the opposite problem. The ids are already attributed to exactly
 * one trial, so the only question left is which of THAT MEMORY's blocks this
 * trial wrote — and a block written during agent setup or flushed after the
 * agent exited is still this trial's block. `started_at` / `finished_at` are
 * the trial's own bounds and carry explicit `Z`, so `Date.parse` reads them as
 * UTC rather than as local time, which is what makes this comparable to the
 * server's `now_ms()`.
 */
export function trialWindow(result) {
  const from = Date.parse(result?.started_at ?? result?.agent_execution?.started_at ?? '')
  const to = Date.parse(result?.finished_at ?? result?.agent_execution?.finished_at ?? '')
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return { from_ms: from, to_ms: to }
}

/**
 * The `brain_stamp_outcome` calls this trial's verdict implies — one per
 * memory the trial AUTHORED. Separated from the sending so the dry run and the
 * real run cannot diverge, exactly as `buildObservation` is.
 */
export function buildStamps(ids, window, verdict, gradedAt) {
  if (!window || !ids.length) return []
  return ids.map((id) => ({
    name: 'brain_stamp_outcome',
    arguments: {
      id,
      from_ms: window.from_ms,
      to_ms: window.to_ms,
      // The grader's verdict, and NOTHING else. No score, no check names, no
      // message: the stamp says which way it went and when, which is the same
      // class of fact the attempt already receives (rules/bench-agi-purity.md).
      outcome: verdict,
      graded_at: gradedAt,
    },
  }))
}

/**
 * Every trial in the same job, as `{name, result}` — the set the attribution
 * needs in order to tell overlapping windows apart.
 *
 * A job dir that cannot be read yields an empty list, which `idsForTrial`
 * reports as unattributable rather than treating as "no other trials existed".
 */
export function readSiblingTrials(trialDir) {
  const jobDir = dirname(trialDir.replace(/[/\\]+$/, ''))
  const out = []
  try {
    for (const entry of readdirSync(jobDir)) {
      const dir = join(jobDir, entry)
      const resultPath = join(dir, 'result.json')
      if (!statSync(dir).isDirectory() || !existsSync(resultPath)) continue
      try {
        out.push({ name: entry, result: JSON.parse(readFileSync(resultPath, 'utf8')) })
      } catch {
        // A trial killed mid-write has no usable window; skip it rather than
        // aborting attribution for every other trial in the job.
      }
    }
  } catch {
    // No readable job dir — reported as unattributable by the caller.
  }
  return out
}

/**
 * A FAILURE THAT WAS NEVER A FAIR TEST MUST NOT BE CREDITED AS ONE.
 *
 * MEASURED 2026-09-08 across every graded-zero trial on disk. 40 trials never
 * ran at all (zero output tokens, 429 session limit or 401 revoked token) and
 * made ZERO real brain_search invocations — those were harmless here, and the
 * first measurement that said otherwise was counting the startup message's tool
 * MENU rather than actual calls (reference_advertisement_is_not_use).
 *
 * The 8 that matter are the ones the API cut off MID-RUN: every one of them had
 * already made a real brain_search, so every one of them debited the memories it
 * had been served for a task it was never allowed to finish. That is not a
 * rounding error, because of the mechanism this file's own header describes:
 * `confidence_buckets` requires failure_count == 0 for the clean-success bucket,
 * so a SINGLE false failure evicts a memory from the top bucket for good.
 *
 * A pass is always credited: reward > 0 needs no defence.
 */
function readResultJson(trialDir) {
  try {
    return JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'))
  } catch {
    // Fails safe towards crediting: an unreadable result must not silently
    // suppress a real signal, which would be the mirror of the bug above.
    return null
  }
}

async function main() {
  const [trialDir, proxyLog, ...rest] = process.argv.slice(2)
  if (!trialDir || !proxyLog) {
    console.error(
      'usage: credit-trial-outcome.mjs <trial-dir> <proxy-log> [--apply] [--dry-run] ' +
        '[--refute-watch] [--refute-observe]',
    )
    process.exit(2)
  }
  // `--dry-run` OVERRIDES `--apply` rather than conflicting with it, so a
  // caller can inspect what a live invocation would do by adding one flag to
  // the command it already runs, without editing the rest of it away.
  const dryRun = rest.includes('--dry-run')
  const apply = rest.includes('--apply') && !dryRun

  const reward = readReward(trialDir)
  if (reward === null) {
    console.error(`[credit] no readable verifier/reward.txt under ${trialDir} — nothing to attribute`)
    process.exit(0)
  }
  const result = readResultJson(trialDir)
  if (result !== null && !runWasSound(result, reward)) {
    const why = result?.exception_info?.exception_type ?? 'the agent never ran'
    console.error(
      `[credit] NOT CREDITED — this trial was not a fair test (${why}); ` +
        `scoring it as a failure would debit memories for a task the agent was ` +
        `never allowed to finish. See runWasSound() in trial-outcome.mjs.`,
    )
    process.exit(0)
  }
  const logText = existsSync(proxyLog) ? readFileSync(proxyLog, 'utf8') : ''

  // ── PER-TRIAL ATTRIBUTION (TBENCH-CREDIT-SCOPE-1) ─────────────────────────
  //
  // ⛔ `run-dg.sh` hands the SAME job-wide log to every trial in the batch, so
  // until now each trial credited its reward to every memory served to any
  // trial in the job. MEASURED 2026-09-03: 30 distinct ids attributed to each
  // of 10 trials — 300 credit operations, at most 30 of them right. In a mixed
  // batch a single failure debits the whole job's memories, and
  // `confidence_buckets` needs `failure_count == 0` for the clean-success
  // bucket, so one loss evicts them all. The signal was not just noisy, it was
  // anti-correlated with the trial that produced it.
  //
  // The fallback is deliberately LOUD. A log written by the pre-fix proxy has
  // no peer field and cannot be split; using the union silently would leave the
  // fix looking applied while the defect continued, which is the shape this
  // whole file was written to remove.
  const trialName = trialBasename(trialDir)
  const siblings = readSiblingTrials(trialDir)
  const attribution = idsForTrial(logText, trialName, siblings, USED_KEYS)
  // ⛔ STAMPING IS AUTHORED-ONLY AND ATTRIBUTED-ONLY. Under the job-wide
  // fallback below the ids include memories other trials wrote, and writing
  // this trial's verdict onto another trial's block is worse than writing
  // nothing: the mis-stamp is durable text that outlives the run, whereas the
  // missing stamp is merely the status quo.
  const authored = attribution.attributed
    ? idsForTrial(logText, trialName, siblings, ['authored']).ids
    : []
  let ids = attribution.ids
  let exposed = attribution.attributed
    ? exposedOnly(idsForTrial(logText, trialName, siblings, ['served']).ids, ids)
    : []
  const readIds = attribution.attributed
    ? idsForTrial(logText, trialName, siblings, ['read']).ids
    : readMemoryIds(logText)
  const readRefutedIds = attribution.attributed
    ? idsForTrial(logText, trialName, siblings, EXPOSED_KEYS).ids
    : exposedWhileRefutedIds(logText)
  if (!attribution.attributed) {
    ids = usedMemoryIds(logText)
    exposed = exposedOnly(servedMemoryIds(logText), ids)
    console.error(
      `[credit] ⚠ JOB-WIDE FALLBACK (${attribution.reason}) — crediting ${ids.length} ids from the ` +
        `whole job to ${trialName}. This over-attributes: the ids include memories other trials used.`,
    )
  } else if (attribution.reason) {
    console.error(`[credit] ⚠ ${trialName}: ${attribution.reason}`)
  }

  // ── OUTCOME-VISIBLE-6 ─────────────────────────────────────────────────────
  //
  // ⛔ THE TRANSPORT IS BUILT HERE, BEFORE THE DRY-RUN RETURN, AND ONLY THE
  // `--apply` PATH IS ALLOWED TO REQUIRE IT. The ledger fallback is a READ
  // (`brain_get_entry`), so a dry run may use it — and must, or the plan a dry
  // run prints would credit ids the live run excludes, which is precisely the
  // divergence `buildObservation` / `buildStamps` were split out to prevent. A
  // dry run with no MCP env simply reports the legacy reads as unchecked.
  const url = process.env.TERRANSOUL_MCP_URL
  const token = process.env.TERRANSOUL_MCP_TOKEN
  if (apply && (!url || !token)) {
    console.error('[credit] TERRANSOUL_MCP_URL / TERRANSOUL_MCP_TOKEN unset — refusing to guess')
    process.exit(3)
  }
  // One transport for every call, so no half of this script can drift into its
  // own slightly-different request shape.
  // ⛔ ONE TRANSPORT, AND IT IS THE ONE refutation-watch.mjs ALREADY EXPORTS.
  // This used to be a second inline `fetch` with the same headers and the same
  // JSON-RPC envelope — the drift the surrounding comment warns about, and it
  // drifted in the one dimension that matters for an unattended sweep: it had
  // NO TIMEOUT. undici's default headers timeout is 300 s, this runs at the END
  // of every trial, several calls deep, against a brain the trial may have just
  // outlived (the MCP idle watchdog has shut the brain down mid-trial before —
  // measured 2026-09-01, filter-js-from-html, where the Stop hook's own request
  // came back "upstream unreachable"). A brain that stalls rather than refuses
  // would add minutes of dead wait to each of 89 trials. The shared transport
  // bounds it and treats a timeout as non-fatal: the trial's result.json is
  // already written, so the cost is one credit call, not the run.
  const callTool = url && token ? transportFor(url, token, { label: 'credit' }) : null

  const exposure = await classifyExposedWhileRefuted({
    readIds,
    authored,
    readRefutedIds,
    legacyIds: legacyReadIds(logText),
    callTool,
    trialStartMs: Date.parse(result?.started_at ?? result?.agent_execution?.started_at ?? ''),
  })
  if (exposure.ids.length) {
    // ⛔ REMOVED FROM THE CREDIT SET, NOT DOWNGRADED. Neither success nor failure:
    // the reader was served the `[REFUTED …]` verdict and a graded index of the
    // entry's blocks, never the construction, so its grade is evidence about
    // neither direction. Stamping is already authored-only, and these ids are
    // authored by nobody here, so no `brain_stamp_outcome` can name them either.
    ids = ids.filter((id) => !exposure.ids.includes(id))
    console.log(
      `[credit] ${EXPOSED_WHILE_REFUTED}: ${exposure.ids.join(', ')} — read while the entry was ` +
        `refuted at threshold ${seededRefutationThreshold()}, so the tool surface served the ` +
        `verdict and a graded index rather than the body. Neither credited nor debited; only an ` +
        `AUTHORED graded success or an explicit recount releases a refuted entry.`,
    )
  }

  const obs = buildObservation(reward, ids, trialBasename(trialDir))
  if (!obs) {
    console.error(
      `[credit] reward=${reward} but this trial USED no memory ` +
        `(${exposed.length} were shown to it and not opened` +
        (exposure.ids.length ? `, ${exposure.ids.length} ${EXPOSED_WHILE_REFUTED}` : '') +
        `) — nothing to attribute`,
    )
    process.exit(0)
  }

  console.log(
    `[credit] reward=${reward} -> ${obs.arguments.outcome} for ${ids.length} used ` +
      `memor${ids.length === 1 ? 'y' : 'ies'}: ${ids.join(', ')}` +
      (exposed.length ? ` (exposed, not credited: ${exposed.length})` : '') +
      (exposure.ids.length ? ` (${EXPOSED_WHILE_REFUTED}: ${exposure.ids.length})` : ''),
  )

  // ── OUTCOME-VISIBLE-1: the verdict into the TEXT, not only the counters ──
  const window = trialWindow(result)
  const stamps = buildStamps(authored, window, verdictFor(reward), window?.to_ms)
  if (!window) {
    console.error(
      `[credit] no readable started_at/finished_at in result.json — cannot bound this ` +
        `trial's writes, so nothing is stamped (the counters above still landed)`,
    )
  } else if (!authored.length) {
    console.log(
      `[credit] nothing to stamp: this trial appended to or created no memory` +
        (attribution.attributed ? '' : ' that could be attributed to it'),
    )
  } else {
    console.log(
      `[credit] stamping ${stamps.length} authored memor${stamps.length === 1 ? 'y' : 'ies'} ` +
        `as ${verdictFor(reward)} over [${window.from_ms}, ${window.to_ms}]: ${authored.join(', ')}`,
    )
  }

  if (!apply) {
    console.log(`[credit] ${dryRun ? 'DRY RUN (--dry-run)' : 'DRY RUN'} — pass --apply to record it`)
    // ⛔ A DRY SWEEP IS STILL ALLOWED TO SEE. The watch's decision is computed
    // from the artifacts on disk — rewards, result timestamps and proxy rows —
    // and not from the ledger this run declined to write, so it is exactly the
    // decision a live run would have made. Recording it here is what makes
    // `stop-gate-audit.mjs`'s REFUTATION ALARMS line non-blind on a dry sweep;
    // no MCP transport is opened on this path at all.
    await runWatchStage({
      rest,
      trialDir,
      trialName,
      ids,
      attributed: attribution.attributed,
      callTool: null,
      apply: false,
    })
    return
  }

  const { res, text } = await callTool(obs)
  // Loud on failure: a silent no-op here would recreate the very defect this
  // script exists to fix — a feedback edge that reports success while writing
  // nothing.
  if (!res.ok || text.includes('"isError":true')) {
    console.error(`[credit] FAILED (${res.status}): ${text.slice(0, 300)}`)
    process.exit(4)
  }
  // ⛔ AND THIS SCRIPT REPRODUCED THAT DEFECT ONE LEVEL UP. Until 2026-09-02 it
  // printed "recorded" for ANY non-error response. But crediting is
  // CONDITIONAL inside the tool -- `if let (Some(success), Some(state)) =
  // (ledger_delta, app_state)` (mcp/tools.rs) -- so a response that credits
  // ZERO memories is still `ok` and still `isError:false`.
  //
  // MEASURED: the trial that prompted this printed "[credit] recorded" for 9
  // served ids, and the store held 0 of 2131 memories with failure_count > 0
  // afterwards. Re-running the identical command by hand later moved all of
  // them to 1. So the report was true about the HTTP call and false about the
  // write, which is the only thing anyone reads it for.
  //
  // The tool returns exactly what is needed to tell those apart, and it was
  // being thrown away. Parse it and hold the response to its own claim.
  let credited = null
  try {
    const inner = JSON.parse(JSON.parse(text)?.result?.content?.[0]?.text ?? '{}')
    if (Array.isArray(inner?.memories_credited)) credited = inner.memories_credited
  } catch {
    // Shape drift is itself a reason not to claim success.
  }
  if (credited === null) {
    console.error(`[credit] UNVERIFIED — no memories_credited in the response: ${text.slice(0, 300)}`)
    process.exit(5)
  }
  if (credited.length === 0) {
    console.error(
      `[credit] WROTE NOTHING — the brain credited 0 of ${ids.length} served memories. ` +
        `The call succeeded and the feedback edge is dead; do not read this run as having taught the store anything.`,
    )
    process.exit(6)
  }
  const missed = ids.filter((id) => !credited.includes(id))
  console.log(
    `[credit] recorded — ${credited.length}/${ids.length} credited` +
      (missed.length ? ` (not credited: ${missed.join(', ')})` : ''),
  )

  // ── STAMP ───────────────────────────────────────────────────────────────
  //
  // LOUD, LIKE EVERY OTHER EDGE IN THIS FILE, BUT NOT FATAL. The counters are
  // already written by the time we get here; exiting non-zero would tell the
  // caller the crediting failed when it did not. A stamp that silently did
  // nothing is the exact defect class this file was built to remove, so each
  // one reports what the server said it changed.
  let stampedBlocks = 0
  for (const stamp of stamps) {
    const { res: sres, text: stext } = await callTool(stamp)
    if (!sres.ok || stext.includes('"isError":true')) {
      console.error(
        `[credit] ⚠ STAMP FAILED for memory ${stamp.arguments.id} (${sres.status}): ${stext.slice(0, 200)}`,
      )
      continue
    }
    let inner = null
    try {
      inner = JSON.parse(JSON.parse(stext)?.result?.content?.[0]?.text ?? '{}')
    } catch {
      // Shape drift is itself a reason not to claim the stamp landed.
    }
    if (typeof inner?.blocks_stamped !== 'number') {
      console.error(
        `[credit] ⚠ STAMP UNVERIFIED for memory ${stamp.arguments.id} — no blocks_stamped in the response`,
      )
      continue
    }
    stampedBlocks += inner.blocks_stamped
    if (!inner.changed) {
      console.log(`[credit] memory ${stamp.arguments.id} already carried this verdict`)
    }
  }
  if (stamps.length) {
    console.log(
      `[credit] stamped ${stampedBlocks} block(s) across ${stamps.length} authored memor${stamps.length === 1 ? 'y' : 'ies'}`,
    )
  }

  // ── H4: THE ONLINE REFUTATION WATCH ───────────────────────────────────────
  //
  // ⛔ ORDERING IS LOAD-BEARING. It runs AFTER this trial's own verdict has been
  // credited and stamped: the cohort it reads has to include the trial that just
  // finished, or the window is short by one and the alarm fires a trial late.
  await runWatchStage({
    rest,
    trialDir,
    trialName,
    ids,
    attributed: attribution.attributed,
    callTool,
    apply: true,
  })
}

// ── THE WATCH STAGE ────────────────────────────────────────────────────────
  //
  // ⛔ ORDERING IS LOAD-BEARING AND THIS IS WHY THE WATCH LIVES HERE RATHER
  // THAN IN ITS OWN LOOP IN `run-dg.sh`. The cohort it reads includes THIS
  // trial's verdict, which the block above has only just recorded; run one step
  // earlier the window is short by one and the alarm fires a trial late. A
  // second scan from the shell would also re-walk the corpus for no gain, and
  // would open a second transport to the same brain.
  //
  // It reuses the transport already proved by the crediting call above, so it
  // can only ever reach the port this invocation was pointed at — the isolated
  // bench brain, never the production tray.
// ⛔ EXPORTED SO THE KILL SWITCH CAN BE TESTED BY BEHAVIOUR RATHER THAN BY GREP.
// `escalation-wiring.test.sh` greps this file for the literal
// `rest.includes('--refute-observe')`, which is a claim about TEXT: it stays green
// on a line that is present and unreachable, and it is not in the node suite. The
// switch decides whether a sweep writes to a brain, so the suite now drives this
// function with a recording transport and asserts ZERO calls in observe mode.
// `cfg` and `log` exist for that: they are the same two injection points
// `runRefutationWatch` already takes, so a test cannot be decided by the
// TB_REFUTE_* values in the shell that ran it, or by console capture.
export async function runWatchStage({
  rest,
  trialDir,
  trialName,
  ids,
  attributed,
  callTool,
  apply,
  cfg = undefined,
  log = console,
}) {
  if (!rest.includes('--refute-watch')) return
  if (!attributed) {
    log.error?.(
      `[refute] skipped for ${trialName}: the job log could not be split per trial, so the ids ` +
        `credited above are a job-wide union and are not this trial's use record`,
    )
    return
  }
  // <base>/jobs*/<job>/<trial> — the directory the `jobs*` roots live under.
  //
  // ⛔ THE WATCH SAYS SO WHEN IT SCANNED NOTHING. `run-dg.sh` honours
  // TB_JOBS_DIR, and the scan keeps only roots whose name begins with `jobs`, so
  // a sweep pointed elsewhere resolves to zero roots. That is reported as
  // `scanned nothing` rather than as `no credible base rate` — one is a
  // measurement, the other a misconfiguration, and a detector whose silence is
  // indistinguishable from its absence cannot be audited afterwards.
  const base = dirname(dirname(dirname(trialDir.replace(/[/\\]+$/, ''))))
  // ⛔ AN OBSERVE-ONLY ARM MUST EXIST, OR THE NON-INDEPENDENCE CANNOT BE
  // MEASURED. `--refute-observe` runs the detector and writes its alert row but
  // sends no recount, so a sweep can record what the watch WOULD have done
  // without any trial in it being affected by a repair an earlier trial
  // triggered. `run-dg.sh` reaches it with TB_REFUTE_WATCH=observe.
  // Observe-only is reached three ways and they mean the same thing: the flag,
  // TB_REFUTE_WATCH=observe from the sweep, and a credit that is not applying
  // anything at all (`--dry-run`, or no `--apply`). The DECISION is identical in
  // every case — the cohort is read from the artifacts on disk, not from the
  // ledger — so a dry sweep can record exactly what a live one would have done.
  const watchApplies = apply && !rest.includes('--refute-observe')
  if (!watchApplies) {
    log.log?.(
      `[refute] OBSERVE-ONLY (${apply ? '--refute-observe' : 'the credit itself is dry'}): ` +
        `decisions are recorded, no recount is sent`,
    )
  }
  try {
    const watch = await runRefutationWatch({
      base,
      trialDir,
      memoryIds: ids,
      apply: watchApplies,
      callTool,
      cfg,
      log,
    })
    if (watch.rows.some((r) => r.scanned_jobs === 0)) {
      log.error?.(
        `[refute] ⚠ SCANNED NOTHING under ${base} — no directory there is named with the 'jobs' ` +
          `prefix, so the cohort is empty for a reason that has nothing to do with any memory. ` +
          `Point the sweep's jobs root (TB_JOBS_DIR) at a directory the watch can find.`,
      )
    }
  } catch (e) {
    // A bookkeeping write must never be able to fail a measured trial, and the
    // counters above have already landed.
    log.error?.(`[refute] ⚠ watch failed (non-fatal): ${e?.message ?? e}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('credit-trial-outcome.mjs')) {
  main().catch((e) => {
    console.error(`[credit] ${e?.message ?? e}`)
    process.exit(1)
  })
}
