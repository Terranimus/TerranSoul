/**
 * Tests for `memory-outcome-audit.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so the
 * import throws.
 *
 * THE DEFECT IT EXISTS FOR, measured 2026-09-01: memory 26496 held a wrong
 * solution recipe for one task. Served -> 0/15 passes; absent -> 14/19. The
 * campaign had been calling that task a coin flip for weeks. Nothing was asking
 * the corpus-level question "is there a memory whose presence predicts
 * failure?", so nothing found it.
 *
 * Hermetic: string fixtures only. No job dirs, no store, no brain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { servedFromProxyLog, servedFromTrajectory } from './memory-outcome-audit.mjs'

test('proxy served lines are read, and non-JSON lines are tolerated', () => {
  // The proxy log is a MIXED stream — diagnostics interleaved with JSON. A
  // parser that throws on the first prose line recovers nothing.
  const log = [
    '[proxy] starting on :7425',
    '{"served":[26496,26531]}',
    'garbage ][ not json',
    '{"tool":"brain_search","allowed":true}',
    '{"served":[26496,26550]}',
  ].join('\n')
  const ids = servedFromProxyLog(log)
  assert.deepEqual([...ids].sort((a, b) => a - b), [26496, 26531, 26550])
})

test('trajectory ids are read STRUCTURALLY, not as bare numbers', () => {
  // The escaped form is the COMMON one: a search result is a tool result nested
  // inside the transcript's own JSON, so ids arrive as \\"id\\": on most real
  // trajectories. Both shapes must be read.
  const escaped = JSON.stringify({
    steps: [{ message: 'search result: [{"id": 26496, "content": "..."}]' }],
  })
  assert.ok(servedFromTrajectory(escaped).has(26496), 'an ESCAPED id must be read')

  const plain = '{"results":[{"id": 26550, "content":"x"}]}'
  assert.ok(servedFromTrajectory(plain).has(26550), 'a PLAIN id must be read')

  // ⛔ The "advertisement is not use" error in a new place. A transcript is
  // full of five-digit numbers -- ports, byte counts, timestamps -- and counting
  // them as memory ids would manufacture correlations out of noise.
  const prose = 'listening on port 26531 and wrote 26999 bytes'
  const ids = servedFromTrajectory(prose)
  assert.ok(!ids.has(26531), 'a bare number in prose must NOT be read as a memory id')
  assert.ok(!ids.has(26999), 'a bare number in prose must NOT be read as a memory id')
})

test('an empty or unreadable source yields no ids rather than throwing', () => {
  // The audit runs over hundreds of trial dirs; one malformed file must not
  // abort the scan and silently shorten the corpus.
  assert.equal(servedFromProxyLog('').size, 0)
  assert.equal(servedFromProxyLog(null).size, 0)
  assert.equal(servedFromTrajectory('').size, 0)
  assert.equal(servedFromTrajectory(undefined).size, 0)
})

test('ids are deduplicated — one memory served twice is one observation', () => {
  // Otherwise a memory returned by several searches in one trial would count as
  // several trials, inflating exactly the number the audit reports.
  const traj = '{"id": 26496} ... {"id":26496} ... {"id": 26496}'
  assert.equal(servedFromTrajectory(traj).size, 1)
})

// ⛔ FAILS ON THE PRE-CHANGE TREE: `graded trials scanned` was 3, not 1.
//
// WHY IT MATTERS HERE MORE THAN IN A REPORT: this file's output is what decides
// a stored memory is poison, and acting on it means deleting or demoting that
// memory. An unfair trial distorts BOTH arms at once — a trial that never ran
// served nothing, so it lands in the NOT-SERVED baseline as a failure and makes
// every served memory look better; the 8 trials the API cut off mid-run had
// already been served memories, so they make those look worse.
test('trials that were never a fair test are not scanned', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const base = mkdtempSync(join(tmpdir(), 'moa-'))
  const jobs = join(base, 'jobs1', 'job1')
  const mk = (name, result) => {
    const d = join(jobs, name)
    mkdirSync(join(d, 'verifier'), { recursive: true })
    writeFileSync(join(d, 'verifier', 'reward.txt'), '0')
    writeFileSync(join(d, 'result.json'), JSON.stringify(result))
  }
  mk('alpha__aaa', {
    agent_result: { n_output_tokens: 9000 },
    exception_info: { exception_type: 'ApiRateLimitError' },
  })
  mk('beta__bbb', { agent_result: { n_output_tokens: 0 } })
  // ⛔ THE CONVERSE: a timeout means the agent spent its whole budget without
  // finishing, which IS a capability failure and must still be scanned.
  mk('gamma__ccc', {
    agent_result: { n_output_tokens: 9000 },
    exception_info: { exception_type: 'AgentTimeoutError' },
  })

  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const out = execFileSync(
    process.execPath,
    [join(here, 'memory-outcome-audit.mjs'), join(base, 'jobs1')],
    { encoding: 'utf8' },
  )
  assert.match(out, /graded trials scanned\s+: 1/, 'only the timeout is a graded verdict')
})
