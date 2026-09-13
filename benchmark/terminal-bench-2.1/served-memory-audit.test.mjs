/**
 * Tests for `served-memory-audit.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist.
 *
 * THE GAP IT EXISTS FOR, measured 2026-09-02: of 2131 memories in the
 * production brain, 21 carried a success and ZERO carried a failure. Nothing
 * anywhere could answer "which memories are being served into failures?", so a
 * lesson could be cited by successive attempts as their deciding evidence, be
 * wrong, and keep importance 10 forever.
 *
 * Hermetic: string and Map fixtures only. No job dirs, no brain, no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { servedIdsFromTranscript, rank, collect } from './served-memory-audit.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const line = (obj) => JSON.stringify(obj)
const toolResult = (text) =>
  line({ message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] } })

test('it recovers the memory ids a brain_search put in front of the agent', () => {
  const t = [
    line({ message: { content: [{ type: 'text', text: 'thinking out loud' }] } }),
    toolResult(JSON.stringify([{ id: 25952, content: 'a' }, { id: 10330, content: 'b' }])),
    toolResult(JSON.stringify([{ id: 25952, content: 'a' }, { id: 24814, content: 'c' }])),
  ].join('\n')
  assert.deepEqual(servedIdsFromTranscript(t).sort((a, b) => a - b), [10330, 24814, 25952])
})

test('non-retrieval tool output is ignored rather than mined for stray integers', () => {
  // A trial runs dozens of shell commands. Their output is not a retrieval, and
  // treating any `id` it happens to contain as a served memory would invent
  // evidence.
  const t = [
    toolResult('total 48\ndrwxr-xr-x 1 root root 4096 Sep  2 10:00 .'),
    toolResult('{"not":"an array"}'),
    toolResult('[{"no_id_field":1}]'),
    toolResult('plain prose mentioning id 25952 in passing'),
  ].join('\n')
  assert.deepEqual(servedIdsFromTranscript(t), [])
})

test('LIFT is measured against the base rate of the tasks a memory was served on', () => {
  // ⛔ THE WHOLE POINT. A raw failure count ranks by task difficulty, not by
  // anything the memory did: on a task nothing ever passes, EVERY served row
  // shows 100% failure and none of it means a thing.
  const perMemory = new Map([
    // served only on an impossible task -> high failure rate, ZERO lift
    [1, new Map([['impossible', { served: 10, failed: 10 }]])],
    // served on an easy task and failing far more than that task does -> LIFT
    [2, new Map([['easy', { served: 10, failed: 6 }]])],
  ])
  const taskTotals = new Map([
    ['impossible', { n: 50, failed: 50 }],
    ['easy', { n: 50, failed: 5 }],
  ])
  const ranked = rank(perMemory, taskTotals, 3)
  assert.equal(ranked[0].id, 2, 'the over-represented row must rank first')
  assert.ok(Math.abs(ranked[0].lift - 0.5) < 1e-9, `expected lift 0.5, got ${ranked[0].lift}`)
  const impossible = ranked.find((r) => r.id === 1)
  assert.equal(impossible.rate, 1, 'it did fail every time')
  assert.ok(Math.abs(impossible.lift) < 1e-9, 'but its lift must be 0 — the task fails regardless')
})

test('an id band can be confined, because ids are per-brain and not comparable', () => {
  // ⛔ THE DEFECT THIS PINS. The first run ranked a 1xxx band (isolated bench
  // brain, :7424) beside a 25xxx band (production, :7423). Those are DIFFERENT
  // memories with colliding numbers, and summing them invents a signal.
  const perMemory = new Map([
    [1153, new Map([['t', { served: 9, failed: 9 }]])],
    [25952, new Map([['t', { served: 9, failed: 9 }]])],
  ])
  const taskTotals = new Map([['t', { n: 10, failed: 5 }]])
  const all = rank(perMemory, taskTotals, 3)
  assert.equal(all.length, 2, 'unbounded, both bands are present')
  const prod = rank(perMemory, taskTotals, 3, 20000)
  assert.deepEqual(prod.map((r) => r.id), [25952], 'confined, only the production band remains')
})

// ⛔ FAILS ON THE PRE-CHANGE TREE: collect() read verifier/reward.txt alone, so
// both trials below contributed a `failed` verdict for memory 4242.
//
// THIS COLLECTOR FEEDS TWO CONSUMERS: the LIFT report here, and the bulk
// `--apply` writer in backfill-served-outcomes.mjs. So an unfair trial does two
// separate kinds of damage — it distorts the base rate, and it writes a real
// failure increment into memory ranking. Measured 2026-09-08: 8 trials were cut
// off mid-run by the API and every one had already been served memories.
test('a trial that was never a fair test contributes no verdict', () => {
  const base = mkdtempSync(join(tmpdir(), 'sma-'))
  const mk = (name, result) => {
    const tp = join(base, 'jobs-x', 'job1', name)
    const sdir = join(tp, 'agent', 'sessions', 'projects', '-app')
    mkdirSync(sdir, { recursive: true })
    mkdirSync(join(tp, 'verifier'), { recursive: true })
    writeFileSync(join(tp, 'verifier', 'reward.txt'), '0')
    writeFileSync(join(tp, 'result.json'), JSON.stringify(result))
    writeFileSync(join(sdir, 's.jsonl'), JSON.stringify({
      message: { content: [{ type: 'tool_result', content: JSON.stringify([{ id: 4242 }]) }] },
    }))
  }
  mk('alpha__aaa', {
    agent_result: { n_output_tokens: 9000 },
    exception_info: { exception_type: 'ApiRateLimitError' },
  })
  mk('beta__bbb', { agent_result: { n_output_tokens: 0 } })

  const { perMemory } = collect(base)
  assert.equal(perMemory.get(4242), undefined, 'unfair trials must contribute nothing')

  // ⛔ AND THE CONVERSE, so this is not just a filter that deletes everything:
  // a timeout IS a capability failure and must still register.
  const base2 = mkdtempSync(join(tmpdir(), 'sma2-'))
  const tp = join(base2, 'jobs-y', 'job1', 'gamma__ccc')
  const sdir = join(tp, 'agent', 'sessions', 'projects', '-app')
  mkdirSync(sdir, { recursive: true })
  mkdirSync(join(tp, 'verifier'), { recursive: true })
  writeFileSync(join(tp, 'verifier', 'reward.txt'), '0')
  writeFileSync(join(tp, 'result.json'), JSON.stringify({
    agent_result: { n_output_tokens: 9000 },
    exception_info: { exception_type: 'AgentTimeoutError' },
  }))
  writeFileSync(join(sdir, 's.jsonl'), JSON.stringify({
    message: { content: [{ type: 'tool_result', content: JSON.stringify([{ id: 4242 }]) }] },
  }))
  const r2 = collect(base2)
  assert.equal(r2.perMemory.get(4242)?.get('gamma')?.failed, 1, 'a timeout must still count')
})
