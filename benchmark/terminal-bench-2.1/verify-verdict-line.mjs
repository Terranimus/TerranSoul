/**
 * `verify-verdict-line.mjs` — turn a `brain_verify_completion` response into the
 * one proxy-log line that says what the stop gate DECIDED.
 *
 * Split out of `mcp-auth-proxy.mjs` for one reason: that file calls
 * `server.listen()` at top level with no `import.meta.url` guard, so importing
 * it to test anything starts a listening socket. The alternative the repo had
 * been using — a test that greps the proxy's own source for a literal — is the
 * shape `reference_tests_that_cannot_fail_include_str` records hitting three
 * times in one session: it passes with the behaviour deleted, because the
 * literal it asserts on is the literal it read.
 *
 * So the logic lives here, where a test can call it with a fixture response and
 * a wrong answer actually fails.
 */

/** Bound on the free-text reason. The audit tools read this log in full. */
export const REASON_MAX = 240

/** Bound on the recorded command. Long enough to identify a check, not to quote one. */
export const COMMAND_MAX = 120

/**
 * @param {string} text the `result.content[0].text` the brain returned
 * @param {string|undefined} op the REQUEST's `op` — the response never echoes it
 * @returns {object|null} the line to log, or null when there is nothing to say
 *
 * THREE RESPONSE SHAPES, all of which must be recorded — MEASURED against a
 * live brain 2026-09-03, because the first version of this function covered two
 * of them and logged NOTHING across a whole batch:
 *
 *   op:'verify'       {verified, reason, method}
 *   op:'status'       {op, state, changed_paths, verify_on_stop, evidence}
 *   op:'mark_edited'  {id, op, state}
 *   op:'record'       {id, canonical_command, evidence, next}   <- NO state
 *
 * `record` is the one that was missed, and it is the one that actually fires:
 * all 6 stop-gate calls in the first batch after this change were `record`, so
 * a coverage gap here reads exactly like a dead feature. It also carries the
 * most interesting field in the set. `evidence:'self_selected'` is the ledger's
 * own classification of proof QUALITY, and its `next` text says why that
 * matters — "you chose this check, you ran it, and it agreed with you ...
 * equally consistent with a check built from the same misunderstanding."
 *
 * A failing trial whose every recorded proof was `self_selected` is a different
 * diagnosis from one that had independent evidence and still lost, and that
 * distinction was previously unavailable in any artifact a sweep leaves behind.
 *
 * Recording all four is the point: "this stop was decided by `status` alone" is
 * precisely the observation that tells you the LLM judge was never asked — the
 * opposite fix to a judge that ran and was wrong.
 */
export function buildVerifyLine(text, op) {
  if (typeof text !== 'string') return null
  let o
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const line = { verify: typeof op === 'string' && op ? op : 'verify' }
  if (typeof o.verified === 'boolean') line.verified = o.verified
  if (typeof o.method === 'string') line.method = o.method
  if (typeof o.state === 'string') line.state = o.state
  // The ledger's classification of how good the proof is — `self_selected` when
  // the agent chose and ran its own check. Present on `record` and `status`.
  if (typeof o.evidence === 'string') line.evidence = o.evidence
  // How the recorded check was CLASSIFIED: `status` is passed/failed, `scope` is
  // targeted/full. These are the ledger's structural verdict on the proof and
  // are what make a failing trial's evidence trail readable — "every check it
  // filed was targeted and self-selected" is a diagnosis; "it called record 6
  // times" is not.
  //
  // ⛔ MISSED ON THE FIRST TWO PASSES, both times by building from a partial
  // view of the response instead of a complete one: first from the schema
  // description (which names neither), then from a live probe whose output I
  // truncated at 300 chars — and the probe happened to hit the corroboration
  // branch, whose extra `next` prose pushed `scope`/`status` past the cut.
  if (typeof o.status === 'string') line.status = o.status
  if (typeof o.scope === 'string') line.scope = o.scope
  // WHICH check was offered as proof. `next` is deliberately excluded: it is
  // static advice the tool returns verbatim every time, so logging it would add
  // hundreds of identical bytes per call and no information.
  if (typeof o.canonical_command === 'string') {
    line.command = o.canonical_command.slice(0, COMMAND_MAX)
  }
  if (typeof o.reason === 'string') line.reason = o.reason.slice(0, REASON_MAX)
  // A line carrying only the op name would look like evidence while holding
  // none — it cannot distinguish a shape drift from a verdict. Say nothing.
  return Object.keys(line).length === 1 ? null : line
}

/** Bound on the recorded goal. Enough to identify the task, not to reproduce it. */
export const JUDGE_GOAL_MAX = 1200

/** Bound on the recorded actions snapshot — the judge's whole view of the work. */
export const JUDGE_ACTIONS_MAX = 8000

/**
 * Head AND tail, never head alone.
 *
 * A head-only cut is what hid a judge's verdict line from the verifier once
 * already (the conclusion of a command's output lives at its END, which is
 * exactly the part a `slice(0, n)` discards). The same mistake in the log would
 * make the record useless for the case it exists to diagnose.
 */
export function boundedForLog(text, max) {
  const t = String(text ?? '')
  if (t.length <= max) return t
  const head = Math.floor(max / 3)
  const tail = max - head
  return `${t.slice(0, head)}\n... [${t.length - max} chars omitted] ...\n${t.slice(t.length - tail)}`
}

/**
 * Record WHAT THE JUDGE WAS SHOWN, alongside what it decided.
 *
 * ⛔ MEASURED 2026-09-05, and it cost a diagnosis. The judge returned
 * verified:true on a trial the grader scored 0, quoting the actor's own
 * "93.1% coverage" figure. A reconstruction of that evidence, probed against
 * the same live brain, returned verified:FALSE three times out of three — so
 * the real snapshot must have differed from the reconstruction in some way
 * that mattered. Which way is now unknowable: `actions_snapshot` appears
 * NOWHERE in the trial's artefacts. The proxy logs the verdict and not the
 * input, the gateway keeps neither, and the Stop hook builds the snapshot
 * inside the container and discards it.
 *
 * So a wrong verdict is observable but not reproducible, and a prompt change
 * aimed at it can only be evaluated by re-running a ten-minute trial and
 * hoping. That is the same class of gap the verdict line itself was added to
 * close — "the logs cannot distinguish the judge wrongly confirming the work
 * from the judge never being asked" — one level further in.
 *
 * `actionsChars` is the UNTRUNCATED length, kept because the judge's blindness
 * is itself the measurement: it sees a bounded window of the work, and knowing
 * how much was cut is what tells you whether a wrong verdict was bad reasoning
 * or missing evidence.
 *
 * Logged under `judgeInput`, a key no other witness counts — one forwarded
 * call must keep producing exactly one of each existing key.
 *
 * @param {object|undefined} args the REQUEST's `params.arguments`
 * @returns {object|null} the line to log, or null when this is not a judge call
 */
export function buildJudgeInputLine(args) {
  if (!args || typeof args !== 'object') return null
  if (args.op !== 'verify') return null
  const goal = String(args.goal ?? '')
  const actions = String(args.actions_snapshot ?? '')
  if (!goal && !actions) return null
  return {
    judgeInput: {
      goal: boundedForLog(goal, JUDGE_GOAL_MAX),
      actions: boundedForLog(actions, JUDGE_ACTIONS_MAX),
      actionsChars: actions.length,
    },
  }
}
