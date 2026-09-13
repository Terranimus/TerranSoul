/**
 * The grader's verdict must reach the memories the agent was shown.
 *
 * WHY THIS EXISTS. `confidence_buckets` (store.rs) promotes a memory with
 * `success_count >= 1` and `failure_count == 0` into a bucket ABOVE untested
 * rows. The only writer of those counters in a bench run is
 * `brain_observe_outcome`, and both of its inputs come from the AGENT
 * (mcp/tools.rs:4093-4107). So an agent that passes tests it wrote itself
 * promotes its own sources, and the grader's verdict reaches the brain by no
 * path at all.
 *
 * MEASURED 2026-09-01: memory 26531 advises "never emit the parser's
 * serialisation", which is the direct cause of `filter-js-from-html`'s failure
 * (the grader compares against `str(BeautifulSoup(...))`). It carries
 * success_count=2, failure_count=0 after 54 consecutive graded failures, and is
 * served at rank 1 to every new attempt.
 *
 * FAILS ON THE PRE-CHANGE TREE: `credit-trial-outcome.mjs` did not exist, so
 * the import below throws.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readReward, servedMemoryIds, buildObservation, trialBasename } from './credit-trial-outcome.mjs'

const trialWithReward = (value) => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-credit-'))
  mkdirSync(join(dir, 'verifier'))
  if (value !== null) writeFileSync(join(dir, 'verifier', 'reward.txt'), value)
  return dir
}

test('the observation carries every param the tool REQUIRES', () => {
  // ⛔ MEASURED FAILURE, trial 7: the first version sent only `outcome` and
  // `used_memory_ids` — the two fields that do the crediting — and the tool
  // answered `missing required param: session_id`, so nothing landed. The
  // attribution was correct and still wrote nothing.
  //
  // `brain_observe_outcome`'s schema requires session_id, context, action and
  // response (tools.rs). Asserted by NAME here so a future field addition to
  // that schema breaks this test rather than a live run.
  //
  // FAILS ON THE PRE-CHANGE TREE: the object had only outcome/used_memory_ids/note.
  const args = buildObservation(0, [1], 'filter-js-from-html__abc').arguments
  for (const required of ['session_id', 'context', 'action', 'response']) {
    assert.ok(
      typeof args[required] === 'string' && args[required].length > 0,
      `missing required param ${required}`,
    )
  }
  assert.match(args.session_id, /filter-js-from-html__abc/, 'the trial must be traceable from the row')
  // Never 'fatal': that ingests a negative memory at importance 10, and a
  // scored 0 is an ordinary graded result, not a catastrophe.
  assert.equal(args.outcome, 'failure')
})

test('the session id survives both path separators and a trailing slash', () => {
  // run-dg.sh passes "$JOB_DIR"/*/ which always ends in a separator; an empty
  // session id is rejected by the tool, which is the bug this guards.
  assert.equal(trialBasename('/a/b/filter-js__x/'), 'filter-js__x')
  assert.equal(trialBasename('D:\\jobs\\filter-js__x\\'), 'filter-js__x')
  assert.equal(trialBasename('filter-js__x'), 'filter-js__x')
  assert.equal(trialBasename(''), 'trial')
})

test('a FAILED trial teaches its sources that they failed', () => {
  // The whole point: 0.0 must produce a failure attribution. Before this, a
  // graded 0 wrote nothing anywhere and the promotion survived untouched.
  const obs = buildObservation(0, [26531, 26628])
  assert.equal(obs.name, 'brain_observe_outcome')
  assert.equal(obs.arguments.outcome, 'failure')
  assert.deepEqual(obs.arguments.used_memory_ids, [26531, 26628])
  assert.match(
    obs.arguments.context + ' ' + obs.arguments.action,
    /graded by the task verifier/,
    'the row must record that the verdict came from the GRADER, since that is the ' +
      'entire difference from the signal the agent already writes',
  )
})

test('a PASSED trial credits the same way', () => {
  assert.equal(buildObservation(1, [7]).arguments.outcome, 'success')
})

test('reward is read from the file the harness trusts, never inferred', () => {
  assert.equal(readReward(trialWithReward('0')), 0)
  assert.equal(readReward(trialWithReward('1.0')), 1)
  // Absent or unreadable reward => null => no attribution at all. A trial that
  // never produced a verdict must not be turned into one; `run-dg.sh` makes the
  // same point about exit codes, and "a run that never happened is not a
  // failure" is a recorded lesson in this repo.
  assert.equal(readReward(trialWithReward(null)), null)
  assert.equal(readReward(trialWithReward('   ')), null)
  assert.equal(readReward(trialWithReward('not-a-number')), null)
  assert.equal(buildObservation(null, [1, 2]), null)
})

test('served ids are read off the proxy log, deduplicated and sorted', () => {
  const log = [
    '[tb-proxy] listening on 0.0.0.0:7425',
    '[tb-proxy] {"tool":"brain_search","allowed":true}',
    '[tb-proxy] {"served":[26531,26628,26531]}',
    'a line with no json at all',
    '[tb-proxy] {"served":[26499]}',
    '[tb-proxy] {"name":"brain_search","verdict":"accepted"}',
    '[tb-proxy] {broken json',
  ].join('\n')
  assert.deepEqual(servedMemoryIds(log), [26499, 26531, 26628])
})

test('no served ids means no attribution, rather than a guess', () => {
  // Attributing a failure to nothing is harmless; attributing it to a guessed
  // set would corrupt the ranking signal this exists to protect.
  assert.deepEqual(servedMemoryIds(''), [])
  assert.equal(buildObservation(0, []), null)
})

test('a `served` line is not counted as a tool call by the usage witnesses', () => {
  // ⛔ The witnesses in run-dg.sh grep `"tool":` and `"name":` to count calls
  // and brain verdicts. If the new line carried either key, every search would
  // inflate those counts and the "did TerranSoul get used?" evidence — which
  // this campaign relies on to tell a real run from a phantom — would silently
  // start lying.
  const line = JSON.stringify({ served: [26531] })
  assert.ok(!line.includes('"tool":'))
  assert.ok(!line.includes('"name":'))
})

test('a memory the trial AUTHORED is credited too, not just what it was served', () => {
  // ⛔ THE HOLE THIS CLOSES, measured 2026-09-03 on extract-elf. The trial
  // scored 0 for precisely the approach it then wrote up as good practice —
  // omit the awkward values, "only ~7% of mapped words ... coverage stays
  // ~93% — well over a 75% floor. Free removal of an entire failure mode."
  // The grader measured 66.67%.
  //
  // The credit step debited the four SERVED rows and never touched the new
  // one (26654, importance 8, success 0, failure 0), because an authored
  // lesson is not in the served set. It therefore entered the store as an
  // UNTESTED row, which confidence_buckets ranks ABOVE rows carrying recorded
  // failures — so the next attempt is handed the advice that just lost.
  //
  // That is "the loop rewrites the poison" with its mechanism visible:
  // purging a bad row cannot help while a failing attempt mints a clean
  // replacement.
  const log = [
    '[tb-proxy] {"served":[11,22]}',
    '[tb-proxy] {"tool":"brain_ingest_lesson","allowed":true}',
    '[tb-proxy] {"authored":[26654]}',
  ].join(String.fromCharCode(10))
  assert.deepEqual(servedMemoryIds(log), [11, 22, 26654])
})

test('authored ids are deduplicated against served ones', () => {
  // A row can be both read and appended to in the same trial; it must be
  // credited once, not twice.
  const log = ['[tb-proxy] {"served":[7]}', '[tb-proxy] {"authored":[7]}'].join(String.fromCharCode(10))
  assert.deepEqual(servedMemoryIds(log), [7])
})

// ── PER-TRIAL ATTRIBUTION (TBENCH-CREDIT-SCOPE-1) ───────────────────────────
//
// FAILS ON THE PRE-CHANGE TREE: `readSiblingTrials` did not exist (the import
// at the top of this block throws), and the behaviour it enables did not
// either — every trial in a job credited the whole job's served ids.
import { readSiblingTrials } from './credit-trial-outcome.mjs'
import { idsForTrial } from './attribute-proxy-lines.mjs'

/** A job dir with two overlapping trials, as `run-dg.sh` produces at concurrency 2. */
function makeJob(opts = {}) {
  const job = mkdtempSync(join(tmpdir(), 'tb-credit-job-'))
  const at = (m) => `2026-09-03T09:${String(m).padStart(2, '0')}:00.000Z`
  const trial = (name, s, e) => {
    mkdirSync(join(job, name), { recursive: true })
    mkdirSync(join(job, name, 'verifier'), { recursive: true })
    writeFileSync(
      join(job, name, 'result.json'),
      JSON.stringify({
        task_name: name,
        agent_execution: { started_at: at(s), finished_at: at(e) },
      }),
    )
  }
  // Sequential by default (one worker, trials back to back) — the attributable
  // shape. `overlap` reproduces two trials in flight against one proxy, which
  // must be REFUSED rather than guessed at.
  if (opts.overlap) {
    trial('alpha__aaa', 40, 58)
    trial('beta__bbb', 42, 52)
  } else {
    trial('alpha__aaa', 40, 50)
    trial('beta__bbb', 51, 58)
  }
  return { job, at }
}

test('sibling trials are read from the job dir, which is the trial dir parent', () => {
  const { job } = makeJob()
  const names = readSiblingTrials(join(job, 'alpha__aaa')).map((t) => t.name).sort()
  assert.deepEqual(names, ['alpha__aaa', 'beta__bbb'])
  // The trial itself is included, not excluded: the assignment needs every
  // window in the job to tell overlapping ones apart, including its own.
  assert.ok(names.includes('alpha__aaa'))
})

test('a trailing separator on the trial dir does not walk up to the wrong parent', () => {
  // `run-dg.sh` iterates the job dir with a trailing-slash glob, so every path
  // arrives ending in a separator. Without the trim, dirname() returns the JOB
  // dir's parent and every sibling lookup comes back empty.
  const { job } = makeJob()
  assert.equal(readSiblingTrials(join(job, 'alpha__aaa') + '/').length, 2)
  assert.equal(readSiblingTrials(join(job, 'alpha__aaa')).length, 2)
})

test('END TO END: two SEQUENTIAL trials in one job credit DIFFERENT memories', () => {
  const { job, at } = makeJob()
  const log = [
    JSON.stringify({ served: [100, 101], at: at(41) }),
    JSON.stringify({ served: [102], at: at(49) }),
    JSON.stringify({ served: [200], at: at(53) }),
    JSON.stringify({ authored: [201], at: at(57) }),
  ].join(String.fromCharCode(10))
  const siblings = readSiblingTrials(join(job, 'alpha__aaa'))
  const a = idsForTrial(log, 'alpha__aaa', siblings)
  const b = idsForTrial(log, 'beta__bbb', siblings)
  assert.deepEqual(a.ids, [100, 101, 102])
  assert.deepEqual(b.ids, [200, 201])
  // The measured defect: under the old code BOTH returned the union.
  assert.notDeepEqual(a.ids, b.ids)
})

test('a CONCURRENT job refuses attribution rather than mis-crediting', () => {
  // Two trials in flight against one proxy. The peer address cannot separate
  // them (Docker NATs every container to 127.0.0.1 — measured), so there is no
  // offline split and the honest answer is to refuse and fall back loudly.
  const { job, at } = makeJob({ overlap: true })
  const siblings = readSiblingTrials(join(job, 'alpha__aaa'))
  const r = idsForTrial(JSON.stringify({ served: [1], at: at(45) }), 'alpha__aaa', siblings)
  assert.equal(r.attributed, false)
  assert.match(r.reason, /overlap/)
})

// ⛔ FAILS ON THE PRE-CHANGE TREE: main() credited on `reward` alone, so these
// three fixtures all produced `-> failure for 2 served memories`.
//
// MEASURED 2026-09-08 over every graded-zero trial on disk: 8 trials were cut
// off MID-RUN by the API (UnknownApiError, ApiRateLimitError,
// ApiInternalServerError) and every one of them had already made a real
// brain_search — so every one debited the memories it had been served for a
// task the agent was never allowed to finish. This file's own header explains
// why that is not a rounding error: confidence_buckets requires
// failure_count == 0 for the clean-success bucket, so ONE false failure evicts
// a memory from the top bucket permanently.
test('a trial the API cut off mid-run is not credited as a failure', async () => {
  const { execFileSync } = await import('node:child_process')
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  const mk = (name, result) => {
    const job = mkdtempSync(join(tmpdir(), 'tb-credit-fair-'))
    const trial = join(job, name)
    mkdirSync(join(trial, 'verifier'), { recursive: true })
    writeFileSync(join(trial, 'verifier', 'reward.txt'), '0')
    writeFileSync(join(trial, 'result.json'), JSON.stringify(result))
    const log = join(job, 'proxy.log')
    // A `read` row, not merely `served`: since OUTCOME-VISIBLE-2 only opened or
    // written memories are credited, and this test is about whether the TRIAL
    // was a fair test — it needs something creditable for that question to
    // have a subject at all.
    writeFileSync(
      log,
      [
        JSON.stringify({ served: [500, 501], trial: name }),
        JSON.stringify({ read: [500], trial: name }),
      ].join(String.fromCharCode(10)),
    )
    return { trial, log }
  }
  const run = ({ trial, log }) => {
    try {
      return execFileSync(process.execPath, [script, trial, log], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return String(e.stdout ?? '') + String(e.stderr ?? '')
    }
  }

  const cut = run(mk('alpha__aaa', {
    agent_result: { n_output_tokens: 9000 },
    exception_info: { exception_type: 'ApiRateLimitError' },
  }))
  assert.doesNotMatch(cut, /-> failure/, 'an API cutoff must not be credited as a failure')

  const never = run(mk('beta__bbb', { agent_result: { n_output_tokens: 0 } }))
  assert.doesNotMatch(never, /-> failure/, 'a trial that never ran must not be credited')

  // ⛔ THE ONE THAT MUST STILL BE CREDITED, and it is the largest group in the
  // corpus: running out of budget IS the agent failing the task.
  const timedOut = run(mk('gamma__ccc', {
    agent_result: { n_output_tokens: 9000 },
    exception_info: { exception_type: 'AgentTimeoutError' },
  }))
  assert.match(timedOut, /-> failure/, 'a timeout is a capability failure and must be credited')
})

// ── OUTCOME-VISIBLE-1: the verdict must reach the TEXT, not only the counters ─
//
// ⛔ FAILS ON THE PRE-CHANGE TREE: `trialWindow`, `buildStamps` and `verdictFor`
// did not exist, so the import below throws before a single assertion runs.
//
// The defect they close, measured 2026-09-11: crediting moves `success_count` /
// `failure_count`, which only RANKING reads. Nothing the agent READS carried a
// grade — not a search hit, not `brain_get_entry`, and not the
// `[Update <ms> · agent-session]` blocks themselves — so advice appended by a
// failing attempt was indistinguishable from advice appended by a passing one.
// One 68 KB notebook accumulated twenty such blocks across ~11 attempts at one
// task; attempt N read attempt N-1's block, rebuilt its construction, and lost
// at the identical number. Twice.
import { trialWindow, buildStamps, verdictFor } from './credit-trial-outcome.mjs'

test('the stamping window comes from the TRIAL-level timestamps, not the agent window', () => {
  // ⛔ THE TWO WINDOWS ARE DELIBERATELY DIFFERENT AND ARE USED FOR DIFFERENT
  // JOBS. Attribution splits the shared proxy log by `agent_execution`, which
  // must stay TIGHT or trials that never overlapped appear to (and attribution
  // then refuses). Stamping already knows which trial owns the ids, so the only
  // question left is which of that memory's blocks this trial wrote — and a
  // block written during setup or flushed after the agent exited is still this
  // trial's. Reading the tight window here would silently skip those.
  const w = trialWindow({
    started_at: '2026-09-11T10:00:00.100000Z',
    finished_at: '2026-09-11T10:30:00.900000Z',
    agent_execution: {
      started_at: '2026-09-11T10:05:00.000000Z',
      finished_at: '2026-09-11T10:25:00.000000Z',
    },
  })
  assert.equal(w.from_ms, Date.parse('2026-09-11T10:00:00.100Z'))
  assert.equal(w.to_ms, Date.parse('2026-09-11T10:30:00.900Z'))

  // Falls back to the agent window only when the trial-level pair is missing.
  const fallback = trialWindow({
    agent_execution: { started_at: '2026-09-11T10:05:00Z', finished_at: '2026-09-11T10:25:00Z' },
  })
  assert.equal(fallback.from_ms, Date.parse('2026-09-11T10:05:00Z'))

  // No usable window means no stamping, rather than a guessed one: a verdict
  // written onto the wrong blocks is durable text that outlives the run.
  assert.equal(trialWindow({}), null)
  assert.equal(trialWindow(null), null)
  assert.equal(
    trialWindow({ started_at: '2026-09-11T10:30:00Z', finished_at: '2026-09-11T10:00:00Z' }),
    null,
    'an inverted window is a bug, not an empty set',
  )
})

test('a stamp carries the verdict and the date and NOTHING else', () => {
  const window = { from_ms: 1000, to_ms: 2000 }
  const stamps = buildStamps([26809, 26810], window, verdictFor(0), 2000)
  assert.equal(stamps.length, 2)
  assert.equal(stamps[0].name, 'brain_stamp_outcome')
  // PURITY (rules/bench-agi-purity.md): the stamp must never carry the grader's
  // message, its numbers, or the names of the checks that ran. Asserting the
  // argument object EXACTLY — rather than spot-checking fields — is what makes
  // a future addition of such a field fail here instead of shipping.
  assert.deepEqual(stamps[0].arguments, {
    id: 26809,
    from_ms: 1000,
    to_ms: 2000,
    outcome: 'failure',
    graded_at: 2000,
  })
  assert.equal(buildStamps([1], null, 'failure', 0).length, 0, 'no window, no stamp')
  assert.equal(buildStamps([], window, 'failure', 0).length, 0, 'no authored ids, no stamp')
  assert.equal(buildStamps([1], window, verdictFor(1), 0)[0].arguments.outcome, 'success')
})

test('END TO END: only the memories the trial AUTHORED are stamped, over its own window', async () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: `main()` sent exactly one call
  // (`brain_observe_outcome`) and no stamping op existed, so `stampCalls` is
  // empty and the first assertion fires.
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  // ⛔ execFile, NOT execFileSync. The stub server below lives in THIS process,
  // so a synchronous spawn blocks the event loop that has to accept the child's
  // request — the child waits for a reply that cannot be sent, and the test
  // deadlocks with no output at all (observed once while writing this).
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  // A job with ONE trial, so the windows cannot overlap and attribution
  // succeeds — the precondition stamping requires.
  const job = mkdtempSync(join(tmpdir(), 'tb-credit-stamp-'))
  const trial = join(job, 'alpha__aaa')
  mkdirSync(join(trial, 'verifier'), { recursive: true })
  writeFileSync(join(trial, 'verifier', 'reward.txt'), '0')
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      task_name: 'alpha__aaa',
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-11T10:00:00.000000Z',
      finished_at: '2026-09-11T10:30:00.000000Z',
      agent_execution: {
        started_at: '2026-09-11T10:05:00.000000Z',
        finished_at: '2026-09-11T10:25:00.000000Z',
      },
    }),
  )
  const log = join(job, 'proxy.log')
  writeFileSync(
    log,
    [
      JSON.stringify({ served: [100, 101], at: '2026-09-11T10:06:00.000Z' }),
      // 100 is OPENED, 101 is only shown. Since OUTCOME-VISIBLE-2 that is the
      // line between credited and merely exposed, and it is what keeps this
      // test's "credited but not stamped" case alive.
      JSON.stringify({ read: [100], at: '2026-09-11T10:07:00.000Z' }),
      JSON.stringify({ authored: [201], at: '2026-09-11T10:20:00.000Z' }),
    ].join(String.fromCharCode(10)),
  )

  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const params = JSON.parse(body).params
      calls.push(params)
      const inner =
        params.name === 'brain_observe_outcome'
          ? { memories_credited: params.arguments.used_memory_ids }
          : { memory_id: params.arguments.id, blocks_stamped: 1, head_stamped: false, changed: true }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    await runScript(process.execPath, [script, trial, log, '--apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TERRANSOUL_MCP_URL: 'http://127.0.0.1:' + port + '/mcp',
        TERRANSOUL_MCP_TOKEN: 'stub-token',
      },
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const observeCalls = calls.filter((c) => c.name === 'brain_observe_outcome')
  const stampCalls = calls.filter((c) => c.name === 'brain_stamp_outcome')

  assert.equal(stampCalls.length, 1, 'exactly the one memory this trial authored')
  assert.deepEqual(stampCalls[0].arguments, {
    id: 201,
    from_ms: Date.parse('2026-09-11T10:00:00.000Z'),
    to_ms: Date.parse('2026-09-11T10:30:00.000Z'),
    outcome: 'failure',
    graded_at: Date.parse('2026-09-11T10:30:00.000Z'),
  })

  // ⛔ THE OTHER HALF, AND IT IS THE ONE THAT KEEPS THIS HONEST. A memory the
  // trial OPENED is credited — reading a losing input is evidence about that
  // input — but it must NOT be stamped: the block it carries was written by
  // some earlier run, and marking it with this run's verdict would attribute
  // the loss to advice this trial may have explicitly rejected
  // (`reference_append_target_is_not_endorsement`).
  assert.equal(observeCalls.length, 1)
  assert.deepEqual(
    observeCalls[0].arguments.used_memory_ids,
    [100, 201],
    'opened + authored are credited; 101 was only shown (OUTCOME-VISIBLE-2)',
  )
  assert.ok(
    !stampCalls.some((c) => c.arguments.id === 100),
    'memory 100 was READ, not authored — it must get the observe call only',
  )
  assert.ok(
    !observeCalls[0].arguments.used_memory_ids.includes(101) &&
      !stampCalls.some((c) => c.arguments.id === 101),
    'memory 101 was only shown — it must get neither',
  )
})

test('--dry-run prints the stamp plan and sends nothing', async () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: the flag did not exist, so `--dry-run` fell
  // through to the plain dry path and printed no stamp plan at all.
  const { execFileSync } = await import('node:child_process')
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  const job = mkdtempSync(join(tmpdir(), 'tb-credit-dry-'))
  const trial = join(job, 'alpha__aaa')
  mkdirSync(join(trial, 'verifier'), { recursive: true })
  writeFileSync(join(trial, 'verifier', 'reward.txt'), '0')
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-11T10:00:00.000000Z',
      finished_at: '2026-09-11T10:30:00.000000Z',
      agent_execution: {
        started_at: '2026-09-11T10:05:00.000000Z',
        finished_at: '2026-09-11T10:25:00.000000Z',
      },
    }),
  )
  const log = join(job, 'proxy.log')
  writeFileSync(log, JSON.stringify({ authored: [201], at: '2026-09-11T10:20:00.000Z' }))

  // No MCP URL in the environment: if `--dry-run` ever started sending, the
  // script would exit 3 and this call would throw.
  const out = execFileSync(process.execPath, [script, trial, log, '--apply', '--dry-run'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERRANSOUL_MCP_URL: '', TERRANSOUL_MCP_TOKEN: '' },
  })
  assert.match(out, /stamping 1 authored memory as failure/)
  assert.match(out, /201/)
  assert.match(out, /DRY RUN \(--dry-run\)/)
})

// ── OUTCOME-VISIBLE-2: being SHOWN a memory is not USING it ──────────────────
//
// ⛔ FAILS ON THE PRE-CHANGE TREE: `USED_KEYS`, `usedMemoryIds` and
// `exposedOnly` did not exist, so the import below throws before any assertion
// runs. Behaviourally the credit set was every `served` id, which is the defect:
//
// MEASURED 2026-09-12 on memory 26809, a MobileSAM notebook. Nineteen trials
// touched it. Twelve were its own task (3 pass, 9 fail — all twelve AUTHORED
// it). The other seven were caffe-cifar-10 ×2, mteb-retrieve, bn-fit-modify,
// video-processing, winning-avg-corewars and pytorch-model-cli: all passed, all
// had merely seen the row in a search result, and all seven were credited as
// successes. The ledger read 9/6 — "mostly working" — where the task-local
// truth is 3 of 12 with four consecutive failures, i.e. REFUTED under the rule
// SERVER_INSTRUCTIONS states.
import { USED_KEYS, usedMemoryIds, exposedOnly } from './credit-trial-outcome.mjs'

/** A log with all three shapes: shown-only, opened, and written. */
const THREE_SHAPES = [
  '[tb-proxy] {"served":[900,901,902],"at":"2026-09-12T10:06:00.000Z"}',
  '[tb-proxy] {"tool":"brain_get_entry","allowed":true}',
  '[tb-proxy] {"read":[901],"at":"2026-09-12T10:07:00.000Z"}',
  '[tb-proxy] {"authored":[950],"at":"2026-09-12T10:20:00.000Z"}',
].join(String.fromCharCode(10))

test('USE is opened-or-written, never merely shown', () => {
  assert.deepEqual(USED_KEYS, ['authored', 'read'])
  assert.deepEqual(
    usedMemoryIds(THREE_SHAPES),
    [901, 950],
    'the opened row and the written row are used; the two that only appeared in ' +
      'a search result are not',
  )
  // The served set is unchanged — this narrows what is CREDITED, not what is
  // observed. Losing the exposure record would trade one blind spot for another.
  assert.deepEqual(servedMemoryIds(THREE_SHAPES), [900, 901, 902, 950])
  assert.deepEqual(
    exposedOnly(servedMemoryIds(THREE_SHAPES), usedMemoryIds(THREE_SHAPES)),
    [900, 902],
    'exposed = shown and never opened or written',
  )
})

test('a read row is not counted as a tool call by the usage witnesses', () => {
  // ⛔ Same constraint every other parallel line in the proxy obeys: run-dg.sh
  // greps `"tool":` and `"name":` to count calls, so a new id-bearing line that
  // carried either key would inflate the "did TerranSoul get used?" evidence
  // this campaign relies on to tell a real run from a phantom.
  const line = JSON.stringify({ read: [26809] })
  assert.ok(!line.includes('"tool":'))
  assert.ok(!line.includes('"name":'))
})

test('END TO END: only the memories the trial USED are credited, and the rest are disclosed', async () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: `used_memory_ids` was the served set, so
  // the observation carried [900, 901, 902, 950] and the summary line said
  // "4 served memories" with no mention that three of them were never opened.
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  const job = mkdtempSync(join(tmpdir(), 'tb-credit-used-'))
  const trial = join(job, 'alpha__aaa')
  mkdirSync(join(trial, 'verifier'), { recursive: true })
  // A PASS: this is the direction the old rule got wrong. A failure debited a
  // row nobody read, which is merely unfair; a pass PROMOTES one, and a clean
  // success outranks everything untested.
  writeFileSync(join(trial, 'verifier', 'reward.txt'), '1')
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-12T10:00:00.000000Z',
      finished_at: '2026-09-12T10:30:00.000000Z',
      agent_execution: {
        started_at: '2026-09-12T10:05:00.000000Z',
        finished_at: '2026-09-12T10:25:00.000000Z',
      },
    }),
  )
  const log = join(job, 'proxy.log')
  writeFileSync(log, THREE_SHAPES)

  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const params = JSON.parse(body).params
      calls.push(params)
      const inner =
        params.name === 'brain_observe_outcome'
          ? { memories_credited: params.arguments.used_memory_ids }
          : { memory_id: params.arguments.id, blocks_stamped: 1, head_stamped: false, changed: true }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  let stdout
  try {
    const r = await runScript(process.execPath, [script, trial, log, '--apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TERRANSOUL_MCP_URL: 'http://127.0.0.1:' + port + '/mcp',
        TERRANSOUL_MCP_TOKEN: 'stub-token',
      },
    })
    stdout = r.stdout
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const observe = calls.filter((c) => c.name === 'brain_observe_outcome')
  assert.equal(observe.length, 1)
  assert.deepEqual(
    observe[0].arguments.used_memory_ids,
    [901, 950],
    'a row that only appeared in a search result must not be paid for this pass',
  )
  for (const shownOnly of [900, 902]) {
    assert.ok(
      !observe[0].arguments.used_memory_ids.includes(shownOnly),
      `memory ${shownOnly} was shown and never opened — crediting it is how a ` +
        `notebook gets paid for another task's result`,
    )
  }

  // THE DISCLOSURE. Narrowing the credit set must be visible in the run's own
  // output, or a later reader cannot tell a deliberate exclusion from a bug.
  assert.match(stdout, /2 used memories: 901, 950/)
  assert.match(stdout, /exposed, not credited: 2/)

  // Stamping stays AUTHORED-only: a row the trial opened is advice it read, not
  // text it wrote, and stamping it would attribute this verdict to someone
  // else's block.
  const stamps = calls.filter((c) => c.name === 'brain_stamp_outcome')
  assert.deepEqual(stamps.map((c) => c.arguments.id), [950])
})

test('a trial that opened nothing and wrote nothing credits nobody', async () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: a search-only trial credited every row it
  // had been shown. This is the single most common shape in the corpus — a
  // trial that searches once, reads nothing, and passes.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  const job = mkdtempSync(join(tmpdir(), 'tb-credit-none-'))
  const trial = join(job, 'alpha__aaa')
  mkdirSync(join(trial, 'verifier'), { recursive: true })
  writeFileSync(join(trial, 'verifier', 'reward.txt'), '1')
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-12T10:00:00.000000Z',
      finished_at: '2026-09-12T10:30:00.000000Z',
      agent_execution: {
        started_at: '2026-09-12T10:05:00.000000Z',
        finished_at: '2026-09-12T10:25:00.000000Z',
      },
    }),
  )
  const log = join(job, 'proxy.log')
  writeFileSync(log, '[tb-proxy] {"served":[900,901],"at":"2026-09-12T10:06:00.000Z"}')

  // No MCP env: if anything were about to be credited the script would exit 3.
  const out = await runScript(process.execPath, [script, trial, log], {
    encoding: 'utf8',
    env: { ...process.env, TERRANSOUL_MCP_URL: '', TERRANSOUL_MCP_TOKEN: '' },
  }).catch((e) => ({ stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }))
  const all = String(out.stdout ?? '') + String(out.stderr ?? '')
  assert.doesNotMatch(all, /-> success/, 'nothing was used, so nothing may be credited')
  assert.match(all, /USED no memory/)
  assert.match(all, /2 were shown to it and not opened/)
})

// ── OUTCOME-VISIBLE-6 — a read of a REFUTED memory is EXPOSURE, not use ──────
//
// ⛔ WHY THESE FAIL ON THE PRE-CHANGE TREE. `USED_KEYS` was `['authored','read']`
// and nothing else looked at the read, so `reward=1` credited every opened id.
// `EXPOSED_KEYS`, `legacyReadIds`, `refutedBeforeTrial`, `fetchEntryOutcome` and
// `classifyExposedWhileRefuted` did not exist — the import below throws — and
// behaviourally the observation carried the refuted id, the log said
// `for 2 used memories`, and no line mentioned exposure.
//
// MEASURED 2026-09-13. Entry 26809 was refuted (10 consecutive graded failures)
// and QUARANTINED: since OUTCOME-VISIBLE-5 no tool call returns a refuted entry's
// body — what comes back is the `[REFUTED …]` verdict plus a graded index of the
// entry's update blocks. Trial redo09130830 read it, got that view, authored 27007
// and passed 9/9. This script logged
// `[credit] reward=1 -> success for 2 used memories: 26809, 27007`, so 26809 went
// to graded_successes 3 / consecutive_failures 0 / last_outcome success, both
// halves of `MemoryOutcome::is_refuted` answered no, and the brain served the full
// body again. A success earned by a reader who never saw the body released it.
import {
  EXPOSED_KEYS,
  legacyReadIds,
  readMemoryIds,
  exposedWhileRefutedIds,
  refutedBeforeTrial,
  classifyExposedWhileRefuted,
} from './credit-trial-outcome.mjs'

test('read_refuted is outside USED_KEYS, so the key alone withholds the credit', () => {
  assert.deepEqual(EXPOSED_KEYS, ['read_refuted'])
  assert.ok(!USED_KEYS.includes('read_refuted'))
  const log = [
    '[tb-proxy] {"served":[26809],"at":"2026-09-13T08:30:00.000Z"}',
    '[tb-proxy] {"read_refuted":[26809],"refuted_at_read":true,"at":"2026-09-13T08:31:00.000Z"}',
    '[tb-proxy] {"authored":[27007],"at":"2026-09-13T09:10:00.000Z"}',
  ].join(String.fromCharCode(10))
  assert.deepEqual(usedMemoryIds(log), [27007], '26809 was opened and is still not USED')
  assert.deepEqual(exposedWhileRefutedIds(log), [26809])
  assert.deepEqual(readMemoryIds(log), [], 'a refuted read is not also logged as a plain read')
})

test('a legacy read row is the ONLY one the ledger is consulted for', () => {
  // ⛔ PRECEDENCE. A row written by the current proxy carries `refuted_at_read` on
  // BOTH shapes, so `read` there means "the brain served this unbannered" and needs
  // no second opinion. A row without the marker predates the check and says nothing
  // — those, and only those, fall back to today's ledger. The other way round, a
  // row refuted SINCE the trial ran would retroactively decredit a read the brain
  // had answered in full.
  const log = [
    '[tb-proxy] {"read":[500],"at":"2026-09-01T10:00:00.000Z"}',
    '[tb-proxy] {"read":[501],"refuted_at_read":false,"at":"2026-09-13T10:00:00.000Z"}',
  ].join(String.fromCharCode(10))
  assert.deepEqual(legacyReadIds(log), [500])
  assert.deepEqual(readMemoryIds(log), [500, 501])
})

test('refutedBeforeTrial applies BOTH halves of is_refuted, and bounds the streak in time', () => {
  const start = Date.parse('2026-09-13T08:00:00Z')
  const before = Date.parse('2026-09-12T08:00:00Z')
  const after = Date.parse('2026-09-13T09:00:00Z')
  const refuted = { consecutive_failures: 10, last_outcome: 'failure', last_outcome_at: before }
  assert.equal(refutedBeforeTrial(refuted, start, 2), true)
  // A streak alone cannot say which way the LAST grading went: a row re-confirmed
  // after nine losses is not refuted.
  assert.equal(
    refutedBeforeTrial({ ...refuted, last_outcome: 'success' }, start, 2),
    false,
    'last_outcome is the other half of the predicate',
  )
  // `last_outcome` is absent on rows graded before V71 — absence of a direction is
  // not a verdict.
  assert.equal(refutedBeforeTrial({ consecutive_failures: 10 }, start, 2), false)
  assert.equal(refutedBeforeTrial({ ...refuted, consecutive_failures: 1 }, start, 2), false)
  // A grading newer than this trial's start is not evidence about what this trial
  // was served.
  assert.equal(refutedBeforeTrial({ ...refuted, last_outcome_at: after }, start, 2), false)
  // Threshold 0 means the product has the annotation OFF, so nothing is exposure.
  assert.equal(refutedBeforeTrial(refuted, start, 0), false)
  assert.equal(refutedBeforeTrial(null, start, 2), false)
})

test('AUTHORSHIP outranks both sources — an append to a refuted entry still credits it', async () => {
  // OUTCOME-VISIBLE-3's banner tells authors to record a NEW entry instead, but an
  // author who appends anyway is crediting the entry they appended to. Without this
  // the rule would be a deletion: nothing could ever release a refuted row.
  const out = await classifyExposedWhileRefuted({
    readIds: [26809],
    authored: [26809],
    readRefutedIds: [26809],
    legacyIds: [26809],
    callTool: async () => {
      throw new Error('the ledger must not be consulted for an authored id')
    },
    trialStartMs: Date.parse('2026-09-13T08:00:00Z'),
    threshold: 2,
  })
  assert.deepEqual(out.ids, [])
})

test('with no transport the legacy reads are reported UNCHECKED, never guessed', async () => {
  const said = []
  const out = await classifyExposedWhileRefuted({
    readIds: [500],
    legacyIds: [500],
    callTool: null,
    trialStartMs: Date.parse('2026-09-13T08:00:00Z'),
    threshold: 2,
    log: { error: (m) => said.push(m) },
  })
  assert.deepEqual(out.ids, [], 'a classifier that guessed would make dry and live runs disagree')
  assert.deepEqual(out.ledgerSkipped, [500])
  assert.match(said.join(' '), /before the refutation check/)
})

test('END TO END: a reward=1 read-while-refuted id logs exposed-while-refuted and is NOT sent', async () => {
  // The redo09130830 shape, end to end through `main()`: the trial read 26809 (the
  // proxy recorded the refuted view), authored 27007, and the grader gave it 1.
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  const job = mkdtempSync(join(tmpdir(), 'tb-credit-refuted-'))
  const trial = join(job, 'sam-cell-seg__redo09130830')
  mkdirSync(join(trial, 'verifier'), { recursive: true })
  writeFileSync(join(trial, 'verifier', 'reward.txt'), '1')
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      task_name: 'sam-cell-seg',
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-13T08:30:00.000000Z',
      finished_at: '2026-09-13T09:30:00.000000Z',
      agent_execution: {
        started_at: '2026-09-13T08:35:00.000000Z',
        finished_at: '2026-09-13T09:25:00.000000Z',
      },
    }),
  )
  const log = join(job, 'proxy.log')
  writeFileSync(
    log,
    [
      JSON.stringify({ served: [26809], at: '2026-09-13T08:40:00.000Z' }),
      JSON.stringify({
        read_refuted: [26809],
        refuted_at_read: true,
        at: '2026-09-13T08:41:00.000Z',
      }),
      JSON.stringify({ authored: [27007], at: '2026-09-13T09:10:00.000Z' }),
    ].join(String.fromCharCode(10)),
  )

  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const params = JSON.parse(body).params
      calls.push(params)
      const inner =
        params.name === 'brain_observe_outcome'
          ? { memories_credited: params.arguments.used_memory_ids }
          : { memory_id: params.arguments.id, blocks_stamped: 1, head_stamped: false, changed: true }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  let stdout
  try {
    const r = await runScript(process.execPath, [script, trial, log, '--apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TERRANSOUL_MCP_URL: 'http://127.0.0.1:' + port + '/mcp',
        TERRANSOUL_MCP_TOKEN: 'stub-token',
      },
    })
    stdout = r.stdout
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const observe = calls.filter((c) => c.name === 'brain_observe_outcome')
  assert.equal(observe.length, 1)
  assert.deepEqual(
    observe[0].arguments.used_memory_ids,
    [27007],
    'only the entry this trial AUTHORED; 26809 was read while quarantined',
  )
  assert.equal(observe[0].arguments.outcome, 'success')
  // ⛔ AND NO STAMP EITHER. A stamp writes the verdict into the entry's own block
  // headers, which for a refuted row would mark a losing construction as graded
  // success — the same release by a different door.
  assert.ok(
    !calls.some((c) => c.name === 'brain_stamp_outcome' && c.arguments.id === 26809),
    'no brain_stamp_outcome may name a memory that was read while refuted',
  )
  assert.deepEqual(
    calls.filter((c) => c.name === 'brain_stamp_outcome').map((c) => c.arguments.id),
    [27007],
  )
  assert.match(stdout, /exposed-while-refuted: 26809/)
  assert.match(stdout, /1 used memory: 27007/)
})

test('END TO END: a LEGACY read row is classified from the ledger, and still not credited', async () => {
  // Every archived job's rows are the legacy shape (a plain `read`, no
  // `refuted_at_read`), so without this fallback the rule would apply to new
  // sweeps only and the whole corpus would keep releasing quarantined bodies.
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runScript = promisify(execFile)
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const script = join(here, 'credit-trial-outcome.mjs')

  const job = mkdtempSync(join(tmpdir(), 'tb-credit-legacy-'))
  const trial = join(job, 'sam-cell-seg__redo09130830')
  mkdirSync(join(trial, 'verifier'), { recursive: true })
  writeFileSync(join(trial, 'verifier', 'reward.txt'), '1')
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      task_name: 'sam-cell-seg',
      agent_result: { n_output_tokens: 9000 },
      started_at: '2026-09-13T08:30:00.000000Z',
      finished_at: '2026-09-13T09:30:00.000000Z',
      agent_execution: {
        started_at: '2026-09-13T08:35:00.000000Z',
        finished_at: '2026-09-13T09:25:00.000000Z',
      },
    }),
  )
  const log = join(job, 'proxy.log')
  writeFileSync(
    log,
    [
      // Legacy: no `refuted_at_read` marker on either row.
      JSON.stringify({ read: [26809], at: '2026-09-13T08:41:00.000Z' }),
      JSON.stringify({ read: [26999], at: '2026-09-13T08:42:00.000Z' }),
    ].join(String.fromCharCode(10)),
  )

  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const params = JSON.parse(body).params
      calls.push(params)
      let inner
      if (params.name === 'brain_get_entry') {
        // 26809 is refuted and its streak predates the trial; 26999 is healthy.
        inner =
          params.arguments.id === 26809
            ? {
                id: 26809,
                content: '[REFUTED · 10 graded failures …]',
                outcome: {
                  graded_successes: 2,
                  graded_failures: 10,
                  consecutive_failures: 10,
                  last_outcome: 'failure',
                  last_outcome_at: Date.parse('2026-09-12T20:00:00Z'),
                },
              }
            : { id: 26999, content: 'an ordinary entry' }
      } else if (params.name === 'brain_observe_outcome') {
        inner = { memories_credited: params.arguments.used_memory_ids }
      } else {
        inner = { memory_id: params.arguments.id, blocks_stamped: 1, changed: true }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  let stdout
  try {
    const r = await runScript(process.execPath, [script, trial, log, '--apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TERRANSOUL_MCP_URL: 'http://127.0.0.1:' + port + '/mcp',
        TERRANSOUL_MCP_TOKEN: 'stub-token',
      },
    })
    stdout = r.stdout
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const fetched = calls.filter((c) => c.name === 'brain_get_entry').map((c) => c.arguments.id)
  assert.deepEqual(fetched.sort((a, b) => a - b), [26809, 26999], 'both legacy reads are checked')
  const observe = calls.filter((c) => c.name === 'brain_observe_outcome')
  assert.equal(observe.length, 1)
  assert.deepEqual(
    observe[0].arguments.used_memory_ids,
    [26999],
    'the refuted one is exposure; the healthy one is still an ordinary read',
  )
  assert.equal(calls.filter((c) => c.name === 'brain_stamp_outcome').length, 0)
  assert.match(stdout, /exposed-while-refuted: 26809/)
})
