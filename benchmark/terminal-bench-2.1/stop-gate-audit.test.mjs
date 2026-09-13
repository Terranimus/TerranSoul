#!/usr/bin/env node
/**
 * Tests for `stop-gate-audit.mjs` — the instrument that measures whether the
 * verify-before-stop gate enforces anything.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: `stop-gate-audit.mjs` did not exist.
 * There was no cross-trial reader of stop-block marks at all, which is the gap
 * these tests describe.
 *
 * They are built from fixture transcripts, not from the corpus: a test that
 * asserts against the live `jobs/` tree passes or fails on which benchmark ran
 * last, and would go green on an EMPTY corpus — the same "measured on an empty
 * table" defect `rules/no-unexercised-features.md` was written for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  turnText,
  isStopBlockTurn,
  blockKind,
  hasToolUse,
  auditTranscript,
  rewardOf,
  summarise,
  toolResultText,
  REFUTED_BANNER_PREFIX,
} from './stop-gate-audit.mjs'
import { readFileSync } from 'node:fs'
import {
  STOP_FEEDBACK_PREFIX,
  JUDGE_BLOCK_PREFIX,
  LEDGER_BLOCK_PREFIX,
} from '../../packages/terransoul-cli/src/stop-hook.mjs'

const userTurn = (text) => ({ type: 'user', message: { content: text } })
const userBlocks = (text) => ({ type: 'user', message: { content: [{ type: 'text', text }] } })
const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const assistantTool = (name) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input: {} }] },
})
const blocked = (prefix) => userTurn(`${STOP_FEEDBACK_PREFIX} ${prefix}: not done.`)

test('a turn is read whether its content is a string or a block array', () => {
  // Claude Code writes both shapes. A reader that handles one silently sees
  // half the transcript and reports a clean bill of health on a blocked trial.
  assert.equal(turnText(userTurn('hello')), 'hello')
  assert.equal(turnText(userBlocks('hello')), 'hello')
  assert.equal(turnText({ type: 'user' }), '')
  assert.equal(turnText(null), '')
})

test('only the harness re-injection counts as a block, not an agent mentioning it', () => {
  assert.equal(isStopBlockTurn(blocked(JUDGE_BLOCK_PREFIX)), true)
  // An ASSISTANT turn quoting the prefix is the agent talking about the gate,
  // not the gate firing — counting it would inflate enforcement with chatter.
  assert.equal(
    isStopBlockTurn({ type: 'assistant', message: { content: `${STOP_FEEDBACK_PREFIX} whatever` } }),
    false,
  )
  assert.equal(isStopBlockTurn(userTurn('ordinary user text')), false)
})

test('the two halves of the hook are distinguished', () => {
  // They have different fixes: a judge block is a verdict on the work, a ledger
  // block is a staleness/bookkeeping decision. Pooling them hides which fired.
  assert.equal(blockKind(blocked(JUDGE_BLOCK_PREFIX)), 'judge')
  assert.equal(blockKind(blocked(LEDGER_BLOCK_PREFIX)), 'ledger')
  assert.equal(blockKind(blocked('some future reason')), 'other')
})

test('resumedAfterBlock is true only when a TOOL CALL follows the last block', () => {
  const resumed = auditTranscript([
    assistantTool('Bash'),
    blocked(JUDGE_BLOCK_PREFIX),
    assistantTool('Bash'),
  ])
  assert.equal(resumed.resumedAfterBlock, true)

  // ⛔ THE CASE THE WHOLE FIELD EXISTS FOR: the agent was told to check its work
  // and answered with prose. That is the failure the block is meant to prevent,
  // and it is invisible in a block count.
  const talked = auditTranscript([
    assistantTool('Bash'),
    blocked(JUDGE_BLOCK_PREFIX),
    assistantText('You are right, it is complete.'),
  ])
  assert.equal(talked.resumedAfterBlock, false)
})

test('work before an EARLIER block does not count as resuming after the last one', () => {
  // An agent blocked twice that worked after the first and only talked after
  // the second still ended by giving up.
  const a = auditTranscript([
    blocked(JUDGE_BLOCK_PREFIX),
    assistantTool('Bash'),
    blocked(LEDGER_BLOCK_PREFIX),
    assistantText('done'),
  ])
  assert.equal(a.blockCount, 2)
  assert.deepEqual(a.blocks, ['judge', 'ledger'])
  assert.equal(a.resumedAfterBlock, false)
})

test('a trial with no blocks reports none and never claims a resume', () => {
  const a = auditTranscript([assistantTool('Bash'), assistantText('done')])
  assert.equal(a.blockCount, 0)
  assert.equal(a.assistantTurns, 2)
  // Guards the `lastBlockIndex >= 0` condition: without it, slice(0) scans the
  // whole transcript and every tool-using trial reports a phantom resume.
  assert.equal(a.resumedAfterBlock, false)
})

test('the graded reward is read from the verifier, not from any agent claim', () => {
  assert.equal(rewardOf({ verifier_result: { rewards: { reward: 1 } } }), 1)
  assert.equal(rewardOf({ verifier_result: { rewards: { reward: 0 } } }), 0)
  assert.equal(rewardOf({}), null)
  assert.equal(rewardOf({ verifier_result: {} }), null)
})

test('the silent give-up cell counts reward-0 trials that were never blocked', () => {
  const rows = [
    { reward: 1, blockCount: 0, resumedAfterBlock: false, blocks: [] },
    { reward: 1, blockCount: 2, resumedAfterBlock: true, blocks: ['judge', 'judge'] },
    { reward: 0, blockCount: 0, resumedAfterBlock: false, blocks: [] },
    { reward: 0, blockCount: 0, resumedAfterBlock: false, blocks: [] },
    { reward: 0, blockCount: 1, resumedAfterBlock: false, blocks: ['ledger'] },
    { reward: null, blockCount: 0, resumedAfterBlock: false, blocks: [] },
  ]
  const s = summarise(rows)
  assert.equal(s.passNoBlock, 1)
  assert.equal(s.passBlocked, 1)
  assert.equal(s.failNoBlock, 2)
  assert.equal(s.failBlocked, 1)
  // ⛔ The ungraded trial is EXCLUDED from the denominator. An ungraded trial is
  // an infrastructure failure; counting it as a silent give-up blames the gate
  // for a container that never ran.
  assert.equal(s.graded, 5)
  assert.equal(s.ungraded, 1)
  assert.equal(s.silentGiveUpRate, 2 / 5)
  assert.equal(s.gateReach, 2 / 5)
  assert.equal(s.resumedAfterBlock, 1)
  assert.deepEqual(s.byKind, { judge: 2, ledger: 1 })
})

test('an empty corpus reports zero rates rather than dividing by zero', () => {
  const s = summarise([])
  assert.equal(s.silentGiveUpRate, 0)
  assert.equal(s.gateReach, 0)
  assert.equal(s.graded, 0)
})

// ── EVIDENCE TRAIL (the reader for the proxy's `verify` lines) ──────────────
//
// FAILS ON THE PRE-CHANGE TREE: `evidenceTrail`/`evidenceSplit` did not exist,
// and neither did the `verify` lines they read — the proxy logged that
// brain_verify_completion was CALLED but never what it decided.
import { evidenceTrail, evidenceSplit } from './stop-gate-audit.mjs'

const vline = (o) => `[tb-proxy] ${JSON.stringify(o)}`

test('the ledger classification and proof quality are counted', () => {
  const log = [
    vline({ verify: 'record', status: 'passed', scope: 'full', command: 'pytest' }),
    vline({ verify: 'record', status: 'failed', scope: 'targeted', evidence: 'self_selected' }),
    vline({ verify: 'status', state: 'stale' }),
    '[tb-proxy] {"tool":"brain_search","allowed":true}',
    'not json',
  ].join(String.fromCharCode(10))
  const t = evidenceTrail(log, 1)
  assert.equal(t.attributed, true)
  assert.deepEqual(t.ops, { record: 2, status: 1 })
  assert.deepEqual(t.status, { passed: 1, failed: 1 })
  assert.deepEqual(t.scope, { full: 1, targeted: 1 })
  assert.deepEqual(t.evidence, { self_selected: 1 })
})

test('a JUDGE verdict is counted distinctly from the ledger statuses', () => {
  // The judge's boolean is the only status reflecting a reasoned opinion; it
  // must not be lost among the ledger's structural passed/failed counts.
  const log = [
    vline({ verify: 'verify', verified: true, method: 'llm_judge' }),
    vline({ verify: 'record', status: 'passed' }),
  ].join(String.fromCharCode(10))
  const t = evidenceTrail(log, 1)
  assert.deepEqual(t.status, { passed: 1, 'judge:true': 1 })
})

test('a MULTI-TRIAL job is unattributable, not silently pooled', () => {
  // ⛔ The attribution discipline. A job with several trials has one shared
  // proxy log and no field identifies a trial within it — every container
  // reaches the host as 127.0.0.1 (measured). Counting the trail anyway would
  // credit each trial with every other trial's evidence.
  const log = vline({ verify: 'record', status: 'passed' })
  const t = evidenceTrail(log, 4)
  assert.equal(t.attributed, false)
  assert.deepEqual(t.ops, {})
  assert.deepEqual(t.status, {})
})

test('the split compares PASSED against FAILED and excludes the unattributable', () => {
  const row = (reward, evidence) => ({ reward, evidence })
  const trail = (status) => ({ attributed: true, ops: { record: 1 }, status, evidence: {}, scope: {} })
  const s = evidenceSplit([
    row(1, trail({ passed: 2 })),
    row(1, trail({ passed: 1 })),
    row(0, trail({ failed: 3 })),
    row(0, { attributed: false, ops: {}, status: {}, evidence: {}, scope: {} }),
  ])
  assert.equal(s.passed.trials, 2)
  assert.equal(s.failed.trials, 1)
  assert.deepEqual(s.passed.status, { passed: 3 })
  assert.deepEqual(s.failed.status, { failed: 3 })
  // The unattributable row lands in neither side, and is reported separately so
  // its absence is visible rather than silent.
  assert.equal(s.unattributable, 1)
})

test('an attributable trial with no verify lines is counted, not dropped', () => {
  // Trials from before the verdict logging are attributable but have no trail.
  // Dropping them would understate the denominator and inflate every rate.
  const s = evidenceSplit([{ reward: 1, evidence: evidenceTrail('', 1) }])
  assert.equal(s.passed.trials, 1)
  assert.deepEqual(s.passed.ops, {})
})

// ── WHAT THE ONE BLOCK WAS SPENT ON, RECOMPUTED ────────────────────────────
//
// ⛔ WHY THE MARKER READERS ARE GONE. The first version of this table imported
// `ANCHOR_NOTE_MARKER` / `REFUTED_NOTE_MARKER` from the sibling (uncommitted)
// `stop-hook.mjs` with a placeholder fallback, and counted string containment.
// Three things were wrong with that and only one of them was visible:
//
//   1. the constant does not exist at HEAD, so on the committed tree the whole
//      unanchored column was structurally 0 while looking measured;
//   2. every behavioural test injected its own synthetic marker object, so the
//      suite stayed green whatever the hook did — the fixture, not the
//      assertion, was carrying the test;
//   3. the marker rides a note the hook wrote, so the table measured OUR OWN
//      ANNOUNCEMENT rather than the judge's verdict. An announcement is not a
//      measurement (`reference_advertisement_is_not_use`).
//
// Anchoring is a pure function of data the ledger already holds: the judge's
// recorded `reason`, the task's own `instruction.md`, and the evidence strings
// the judge saw. So it is RECOMPUTED here with the same `judgeClaimAnchor` the
// hook uses. The audit can then answer the question on any corpus, including
// every trial that ran before the hook ever stamped anything.
//
// M3, the measurement this table exists to make routine: 862 ledger judge rows,
// 644 mapped to a trial, 165 negative, 29 of them the already-fail-open
// `verdict_absent` shape, leaving 136 that spend a LIVE block — 110 on trials
// that ULTIMATELY PASSED. Blocking precision is at best 18.4%, so the budget
// must stay 1 and the question is what the single block is SPENT ON.
import {
  judgeDecisionTable,
  judgeVerdictsFrom,
  anchorJudgeDecisions,
  readGoal,
  goalForTrial,
  readRefutationAlarms,
} from './stop-gate-audit.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⛔ A SYNTHETIC GOAL, ON PURPOSE. The first version of this fixture was
// near-verbatim text from a benchmark task's own instruction.md. Nothing reads
// it but this file and nothing seeds it into a brain, so the effect was nil —
// but a test corpus that quotes the benchmark is one edit away from being a
// place task text is kept, and the anchoring rules under test are entirely
// generic. This goal exercises the same three shapes (a path token, a quotable
// span, a four-word shingle) and belongs to no task.
const GOAL =
  'Write a command line tool at /srv/tools/tabulate.py that reads every measurement file under ' +
  '/srv/input and writes one summary row per file to /srv/output/summary.csv.'
const vrow = (o) => `[tb-proxy] ${JSON.stringify(o)}`

/** A judge verdict row exactly as the proxy records it. */
const verdict = (reason, verified = false) =>
  vrow({ verify: 'verify', verified, method: 'llm_judge', reason, at: '2026-09-11T17:33:26.926Z' })

test('judge_decisions_are_recomputed_from_the_ledger_not_from_a_marker', () => {
  // FAILS ON THE PRE-CHANGE TREE: `judgeVerdictsFrom` and `anchorJudgeDecisions`
  // do not exist, and the pre-change table split blocks on a marker that the
  // shipped hook never puts on a block, so its anchored column was 0 by
  // construction on every real trial.
  const anchored = anchorJudgeDecisions(
    judgeVerdictsFrom(verdict('There is no verification that tabulate.py was ever run.'), 1),
    GOAL,
  )
  const unanchored = anchorJudgeDecisions(
    judgeVerdictsFrom(verdict("The GOAL specifically requires that the 'type' column be rewritten."), 1),
    GOAL,
  )
  assert.equal(anchored.length, 1)
  assert.equal(anchored[0].anchored, true)
  assert.equal(unanchored[0].anchored, false)

  const t = judgeDecisionTable([
    { reward: 1, judge: { decisions: anchored } },
    { reward: 0, judge: { decisions: unanchored } },
    { reward: 0, judge: { decisions: anchored } },
    { reward: 1, judge: { decisions: unanchored } },
    // An ungraded trial has no cell: scoring it would blame the judge for a
    // container that never ran.
    { reward: null, judge: { decisions: unanchored } },
  ])
  assert.equal(t.anchoredOnPassing, 1)
  assert.equal(t.anchoredOnFailing, 1)
  assert.equal(t.unanchoredOnPassing, 1)
  assert.equal(t.unanchoredOnFailing, 1)
  assert.equal(t.negativeVerdicts, 5)
  assert.equal(t.ungraded, 1)
  // THE RESIDUAL IS PRINTED AND THE TABLE RECONCILES. A residual nobody checks
  // is how a four-cell table quietly stops accounting for its own population.
  assert.equal(
    t.anchoredOnPassing + t.anchoredOnFailing + t.unanchoredOnPassing + t.unanchoredOnFailing +
      t.ungraded + t.goalMissing + t.verdictAbsent,
    t.negativeVerdicts,
  )
})

test('an APPROVED verdict is not a decision any block was spent on', () => {
  const rows = judgeVerdictsFrom(
    [verdict('all good', true), verdict('There is no verification that tabulate.py was run.')].join('\n'),
    1,
  )
  assert.equal(rows.length, 2)
  const t = judgeDecisionTable([{ reward: 0, judge: { decisions: anchorJudgeDecisions(rows, GOAL) } }])
  assert.equal(t.verdicts, 2)
  assert.equal(t.negativeVerdicts, 1)
  assert.equal(t.anchoredOnFailing, 1)
})

test('an_absent_goal_is_a_RESIDUAL_not_an_unanchored_verdict', () => {
  // ⛔ THE GATE THAT CANNOT FAIL, CLOSED. With no recoverable task statement
  // every objection comes back unanchored by construction, so pooling those
  // into the unanchored column would report "the judge objects without the
  // goal" on every trial whose instruction file we could not read.
  const decisions = anchorJudgeDecisions(judgeVerdictsFrom(verdict('anything at all'), 1), '')
  assert.equal(decisions[0].goalAnchorable, false)
  assert.equal(decisions[0].anchored, null)
  const t = judgeDecisionTable([{ reward: 0, judge: { decisions } }])
  assert.equal(t.goalMissing, 1)
  assert.equal(t.unanchoredOnFailing, 0)
  assert.equal(t.anchoredOnFailing, 0)
})

test('a verdict with no reason is the verdict_absent shape, counted apart', () => {
  // It already fails open in the hook (29 of 165 negative rows in M3), so
  // pooling it with real objections would inflate whichever column it landed in.
  const t = judgeDecisionTable([
    { reward: 0, judge: { decisions: anchorJudgeDecisions(judgeVerdictsFrom(verdict('   '), 1), GOAL) } },
  ])
  assert.equal(t.verdictAbsent, 1)
  assert.equal(t.unanchoredOnFailing, 0)
})

test('hardTokensUnbacked is RECOMPUTED from the reason and the goal, never read from a row', () => {
  // ⛔ READER WITH NO WRITER, CLOSED. The previous version counted a
  // `hardTokensUnbacked` key on the proxy rows. Nothing writes that key: the
  // only producer puts it on the hook's stderr note, and
  // `grep -c hardTokensUnbacked` over a real terransoul-proxy-calls.jsonl is 0.
  // So the printed number was structurally zero while looking measured. Here the
  // row CLAIMS the field and it is ignored — the count comes from the reason.
  const claimed = vrow({
    verify: 'verify',
    verified: false,
    reason: 'There is no verification that tabulate.py was ever run.',
    hardTokensUnbacked: ['0.5', 'IoU', 'nonsense'],
  })
  const backed = anchorJudgeDecisions(judgeVerdictsFrom(claimed, 1), GOAL)
  assert.equal(backed[0].hardTokensUnbacked.length, 0, 'the row field is not consulted')
  const unbacked = anchorJudgeDecisions(
    judgeVerdictsFrom(verdict("The GOAL specifically requires that the 'type' column be rewritten."), 1),
    GOAL,
  )
  assert.ok(unbacked[0].hardTokensUnbacked.length > 0)
  const t = judgeDecisionTable([
    { reward: 1, judge: { decisions: backed } },
    { reward: 0, judge: { decisions: unbacked } },
  ])
  assert.equal(t.hardTokensUnbacked, 1)
})

test('the judge saw the evidence the trial filed, and it is passed to the anchor test', () => {
  // `judgeClaimAnchor(reason, goal, evidence)` — the js workstream's extended
  // signature. The evidence strings are the `record` rows' own commands, which
  // is what the judge was shown; a containment test that ignores them cannot
  // tell "quoted the goal" from "quoted the proof".
  const log = [
    vrow({ verify: 'record', evidence: 'self_selected', status: 'passed', scope: 'targeted', command: 'bash /tmp/run_harness.sh' }),
    verdict('There is no verification that tabulate.py was ever run.'),
  ].join('\n')
  const rows = judgeVerdictsFrom(log, 1)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].evidence, ['bash /tmp/run_harness.sh'])
})

test('a MULTI-TRIAL job yields no judge decisions rather than a plausible guess', () => {
  // The same attribution discipline the evidence trail already applies: one
  // shared proxy log, no field identifying a trial within it.
  assert.deepEqual(judgeVerdictsFrom(verdict('x'), 2), [])
})

test('the goal is read from the task directory with its CR stripped', () => {
  // The task clone is CRLF. A goal carrying stray CRs normalises to the same
  // text here, but reading it raw would put them into every printed excerpt.
  const root = mkdtempSync(join(tmpdir(), 'sga-tasks-'))
  mkdirSync(join(root, 'demo-task'), { recursive: true })
  writeFileSync(join(root, 'demo-task', 'instruction.md'), 'line one\r\nline two\r\n')
  assert.equal(readGoal('demo-task', root), 'line one\nline two')
  assert.equal(readGoal('absent-task', root), '')
})

test('the goal is found by the PATH the runner recorded, not by the namespaced task name', () => {
  // ⛔ MEASURED ON A REAL result.json: `task_name` is
  // 'terminal-bench/sam-cell-seg' while the directory is `sam-cell-seg`, and
  // `task_id.path` names it outright. Joining the namespaced name onto the tasks
  // root finds nothing — and a missing goal makes EVERY verdict unanchorable, so
  // this lookup is the difference between a measured column and a residual.
  const root = mkdtempSync(join(tmpdir(), 'sga-tasks2-'))
  mkdirSync(join(root, 'sam-cell-seg'), { recursive: true })
  writeFileSync(join(root, 'sam-cell-seg', 'instruction.md'), 'the real goal text\r\n')
  assert.equal(readGoal('terminal-bench/sam-cell-seg', root), '', 'the namespaced name is not a directory')
  assert.equal(
    goalForTrial({ task_name: 'terminal-bench/sam-cell-seg' }, 'sam-cell-seg__abc', root),
    'the real goal text',
  )
  assert.equal(
    goalForTrial({ task_id: { path: join(root, 'sam-cell-seg') } }, 'x__y', root),
    'the real goal text',
  )
  assert.equal(goalForTrial({}, 'nothing__y', root), '')
})

test('the module exports no marker readers at all', async () => {
  // ⛔ THE REGRESSION GUARD FOR THE WHOLE REPAIR. A reader coupled to an
  // uncommitted constant in another workstream is a column that reads 0 forever
  // if that workstream is dropped, and no behavioural test can see it because
  // every fixture injects its own marker.
  const m = await import('./stop-gate-audit.mjs')
  assert.equal(m.ANCHOR_NOTE_MARKER, undefined)
  assert.equal(m.REFUTED_NOTE_MARKER, undefined)
  assert.equal(m.MARKERS_FROM_HOOK, undefined)
  assert.equal(m.hookNotes, undefined)
})

test('refutation alarms are read back from each job, firing rows only', () => {
  // A sweep that refuted a memory and did not say so is the same gap one level
  // down from the one this whole workstream closes.
  const base = mkdtempSync(join(tmpdir(), 'sga-'))
  const job = join(base, 'job-a')
  mkdirSync(job, { recursive: true })
  writeFileSync(
    join(job, 'memory-refutation-alerts.jsonl'),
    [
      JSON.stringify({ at: '2026-09-07T03:18:00Z', memory_id: 4242, task: 'seg', streak: 2, p: 0.0204, fires: true, applied: true }),
      JSON.stringify({ at: '2026-09-07T04:18:00Z', memory_id: 4243, task: 'seg', streak: 1, p: 0.1429, fires: false, applied: false }),
      'not json',
    ].join(String.fromCharCode(10)),
  )
  const alarms = readRefutationAlarms(base)
  assert.equal(alarms.length, 1)
  assert.equal(alarms[0].memory_id, 4242)
  assert.equal(alarms[0].streak, 2)
  assert.equal(alarms[0].job, 'job-a')
})

test('a jobs tree with no alert logs yields no alarms rather than throwing', () => {
  const base = mkdtempSync(join(tmpdir(), 'sga-empty-'))
  mkdirSync(join(base, 'job-b'), { recursive: true })
  assert.deepEqual(readRefutationAlarms(base), [])
  assert.deepEqual(readRefutationAlarms(join(base, 'does-not-exist')), [])
})

test('the evidence the judge saw is CONSULTED, not merely carried — provenance proves it', () => {
  // ⛔ THE WIRING THAT NOTHING COULD FAIL ON. `judgeVerdictsFrom` attaches the
  // evidence strings and `anchorJudgeDecisions` passes them to the anchor test,
  // but until the provenance was kept, dropping that third argument changed no
  // field any reader could see — a writer with no reader, in the one place where
  // it inverts a verdict. An objection grounded in the session's OWN failing
  // output is the opposite of an invented requirement, and with the goal as the
  // only haystack it scores as invented.
  //
  // The quoted span below appears in the COMMAND the trial filed and NOWHERE in
  // the goal, so `anchored` can only be true if the evidence reached the rule.
  const log = [
    vrow({ verify: 'record', command: 'pytest -k alignment --maxfail=1 --disable-warnings' }),
    verdict('The run ended with "pytest -k alignment --maxfail=1" still reporting a failure.'),
  ].join('\n')
  const rows = judgeVerdictsFrom(log, 1)
  assert.deepEqual(rows[0].evidence, ['pytest -k alignment --maxfail=1 --disable-warnings'])

  const withEvidence = anchorJudgeDecisions(rows, GOAL)
  assert.equal(withEvidence[0].anchored, true)
  assert.equal(withEvidence[0].source, 'evidence', 'anchored by the evidence, not by the goal')

  // The same reason with the evidence removed is UNANCHORED — which is what the
  // audit would have reported for every such verdict had the argument been dropped.
  const withoutEvidence = anchorJudgeDecisions([{ ...rows[0], evidence: [] }], GOAL)
  assert.equal(withoutEvidence[0].anchored, false)

  // And the table counts the split, so the difference is visible in the output a
  // sweep prints rather than only in a field.
  const t = judgeDecisionTable([{ reward: 0, judge: { decisions: withEvidence } }])
  assert.equal(t.anchoredOnFailing, 1)
  assert.equal(t.anchoredViaEvidence, 1)
  assert.equal(judgeDecisionTable([{ reward: 0, judge: { decisions: withoutEvidence } }]).anchoredViaEvidence, 0)
})

test('the REFUTED banner is counted where it was SERVED, never where the agent quoted it', () => {
  // ⛔ THE SERVED CONSEQUENCE, WHICH NOTHING MEASURED. The watch records that it
  // decided and the alert jsonl records that it acted; neither can say whether a
  // later trial was ever handed the banner those counters produce. Only the
  // transcript holds that, and only tool RESULTS are the product talking: an
  // agent quoting the banner back is evidence it read one, not evidence one was
  // served, and counting that would let the model inflate a measurement of the
  // serving layer.
  const served = (text) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] },
  })
  const events = [
    served('[GRADED failure 2026-09-11]\n[REFUTED · 8 graded failures since the last graded success]\nbody'),
    served('[RECOUNTED 2 success / 8 failure · recount:jobs 2026-09-12]\nanother row'),
    assistantText('I see a [REFUTED ...] banner on that entry, so I will ignore it.'),
  ]
  const audit = auditTranscript(events)
  assert.equal(audit.refutedBanners, 1, 'the assistant quoting it is not a serving')
  assert.equal(audit.recountNotes, 1)

  const s = summarise([
    { reward: 0, blockCount: 0, blocks: [], ...audit },
    { reward: 1, blockCount: 0, blocks: [], refutedBanners: 0, recountNotes: 0 },
  ])
  assert.equal(s.refutedBannerTrials, 1)
  assert.equal(s.refutedBannerRows, 1)
  assert.equal(s.recountNoteRows, 1)

  // A tool result carrying a plain string, which is the other shape the
  // transcript uses, is read the same way.
  assert.equal(
    toolResultText({ type: 'user', message: { content: [{ type: 'tool_result', content: '[REFUTED x]' }] } }),
    '[REFUTED x]',
  )
})

test('the banner literal is the one the STORE writes, checked against the Rust source', () => {
  // ⛔ A CONSTANT DUPLICATED ACROSS A LANGUAGE BOUNDARY IS A COUNTER THAT CAN GO
  // SILENTLY TO ZERO. `crates/memory/src/outcome_stamp.rs` owns the banner; this
  // module re-declares it because JS cannot import a Rust const. So the test
  // reads the Rust file: a rename there fails HERE, loudly, instead of turning
  // the served-consequence metric into a structural zero — which is exactly what
  // happened to the marker-based column this audit replaced.
  const repo = join(import.meta.dirname, '..', '..')
  const src = readFileSync(join(repo, 'crates', 'memory', 'src', 'outcome_stamp.rs'), 'utf8')
  const m = src.match(/REFUTED_BANNER_PREFIX: &str = "([^"]+)"/)
  assert.ok(m, 'outcome_stamp.rs no longer declares REFUTED_BANNER_PREFIX — the banner metric has nothing to read')
  assert.equal(REFUTED_BANNER_PREFIX, m[1])
  assert.ok(src.includes('[RECOUNTED '), 'the recount provenance line is no longer written as [RECOUNTED ...]')
})

test('a FIRING alarm that never reached the store is a distinct, counted line', async () => {
  // ⛔ WRITER WITH NO READER, ONE LEVEL DOWN. The alert row carries `applied`,
  // `scanned_jobs`, `base_rate`, `lift`, `not_used` and `reason`, and the sweep
  // summary read NONE of them: it filtered on `fires` and printed memory / task
  // / streak / p. A sweep in which every recount failed — the detector decided
  // and the ledger was never corrected — printed exactly the same line as a
  // sweep in which every recount landed.
  const { readRefutationDecisions, formatRefutationAlarms } = await import('./stop-gate-audit.mjs')
  const base = mkdtempSync(join(tmpdir(), 'sga-applied-'))
  const job = join(base, 'job-a')
  mkdirSync(job, { recursive: true })
  const fired = (memory, applied) => ({
    at: '2026-09-07T03:18:00Z',
    memory_id: memory,
    task: 'seg',
    streak: 2,
    p: 0.0204,
    base_rate: 12 / 14,
    used: { pass: 2, total: 12 },
    not_used: { pass: 12, total: 14 },
    lift: { value: -0.69, used: { rate: 0.1667 }, notUsed: { rate: 0.857 } },
    trial: 'seg__t1',
    scanned_jobs: 26,
    fires: true,
    applied,
    reason: '2 consecutive used-cohort failures on a task whose not-used cohort passes 12/14',
    recount_scope: { trials: 14, tasks: 2 },
  })
  writeFileSync(
    join(job, 'memory-refutation-alerts.jsonl'),
    [
      JSON.stringify(fired(4242, true)),
      JSON.stringify(fired(4243, false)),
      JSON.stringify({
        at: '2026-09-07T05:18:00Z',
        memory_id: 4244,
        task: 'seg',
        streak: 0,
        p: null,
        base_rate: null,
        scanned_jobs: 0,
        fires: false,
        applied: false,
        reason: 'scanned nothing — no jobs root under the base this trial was resolved to',
      }),
      JSON.stringify({
        at: '2026-09-07T06:18:00Z',
        memory_id: 4245,
        task: 'seg',
        streak: 1,
        p: null,
        base_rate: null,
        scanned_jobs: 26,
        fires: false,
        applied: false,
        reason: 'no credible base rate',
      }),
    ].join(String.fromCharCode(10)),
  )
  // EVERY decision is readable, not only the firing ones — a decision that
  // scanned nothing can never fire, so a fires-only reader is structurally blind
  // to the misconfiguration that produced it.
  const decisions = readRefutationDecisions(base)
  assert.equal(decisions.length, 4)
  assert.equal(decisions.filter((d) => d.fires).length, 2)
  assert.equal(decisions[0].job, 'job-a')

  const text = formatRefutationAlarms(decisions).join(String.fromCharCode(10))
  assert.match(text, /2 fired of 4 decision\(s\)/)
  assert.match(text, /1 applied/)
  // The distinct, counted line: a sweep where every recount failed must be
  // visible as such.
  assert.match(text, /1 FIRED BUT NOT APPLIED/)
  assert.match(text, /memory 4243[\s\S]*NOT APPLIED/)
  assert.match(text, /never reached the store/)
  // The base rate and the lift travel with the printed line, so the call can be
  // re-judged without re-walking the corpus.
  assert.match(text, /12\/14 = 0\.857/)
  assert.match(text, /lift -0\.690/)
  // The recount's real scope — the ledger row is per-memory, not per-task.
  assert.match(text, /14 used trial\(s\) across 2 task\(s\)/)
  // Both arms and the scan count, so arms far below the corpus the watch walked
  // is visible rather than implied.
  assert.match(text, /used 2\/12 of 26 job\(s\) scanned/)
  // `scanned_jobs` and `reason` are read too: a sweep whose watch scanned
  // nothing is a misconfiguration, not a quiet corpus.
  assert.match(text, /SCANNED NOTHING/)
  assert.match(text, /no credible base rate/)
})

test('a sweep in which every recount failed does not read like a clean one', async () => {
  const { formatRefutationAlarms } = await import('./stop-gate-audit.mjs')
  const row = (applied) => ({
    memory_id: 1,
    task: 't',
    streak: 2,
    p: 4.67e-9,
    base_rate: 0.9,
    not_used: { pass: 9, total: 10 },
    lift: { value: -0.8 },
    scanned_jobs: 10,
    fires: true,
    applied,
    reason: 'r',
  })
  const allFailed = formatRefutationAlarms([row(false), row(false)]).join(String.fromCharCode(10))
  const allLanded = formatRefutationAlarms([row(true), row(true)]).join(String.fromCharCode(10))
  assert.notEqual(allFailed, allLanded)
  assert.match(allFailed, /2 FIRED BUT NOT APPLIED/)
  assert.match(allFailed, /2 of 2 firing alarm\(s\) never reached the store/)
  assert.doesNotMatch(allLanded, /never reached the store/)
  // ⛔ AND p IS PRINTED AS A NUMBER A READER CAN JUDGE. `toFixed(4)` rendered
  // the campaign's own worked example, 4.67e-9, as `0.0000`.
  assert.match(allFailed, /4\.67e-9/)
  assert.doesNotMatch(allFailed, /p=0\.0000/)
})

// ── OUTCOME-VISIBLE-6 — the sweep summary must SAY how much the cohort dropped ─
//
// ⛔ WHY THIS FAILS ON THE PRE-CHANGE TREE. The alert row had no
// `exposed_while_refuted` field and `formatRefutationAlarms` printed nothing about
// it, so a decision whose used arm had been narrowed read exactly like a decision
// on a smaller corpus. That is the writer-with-no-reader shape this block was
// built to close, one field later: the watch records the count and nobody prints
// it, so the only way to tell a narrowed cohort from a quiet one is to re-walk
// 1,992 job directories by hand.
test('the sweep summary reports exposed-while-refuted reads and the recount they left out', async () => {
  const { formatRefutationAlarms } = await import('./stop-gate-audit.mjs')
  const NL = String.fromCharCode(10)
  const row = (exposed) => ({
    memory_id: 26809,
    task: 'sam-cell-seg',
    streak: 2,
    p: 0.0204,
    base_rate: 0.857,
    used: { pass: 1, total: 3 },
    not_used: { pass: 12, total: 14 },
    lift: { value: -0.52 },
    scanned_jobs: 26,
    fires: true,
    applied: true,
    exposed_while_refuted: exposed,
    recount_scope: { trials: 4, tasks: 1, exposed_while_refuted: exposed },
    reason: 'r',
    job: 'j001',
  })
  const withExposure = formatRefutationAlarms([row(1)]).join(NL)
  const without = formatRefutationAlarms([row(0)]).join(NL)
  assert.notEqual(withExposure, without, 'a narrowed cohort must not render like a quiet one')
  assert.match(withExposure, /1 exposed-while-refuted read\(s\) across 1 decision\(s\)/)
  assert.match(withExposure, /memory 26809/)
  assert.match(withExposure, /counted in neither arm/)
  // The scope line carries it too: `trials` is what the walk FOUND, so the
  // difference from the folded counts has to be on the same line or the two
  // numbers look like a bug.
  assert.match(withExposure, /4 used trial\(s\) across 1 task\(s\), 1 exposed-while-refuted/)
  // Zero is omitted from the prose rather than printed as a reassuring nothing.
  assert.doesNotMatch(without, /exposed-while-refuted/)
})
