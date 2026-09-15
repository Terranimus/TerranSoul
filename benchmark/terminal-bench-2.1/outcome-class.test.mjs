#!/usr/bin/env node
/**
 * Tests for `classifyTrial` — ONE outcome class per trial, from the joint
 * reading of result.json, the agent's evidence of work and the verifier's own
 * output.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: `classifyTrial` did not exist, so the
 * import from `./trial-outcome.mjs` throws and every case errors. That is not
 * the only reason they matter: the two central fixtures are the REAL shapes
 * the pre-change reader in this directory got wrong, and each case asserts
 * what `campaign-report.mjs`'s `classify` said about the same result.json, so
 * the difference is on the page rather than asserted from memory:
 *
 *   * reward 1 + AgentTimeoutError  — campaign-report says 'capability'. The
 *     2026-09-15 taxonomy counted five of these as capability failures.
 *   * reward 0 + "uvx: command not found" and no pytest session — campaign-report
 *     says 'capability'. Its tests never executed.
 *
 * Hermetic: every trial is a synthetic directory under the OS temp dir. The one
 * purity case reads the local dataset's task list when it is present and skips
 * cleanly when it is not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyTrial, isCleanPass, OUTCOME_CLASS, RUN_BROKE_AROUND_AGENT } from './trial-outcome.mjs'
import { classify as campaignReportClassify } from './campaign-report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const ROOT = mkdtempSync(join(tmpdir(), 'outcome-class-'))
let seq = 0

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * A synthetic trial directory. Only the files a case names are written, so an
 * absent artifact is absent on purpose.
 */
function makeTrial({ result, stdout, rewardTxt, ctrf, trajectory, sidecar, agentFiles, exceptionTxt }) {
  const dir = join(ROOT, `job${++seq}`, `demo-task__t${seq}`)
  mkdirSync(dir, { recursive: true })
  if (result !== undefined) {
    write(join(dir, 'result.json'), typeof result === 'string' ? result : JSON.stringify(result))
  }
  if (stdout !== undefined) write(join(dir, 'verifier', 'test-stdout.txt'), stdout)
  if (rewardTxt !== undefined) write(join(dir, 'verifier', 'reward.txt'), `${rewardTxt}\n`)
  if (ctrf) write(join(dir, 'verifier', 'ctrf.json'), JSON.stringify({ results: { tests: ctrf } }))
  if (trajectory) write(join(dir, 'agent', 'trajectory.json'), JSON.stringify({ steps: trajectory }))
  if (sidecar) write(join(dir, 'agent', '.terransoul-exec-failure.json'), JSON.stringify(sidecar))
  for (const [rel, text] of Object.entries(agentFiles ?? {})) write(join(dir, 'agent', rel), text)
  if (exceptionTxt !== undefined) write(join(dir, 'exception.txt'), exceptionTxt)
  return dir
}

const agentSteps = (n) => [
  { source: 'user', message: 'the instruction' },
  ...Array.from({ length: n }, (_, i) => ({ source: 'agent', message: `step ${i}` })),
]

/** A pytest run in the shape pytest prints it, with a ctrf report to match. */
function pytestRun({ passed = 0, failed = 0 }) {
  const lines = ['============================= test session starts ==============================']
  lines.push(`collected ${passed + failed} items`, '')
  for (let i = 0; i < passed; i++) lines.push(`PASSED ../tests/test_outputs.py::test_ok_${i}`)
  for (let i = 0; i < failed; i++) lines.push(`FAILED ../tests/test_outputs.py::test_bad_${i} - AssertionError`)
  const parts = [failed ? `${failed} failed` : null, passed ? `${passed} passed` : null].filter(Boolean)
  lines.push(`========================= ${parts.join(', ')} in 0.10s =========================`)
  const ctrf = [
    ...Array.from({ length: passed }, (_, i) => ({ name: `test_ok_${i}`, status: 'passed' })),
    ...Array.from({ length: failed }, (_, i) => ({ name: `test_bad_${i}`, status: 'failed' })),
  ]
  return { stdout: `${lines.join('\n')}\n`, ctrf }
}

const ran = (tokens = 24000) => ({ n_input_tokens: 900000, n_output_tokens: tokens, cost_usd: 1.2 })

test('reward 1 + AgentTimeoutError is exception-zeroed-grader-passed, NOT capability-fail', () => {
  // ⛔ REAL SHAPE (five trials in the 2026-09-15 corpus): the agent blew its
  // wall-clock cap, harbor graded whatever was on disk, and every test passed.
  const { stdout, ctrf } = pytestRun({ passed: 6 })
  const result = {
    verifier_result: { rewards: { reward: 1 } },
    exception_info: {
      exception_type: 'AgentTimeoutError',
      exception_message: 'Agent execution timed out after 3600.0 seconds',
    },
    agent_result: ran(),
  }
  const dir = makeTrial({ result, stdout, ctrf, rewardTxt: 1, trajectory: agentSteps(30) })

  const c = classifyTrial(dir)
  assert.equal(c.class, OUTCOME_CLASS.EXCEPTION_ZEROED_GRADER_PASSED)
  assert.equal(c.exceptionType, 'AgentTimeoutError', 'the exception type is kept')
  assert.match(c.reason, /^grader-passed-exception-zeroed:AgentTimeoutError$/)
  assert.ok(c.evidence.some((e) => /6\/6 passed/.test(e)), `evidence names the passing grader: ${c.evidence}`)
  assert.equal(isCleanPass(result), false, 'the campaign still scores it 0')

  // The pre-change reader in this directory called it a capability failure.
  assert.equal(campaignReportClassify(result), 'capability')
})

test('reward 1 + an API cut-off is exception-zeroed too — the exception type decides nothing here', () => {
  // ⛔ REAL SHAPE: UnknownApiError after the work was done; 4/4 grader tests passed.
  const { stdout, ctrf } = pytestRun({ passed: 4 })
  const result = {
    verifier_result: { rewards: { reward: 1 } },
    exception_info: { exception_type: 'UnknownApiError', exception_message: 'Command failed (exit 1)' },
    agent_result: ran(60000),
  }
  const c = classifyTrial(makeTrial({ result, stdout, ctrf, rewardTxt: 1, trajectory: agentSteps(18) }))
  assert.equal(c.class, OUTCOME_CLASS.EXCEPTION_ZEROED_GRADER_PASSED)
  assert.equal(c.exceptionType, 'UnknownApiError')
  // campaign-report filed it under infra — a third reading of the same trial.
  assert.equal(campaignReportClassify(result), 'infra')
})

test('"uvx: command not found" with no pytest session is verifier-never-ran, even with reward 0', () => {
  // ⛔ REAL SHAPE (one trial in the 2026-09-15 corpus): the test runner's
  // installer could not reach the network, the runner was never installed, and
  // the verifier wrote reward 0 anyway. No test executed.
  const stdout = [
    'Reading package lists...',
    'downloading uv 0.9.5 x86_64-unknown-linux-gnu',
    "curl: (7) Failed to connect to example.invalid port 443 after 12 ms: Couldn't connect to server",
    'failed to download https://example.invalid/uv.tar.gz',
    '/tests/test.sh: line 10: /root/.local/bin/env: No such file or directory',
    '/tests/test.sh: line 19: uvx: command not found',
    '',
  ].join('\n')
  const result = { verifier_result: { rewards: { reward: 0 } }, exception_info: null, agent_result: ran(7048) }
  const dir = makeTrial({ result, stdout, rewardTxt: 0, trajectory: agentSteps(9) })

  const c = classifyTrial(dir)
  assert.equal(c.class, OUTCOME_CLASS.VERIFIER_NEVER_RAN)
  assert.equal(c.reason, 'tool-or-network-failure-before-tests')
  assert.ok(c.evidence.some((e) => /uvx: command not found/.test(e)), `evidence quotes the line: ${c.evidence}`)
  assert.ok(c.evidence.some((e) => /Failed to connect/.test(e)))
  assert.ok(c.evidence.includes('no pytest session banner'))

  assert.equal(campaignReportClassify(result), 'capability', 'the pre-change reader scored it a capability failure')
})

test('the same failure words INSIDE a real pytest run do not make it verifier-never-ran', () => {
  // A server task's own failing assertion can say "Connection refused". Inside
  // a test session those words belong to a test, so this is a capability fail.
  const { ctrf } = pytestRun({ passed: 2, failed: 1 })
  const stdout = [
    '============================= test session starts ==============================',
    'collected 3 items',
    'E       ConnectionError: Connection refused',
    'FAILED ../tests/test_outputs.py::test_bad_0 - ConnectionError',
    '========================= 1 failed, 2 passed in 0.03s ==========================',
  ].join('\n')
  const result = { verifier_result: { rewards: { reward: 0 } }, agent_result: ran() }
  const c = classifyTrial(makeTrial({ result, stdout, ctrf, rewardTxt: 0, trajectory: agentSteps(5) }))
  assert.equal(c.class, OUTCOME_CLASS.CAPABILITY_FAIL)
})

test('a missing test-stdout with a missing reward is NOT verifier-never-ran by itself: nothing shows the verifier started', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE, which filed this under verifier-never-ran.
  // That class now means ONE thing: the verifier started and failed before its
  // tests ran. An exception that names no verifier step, with no verifier
  // output, does not show that, so this is ungraded-other with its reason kept.
  const result = {
    verifier_result: null,
    exception_info: { exception_type: 'SomeVerifierError', exception_message: 'verifier did not start' },
    agent_result: ran(),
  }
  const c = classifyTrial(makeTrial({ result, trajectory: agentSteps(4) }))
  assert.equal(c.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(c.reason, 'no-test-output-and-no-reward:after-SomeVerifierError')
})

test('zero output tokens and no agent step is a non-run', () => {
  // ⛔ The §26 shape: 0 input, 0 output tokens, a revoked credential, nothing
  // ran — ported from merge-sweep.sh's trial_agent_produced_work.
  const result = {
    verifier_result: null,
    exception_info: { exception_type: 'UnknownApiError', exception_message: '401 OAuth access token has been revoked' },
    agent_result: { n_input_tokens: 0, n_output_tokens: 0 },
  }
  const c = classifyTrial(makeTrial({ result, trajectory: [{ source: 'user', message: 'the instruction' }] }))
  assert.equal(c.class, OUTCOME_CLASS.NON_RUN)
  assert.equal(c.reason, 'no-output-tokens-no-agent-step')
  assert.ok(c.evidence.some((e) => /no output tokens, no model turn/.test(e)))

  // A GRADED zero with an explicit zero-token count is a non-run too: the
  // verifier graded an untouched container.
  const graded = { verifier_result: { rewards: { reward: 0 } }, agent_result: { n_input_tokens: 0, n_output_tokens: 0 } }
  const g = classifyTrial(makeTrial({ result: graded, ...pytestRun({ failed: 2 }), rewardTxt: 0 }))
  assert.equal(g.class, OUTCOME_CLASS.NON_RUN)
})

test('non-run FAILS SAFE: any one of the three evidence sources keeps a trial a run', () => {
  const noTokens = { verifier_result: null, exception_info: { exception_type: 'UnknownApiError' }, agent_result: null }
  // an agent step in the trajectory
  const t = classifyTrial(makeTrial({ result: noTokens, trajectory: agentSteps(1) }))
  assert.notEqual(t.class, OUTCOME_CLASS.NON_RUN)
  // a model turn in the host-side capture
  const s = classifyTrial(makeTrial({ result: noTokens, sidecar: [{ assistant_turns: 3 }] }))
  assert.notEqual(s.class, OUTCOME_CLASS.NON_RUN)
  // and a GRADED trial whose token count is merely ABSENT is never a non-run:
  // absence of a count is not a count of zero.
  const graded = { verifier_result: { rewards: { reward: 0 } }, agent_result: null }
  const g = classifyTrial(makeTrial({ result: graded, ...pytestRun({ passed: 1, failed: 1 }), rewardTxt: 0 }))
  assert.equal(g.class, OUTCOME_CLASS.CAPABILITY_FAIL)
})

test('clean-pass and capability-fail agree with isCleanPass on every class of fixture', () => {
  const pass = pytestRun({ passed: 3 })
  const fail = pytestRun({ passed: 2, failed: 1 })
  const fixtures = {
    'clean-pass': { result: { verifier_result: { rewards: { reward: 1 } }, agent_result: ran() }, ...pass, rewardTxt: 1 },
    'capability-fail': { result: { verifier_result: { rewards: { reward: 0 } }, agent_result: ran() }, ...fail, rewardTxt: 0 },
    'capability-fail-timeout': {
      result: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: { exception_type: 'AgentTimeoutError' },
        agent_result: ran(),
      },
      ...fail,
      rewardTxt: 0,
    },
    'exception-zeroed': {
      result: {
        verifier_result: { rewards: { reward: 1 } },
        exception_info: { exception_type: 'AgentTimeoutError' },
        agent_result: ran(),
      },
      ...pass,
      rewardTxt: 1,
    },
    'graded-zero-under-api-cutoff': {
      result: {
        verifier_result: { rewards: { reward: 0 } },
        exception_info: { exception_type: 'UnknownApiError' },
        agent_result: ran(),
      },
      ...fail,
      rewardTxt: 0,
    },
    'non-run': { result: { verifier_result: null, exception_info: { exception_type: 'RuntimeError' }, agent_result: null } },
  }
  const seen = {}
  for (const [name, f] of Object.entries(fixtures)) {
    const c = classifyTrial(makeTrial(f))
    seen[name] = c
    assert.equal(c.class === OUTCOME_CLASS.CLEAN_PASS, isCleanPass(f.result), `${name}: clean-pass iff isCleanPass`)
    if (c.class === OUTCOME_CLASS.CAPABILITY_FAIL) assert.equal(isCleanPass(f.result), false, name)
  }
  assert.equal(seen['clean-pass'].class, OUTCOME_CLASS.CLEAN_PASS)
  assert.equal(seen['capability-fail'].class, OUTCOME_CLASS.CAPABILITY_FAIL)
  assert.equal(seen['capability-fail'].reason, 'grader-ran-tests-some-failed')
  // The agent spent its budget and the tests it left behind failed: capability,
  // with the exception disclosed in the reason, per trial-outcome.mjs's
  // 2026-09-08 measurement (35 of 43 errored graded zeros were timeouts).
  assert.equal(seen['capability-fail-timeout'].class, OUTCOME_CLASS.CAPABILITY_FAIL)
  assert.equal(seen['capability-fail-timeout'].reason, 'grader-ran-tests-some-failed:with-AgentTimeoutError')
  // An API cut-off before the agent finished is not a capability reading; it has its own class.
  assert.equal(seen['graded-zero-under-api-cutoff'].class, 'api-cutoff-ungraded')
  assert.equal(seen['graded-zero-under-api-cutoff'].reason, 'graded-zero-under-run-breaking-exception:UnknownApiError')
  assert.equal(seen['non-run'].class, OUTCOME_CLASS.NON_RUN)
})

test('every decision carries a one-line machine-readable reason and bounded evidence strings', () => {
  // Agent output keeps this fixture on the plain 'result-json-unreadable' path;
  // with nothing at all on disk it would be a non-run (the cases below).
  const unreadable = makeTrial({ result: '{not json', trajectory: agentSteps(1) })
  const u = classifyTrial(unreadable)
  assert.equal(u.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(u.reason, 'result-json-unreadable')

  const { stdout, ctrf } = pytestRun({ passed: 1, failed: 400 })
  const c = classifyTrial(
    makeTrial({ result: { verifier_result: { rewards: { reward: 0 } }, agent_result: ran() }, stdout, ctrf, rewardTxt: 0 }),
  )
  for (const d of [u, c]) {
    assert.match(d.reason, /^[a-z0-9:_.-]+$/i, `reason is one machine-readable token: ${d.reason}`)
    assert.ok(Array.isArray(d.evidence) && d.evidence.length > 0)
    for (const e of d.evidence) {
      assert.equal(typeof e, 'string')
      assert.ok(!/\n/.test(e), 'evidence is one line')
      assert.ok(e.length <= 201, `evidence is bounded: ${e.length}`)
    }
  }
  assert.ok(Object.values(OUTCOME_CLASS).includes(c.class))
})

test('a parsed result plus a verifier dir classifies the same as the trial dir', () => {
  const { stdout, ctrf } = pytestRun({ passed: 6 })
  const result = {
    verifier_result: { rewards: { reward: 1 } },
    exception_info: { exception_type: 'AgentTimeoutError' },
    agent_result: ran(),
  }
  const dir = makeTrial({ result, stdout, ctrf, rewardTxt: 1, trajectory: agentSteps(3) })
  const fromDir = classifyTrial(dir)
  const fromParts = classifyTrial({ result, verifierDir: join(dir, 'verifier'), trialDir: dir })
  assert.deepEqual(fromParts, fromDir)
})

// ── result.json unreadable: the rest of the trial still speaks ──────────────

const HARBOR_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "trial.py", line 1, in run',
  'harbor.agents.installed.base.ApiRateLimitError: Command failed (exit 143): run the agent',
  'stdout: {"type":"system"}',
  '',
].join('\n')

test('an UNREADABLE result.json does not stop the reader: a corroborated graded pass is a clean pass', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: classifyTrial returned
  // 'result-json-unreadable' before opening any other file of the trial.
  // MEASURED 2026-09-15: 33 in-scope trials have no result.json (all ENOENT).
  // Two carry a graded pass (verifier/reward.txt 1, every pytest test passing:
  // 2/2 and 7/7) and 18 left no agent output and no verifier output. The old
  // reader filed all 33 as ungraded-other.
  const pass = pytestRun({ passed: 2 })
  const c = classifyTrial(
    makeTrial({ ...pass, rewardTxt: 1, trajectory: agentSteps(12), agentFiles: { 'agent-stdout.txt': '{"type":"assistant"}\n' } }),
  )
  assert.equal(c.class, OUTCOME_CLASS.CLEAN_PASS)
  assert.equal(c.reason, 'graded-pass-no-exception:result-json-unreadable')
  assert.ok(c.evidence.some((e) => /ctrf 2\/2 passed/.test(e)), `evidence names the passing tests: ${c.evidence}`)
  assert.ok(c.evidence.some((e) => /verifier\/reward\.txt 1/.test(e)))
  assert.ok(c.evidence.some((e) => /result\.json unreadable/.test(e)), 'the missing result.json is disclosed')
})

test('with result.json unreadable, graded-pass evidence is NOT a clean pass when exception evidence exists, and a lone reward.txt is never one', () => {
  const pass = pytestRun({ passed: 2 })
  // harbor's own traceback file
  const e = classifyTrial(makeTrial({ ...pass, rewardTxt: 1, trajectory: agentSteps(3), exceptionTxt: HARBOR_TRACEBACK }))
  assert.equal(e.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(e.reason, 'result-json-unreadable:graded-pass-with-exception-evidence')
  assert.ok(e.evidence.some((x) => /exception\.txt: harbor\.agents\.installed\.base\.ApiRateLimitError/.test(x)), `${e.evidence}`)
  // the host-side capture is written only for a FAILED agent command: exception evidence too
  const h = classifyTrial(makeTrial({ ...pass, rewardTxt: 1, trajectory: agentSteps(3), sidecar: [{ assistant_turns: 3, return_code: 1 }] }))
  assert.equal(h.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(h.reason, 'result-json-unreadable:graded-pass-with-exception-evidence')
  // reward.txt 1 that no test run corroborates: the stale-reward shape runWasSound documents
  const stale = classifyTrial(makeTrial({ rewardTxt: 1, trajectory: agentSteps(3) }))
  assert.equal(stale.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(stale.reason, 'result-json-unreadable')
  // reward.txt 1 contradicted by a failed test
  const contradicted = classifyTrial(makeTrial({ ...pytestRun({ passed: 1, failed: 1 }), rewardTxt: 1, trajectory: agentSteps(3) }))
  assert.equal(contradicted.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(contradicted.reason, 'result-json-unreadable')
  // a graded zero stays ungraded-other: there is no result.json to say whether the run was sound
  const zero = classifyTrial(makeTrial({ ...pytestRun({ failed: 2 }), rewardTxt: 0, trajectory: agentSteps(3) }))
  assert.equal(zero.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(zero.reason, 'result-json-unreadable')
})

test('with result.json unreadable, no agent output and no verifier output is a non-run, and any agent output is not', () => {
  // Only the harness installing the agent ran: a subdirectory of agent/ is not agent output.
  const setupOnly = classifyTrial(
    makeTrial({
      agentFiles: { 'setup/stdout.txt': 'Setting up packages ...\n' },
      exceptionTxt: 'harbor.agents.installed.base.NonZeroAgentExitCodeError: Command failed (exit 143): install\n',
    }),
  )
  assert.equal(setupOnly.class, OUTCOME_CLASS.NON_RUN)
  assert.equal(setupOnly.reason, 'result-json-unreadable:no-agent-output-no-verifier-output')
  assert.ok(setupOnly.evidence.some((x) => /NonZeroAgentExitCodeError/.test(x)), 'the exception is still disclosed')
  // a host capture with zero model turns and nothing else
  const zeroTurns = classifyTrial(makeTrial({ sidecar: [{ assistant_turns: 0, return_code: 143 }] }))
  assert.equal(zeroTurns.class, OUTCOME_CLASS.NON_RUN)
  // an empty trial directory, with a torn result.json
  const torn = classifyTrial(makeTrial({ result: '{"verifier_res' }))
  assert.equal(torn.class, OUTCOME_CLASS.NON_RUN)
  assert.ok(torn.evidence.some((x) => /result\.json unreadable/.test(x)))

  // NEVER A GUESS: the agent's own raw stdout keeps a trial out of non-run...
  const stdoutOnly = classifyTrial(makeTrial({ agentFiles: { 'agent-stdout.txt': '{"type":"system"}\n' } }))
  assert.equal(stdoutOnly.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(stdoutOnly.reason, 'result-json-unreadable')
  // ...an EMPTY stdout file does not...
  const emptyStdout = classifyTrial(makeTrial({ agentFiles: { 'agent-stdout.txt': '' } }))
  assert.equal(emptyStdout.class, OUTCOME_CLASS.NON_RUN)
  // ...and verifier output alone keeps it out as well.
  const verifierOnly = classifyTrial(makeTrial({ stdout: 'verifier started\n' }))
  assert.equal(verifierOnly.class, OUTCOME_CLASS.UNGRADED_OTHER)
  assert.equal(verifierOnly.reason, 'result-json-unreadable')
})

// ── one class, one meaning ──────────────────────────────────────────────────

test('an API cut-off with no usable grade is api-cutoff-ungraded, whether the grader wrote a zero or nothing', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: the class did not exist. MEASURED 2026-09-15
  // over 1383 in-scope trials: 13 of the 17 'verifier-never-ran' trials were an
  // agent run cut off by ApiRateLimitError (12) or UnknownApiError (1), with no
  // test output and no reward, and 22 graded zeros under the same two
  // exceptions sat in 'ungraded-other'. One cause, no capability reading in
  // either shape, split across two classes, one of them shared with a real
  // verifier failure.
  const cut = 'Command failed (exit 137): run the agent'
  const noGrade = {
    verifier_result: null,
    exception_info: { exception_type: 'ApiRateLimitError', exception_message: cut },
    agent_result: ran(30000),
  }
  const a = classifyTrial(makeTrial({ result: noGrade, trajectory: agentSteps(20) }))
  assert.equal(a.class, 'api-cutoff-ungraded')
  assert.equal(a.reason, 'no-test-output-and-no-reward:after-ApiRateLimitError')
  assert.equal(a.exceptionType, 'ApiRateLimitError')

  const gradedZero = {
    verifier_result: { rewards: { reward: 0 } },
    exception_info: { exception_type: 'UnknownApiError', exception_message: cut },
    agent_result: ran(),
  }
  const b = classifyTrial(makeTrial({ result: gradedZero, ...pytestRun({ passed: 1, failed: 2 }), rewardTxt: 0, trajectory: agentSteps(8) }))
  assert.equal(b.class, 'api-cutoff-ungraded')
  assert.equal(b.reason, 'graded-zero-under-run-breaking-exception:UnknownApiError')
  assert.equal(OUTCOME_CLASS.API_CUTOFF_UNGRADED, 'api-cutoff-ungraded')

  // ONE rule for every exception in RUN_BROKE_AROUND_AGENT, graded zero or not.
  for (const exc of RUN_BROKE_AROUND_AGENT) {
    const none = classifyTrial(makeTrial({ result: { ...noGrade, exception_info: { exception_type: exc } }, trajectory: agentSteps(2) }))
    assert.equal(none.class, OUTCOME_CLASS.API_CUTOFF_UNGRADED, `${exc}, no grade`)
    const zero = classifyTrial(
      makeTrial({ result: { ...gradedZero, exception_info: { exception_type: exc } }, ...pytestRun({ failed: 1 }), rewardTxt: 0, trajectory: agentSteps(2) }),
    )
    assert.equal(zero.class, OUTCOME_CLASS.API_CUTOFF_UNGRADED, `${exc}, graded zero`)
  }

  // The boundaries of the rule are unchanged:
  // a graded PASS under a cut-off is still exception-zeroed-grader-passed,
  const passed = classifyTrial(
    makeTrial({ result: { ...gradedZero, verifier_result: { rewards: { reward: 1 } } }, ...pytestRun({ passed: 3 }), rewardTxt: 1, trajectory: agentSteps(8) }),
  )
  assert.equal(passed.class, OUTCOME_CLASS.EXCEPTION_ZEROED_GRADER_PASSED)
  // a cut-off that produced NO agent work is still a non-run,
  const never = classifyTrial(
    makeTrial({ result: { ...noGrade, agent_result: { n_input_tokens: 0, n_output_tokens: 0 } }, trajectory: [{ source: 'user', message: 'the instruction' }] }),
  )
  assert.equal(never.class, OUTCOME_CLASS.NON_RUN)
  // and AgentTimeoutError is not a cut-off: the agent spent its budget and its tests failed.
  const timeout = classifyTrial(
    makeTrial({ result: { ...gradedZero, exception_info: { exception_type: 'AgentTimeoutError' } }, ...pytestRun({ passed: 1, failed: 1 }), rewardTxt: 0, trajectory: agentSteps(8) }),
  )
  assert.equal(timeout.class, OUTCOME_CLASS.CAPABILITY_FAIL)
})

test('verifier-never-ran means ONE thing: the verifier started and failed before its tests ran', () => {
  // ⛔ FAILS ON THE PRE-CHANGE TREE: this trial got the catch-all reason
  // 'no-test-output-and-no-reward:after-AddTestsDirError', the same reason an
  // API cut-off got. MEASURED 2026-09-15: 3 in-scope trials. harbor's
  // Verifier.verify raises AddTestsDirError while uploading the tests
  // directory, strictly before it executes the test script, and each of the
  // three has an empty verifier/ directory and a verifier phase of about 0.1 s.
  const result = {
    verifier_result: null,
    exception_info: { exception_type: 'AddTestsDirError', exception_message: 'Failed to add tests directory to environment.' },
    agent_result: ran(45000),
    verifier: { started_at: '2026-09-08T02:09:40.014518Z', finished_at: '2026-09-08T02:09:40.117576Z' },
  }
  const dir = makeTrial({ result, trajectory: agentSteps(30) })
  mkdirSync(join(dir, 'verifier'), { recursive: true })
  const c = classifyTrial(dir)
  assert.equal(c.class, OUTCOME_CLASS.VERIFIER_NEVER_RAN)
  assert.equal(c.reason, 'harness-setup-before-tests')
  assert.ok(c.evidence.some((e) => /AddTestsDirError/.test(e)), `${c.evidence}`)
  assert.ok(c.evidence.some((e) => /^verifier phase lasted 0\.103 s$/.test(e)), `${c.evidence}`)
  assert.ok(c.evidence.includes('verifier/ holds no file'))

  // If the verifier left output behind, the evidence no longer shows that no test ran.
  const leftOutput = classifyTrial(makeTrial({ result, stdout: 'partial verifier output\n', trajectory: agentSteps(3) }))
  assert.notEqual(leftOutput.class, OUTCOME_CLASS.VERIFIER_NEVER_RAN)

  // The verifier's own tool or network failure keeps its class (see the uvx case above).
})

/**
 * Source with block and line comments removed. Provenance comments in this
 * directory cite the task a defect was measured on (trial-outcome.mjs's header
 * has since 2026-09-03), and that is documentation, not a signal. The CODE is
 * what must stay generic, so the CODE is what the purity case reads.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

test('the classifier and its evidence reader carry no benchmark task identifier in CODE', (t) => {
  // rules/bench-agi-purity.md: signals are SHAPES of runner output, never a task.
  // This case CAN fail: it did, on its first run, against trial-outcome.mjs's
  // header comments — which is why comments are now stripped, and only them.
  const tasksDir = process.env.TB21_DIR
    ? join(process.env.TB21_DIR, 'tasks')
    : 'D:/Git/terminal-bench-2-1/tasks'
  if (!existsSync(tasksDir)) {
    t.skip(`task list not present at ${tasksDir}`)
    return
  }
  const names = readdirSync(tasksDir).filter((n) => n.length >= 6)
  assert.ok(names.length > 10, 'the task list is real')
  for (const file of ['trial-evidence.mjs', 'trial-outcome.mjs']) {
    const src = codeOnly(readFileSync(join(HERE, file), 'utf8'))
    const hits = names.filter((n) => src.includes(n))
    assert.deepEqual(hits, [], `${file} names a benchmark task`)
  }
})
