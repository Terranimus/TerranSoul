/**
 * `attribute-proxy-lines.mjs` — split a proxy log into per-trial slices, so a
 * trial's graded reward credits the memories THAT TRIAL saw.
 *
 * ⛔ THE DEFECT THIS CLOSES: THE JOB, NOT THE TRIAL, WAS THE UNIT OF CREDIT.
 *
 * `run-dg.sh` runs one proxy per job and hands the same job-wide log to every
 * trial:
 *
 *     node credit-trial-outcome.mjs "$_trial" "$PROXY_LOG" --apply
 *
 * so `servedMemoryIds()` returned the union over the whole batch.
 *
 * MEASURED 2026-09-03 across three 10-task batches: 30 distinct served/authored
 * ids per job, all 30 attributed to each of 10 trials — 300 credit operations
 * of which at most 30 can be right. Those batches were all-pass so the error was
 * uniform, but in a mixed batch one failure debits every memory served anywhere
 * in the job, and `confidence_buckets` requires `failure_count == 0` for the
 * clean-success bucket, so a single loss evicts them all.
 *
 * ── WHY THIS ATTRIBUTES BY TIME, AND WHY THE FIRST ATTEMPT DID NOT WORK ──────
 *
 * The first version keyed on the peer address, reasoning that each trial is its
 * own container on its own compose network. MEASURED, and it is false here: two
 * containers on two separate networks reaching the host through
 * `host.docker.internal` both arrive as **127.0.0.1**. Docker Desktop's
 * host-gateway path NATs every container to loopback, so the address is a
 * constant and carries no trial identity at all.
 *
 * That approach was not merely useless, it was worse than the bug: every line
 * would join one session, one trial would take all the ids and the other nine
 * would credit NOTHING — the feedback loop would go dark while reporting
 * success. It is deleted rather than kept behind a flag.
 *
 * WHAT ACTUALLY WORKS is the run shape. Within a single worker, trials run
 * SEQUENTIALLY, so their agent windows are disjoint and a timestamp identifies
 * exactly one trial. `run-sweep.sh` gives each worker its own proxy port and
 * therefore its own log (run-dg.sh: "the proxy port is already unique per
 * worker (7425+w), so it is the natural discriminator"), which is the supported
 * way to get parallelism with attributable logs.
 *
 * So: attribute by window, and REFUSE when the windows overlap — that overlap
 * is the signature of concurrent trials sharing one proxy, where no offline
 * method can separate them. Refusing is the point. A guess here silently
 * mis-credits the ranking signal, which is the failure this file exists to end.
 */

/** One parsed log line, or null when the line carries no usable timestamp. */
function parseLine(line) {
  const brace = line.indexOf('{')
  if (brace < 0) return null
  let o
  try {
    o = JSON.parse(line.slice(brace))
  } catch {
    return null
  }
  const at = Date.parse(o?.at ?? '')
  if (!Number.isFinite(at)) return null
  return { at, obj: o }
}

/** Every timestamped line in a proxy log, in file order. */
export function parseProxyLog(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const p = parseLine(line)
    if (p) out.push(p)
  }
  return out
}

/** Trial windows from parsed `result.json` objects. */
export function trialWindows(trials) {
  const out = []
  for (const { name, result } of trials) {
    // `agent_execution` is the window the container was actually live, which is
    // strictly tighter than the trial's own start/finish (those include image
    // setup and the verifier run, during which no agent call can occur). Using
    // the wider window would manufacture overlaps between trials that never ran
    // at the same time, and this module refuses on overlap.
    const s = Date.parse(result?.agent_execution?.started_at ?? result?.started_at ?? '')
    const e = Date.parse(result?.agent_execution?.finished_at ?? result?.finished_at ?? '')
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) continue
    out.push({ name, start: s, end: e })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The first pair of windows that overlap, or null when all are disjoint.
 *
 * Overlap means two trials were in flight against the same proxy, and no
 * property of the log can say which one a given call came from — the peer
 * address is NAT-collapsed to 127.0.0.1 for every container.
 */
export function firstOverlap(windows) {
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].start < windows[i - 1].end) return [windows[i - 1], windows[i]]
  }
  return null
}

/**
 * Memory ids attributable to ONE trial.
 *
 * @param {string[]} keys which proxy-line arrays to collect. Defaults to both,
 *   which is what CREDITING wants: a trial is answerable for what it was shown
 *   AND for what it wrote. `['authored']` alone is what STAMPING wants — a
 *   verdict may only be written onto blocks this trial actually produced, and
 *   marking a row it merely READ would fabricate an endorsement of advice it
 *   may have rejected (`reference_append_target_is_not_endorsement`).
 *
 * @returns {{ids: number[], attributed: boolean, reason?: string}}
 *
 * `attributed:false` means the log cannot be split and the caller must NOT
 * quietly proceed — a whole-job union is exactly the defect being fixed, and
 * using it without saying so would leave the fix looking applied.
 */
export function idsForTrial(logText, trialName, trials, keys = ['served', 'authored']) {
  const windows = trialWindows(trials)
  if (!windows.length) {
    return { ids: [], attributed: false, reason: 'no trial produced a usable agent window' }
  }
  const overlap = firstOverlap(windows)
  if (overlap) {
    return {
      ids: [],
      attributed: false,
      reason:
        `trial windows overlap (${overlap[0].name} / ${overlap[1].name}) — concurrent trials ` +
        `share one proxy log and cannot be separated; run one worker per proxy port to attribute`,
    }
  }
  const mine = windows.find((w) => w.name === trialName)
  if (!mine) {
    return { ids: [], attributed: false, reason: `no agent window found for ${trialName}` }
  }
  const ids = new Set()
  for (const l of parseProxyLog(logText)) {
    // Lines outside every window are setup, teardown, or the deferred-write
    // flush the proxy performs after the trials — they belong to no trial.
    if (l.at < mine.start || l.at > mine.end) continue
    for (const key of keys) {
      if (!Array.isArray(l.obj?.[key])) continue
      for (const id of l.obj[key]) if (Number.isInteger(id)) ids.add(id)
    }
  }
  return { ids: [...ids].sort((a, b) => a - b), attributed: true }
}
