// OUTCOME-VISIBLE-2 — the proxy must record which memories a trial OPENED.
//
// ⛔ WHY THIS FAILS ON THE PRE-CHANGE TREE. The proxy logged `served` (every row
// a `brain_search` put in front of the agent) and `authored` (every row it
// wrote), and nothing in between. There was no way for the credit step to tell
// "the agent glanced past this in a result list" from "the agent opened it and
// read it", so it credited both — the first assertion below finds no `read`
// line at all.
//
// MEASURED 2026-09-12 on memory 26809, a MobileSAM notebook: 19 trials touched
// it, 12 on its own task (3 pass / 9 fail, all of which authored it) and 7 on
// unrelated tasks (caffe-cifar-10 ×2, mteb-retrieve, bn-fit-modify,
// video-processing, winning-avg-corewars, pytorch-model-cli) that merely saw it
// in a search result and all passed. All seven were credited as successes, so
// the ledger read 9/6 and the next agent was told the entry was mostly working.
//
// Drives the REAL proxy against a stub upstream, so it needs no brain and no
// network — and so the assertion is about the file a bench run actually leaves
// behind, not about a function signature.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROXY = path.join(HERE, 'mcp-auth-proxy.mjs')

function startStub(port, reply) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let name = ''
      try {
        name = JSON.parse(body)?.params?.name ?? ''
      } catch {
        // a non-JSON probe is not a tools/call
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: reply(name) }] },
        }),
      )
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

function post(port, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve(text))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function waitReady(port, deadlineMs = 15000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      await post(port, { probe: true })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return false
}

const call = (name, args) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
})

/** Rows of the proxy's JSONL log that carry `key`. */
function rowsWith(logPath, key) {
  const out = []
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (Array.isArray(o?.[key])) out.push(o)
    } catch {
      // mixed stream; only some lines are JSON
    }
  }
  return out
}

test('a brain_get_entry is logged as a READ, distinct from the search that showed it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-read-rows-'))
  fs.mkdirSync(path.join(dir, 'tasks', 'zzz-fake-taskname'), { recursive: true })
  const logPath = path.join(dir, 'proxy.jsonl')
  const stub = await startStub(18901, (name) =>
    name === 'brain_search'
      ? JSON.stringify([{ id: 900 }, { id: 901 }, { id: 902 }])
      : JSON.stringify({ id: 901, content: 'the entry, in full' }),
  )
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TB_PROXY_PORT: '18902',
      TB_PROXY_UPSTREAM_PORT: '18901',
      TB_PROXY_MODE: 'learn',
      TB_TASKS_DIR: path.join(dir, 'tasks'),
      TB_DEFER_WRITES: '0',
      TB_PROXY_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))

  try {
    assert.ok(await waitReady(18902), `proxy did not come up: ${out}`)
    await post(18902, call('brain_search', { query: 'anything' }))
    await post(18902, call('brain_get_entry', { id: 901 }))

    const served = rowsWith(logPath, 'served')
    const read = rowsWith(logPath, 'read')
    assert.deepEqual(
      served.map((r) => r.served),
      [[900, 901, 902]],
      'the search still records everything it showed — this narrows what is CREDITED, not what is observed',
    )
    assert.deepEqual(
      read.map((r) => r.read),
      [[901]],
      'exactly the entry the agent OPENED, and only that one',
    )
    assert.ok(read[0].at, 'a read row must be timestamped, or it cannot be attributed to a trial')

    // ⛔ The parallel-line rule every other id-bearing row in this proxy obeys:
    // run-dg.sh counts calls by grepping `"tool":` and `"name":`, so a new line
    // carrying either key would inflate the "was the brain used?" evidence.
    for (const row of read) {
      assert.ok(!('tool' in row), 'a read row must not be counted as a tool call')
      assert.ok(!('name' in row), 'a read row must not be counted as a brain verdict')
    }
  } finally {
    child.kill('SIGKILL')
    await new Promise((r) => stub.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a REFUSED brain_get_entry is not recorded as a read', async () => {
  // Being denied an entry is not reading it. The recorder runs only on the
  // accepted path, and this pins that: an upstream error must leave no `read`
  // row, or a trial could be credited for a memory the brain never handed over.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-read-refused-'))
  fs.mkdirSync(path.join(dir, 'tasks', 'zzz-fake-taskname'), { recursive: true })
  const logPath = path.join(dir, 'proxy.jsonl')
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'not found: memory id 901' }] },
        }),
      )
    })
  })
  await new Promise((r) => server.listen(18903, '127.0.0.1', r))
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TB_PROXY_PORT: '18904',
      TB_PROXY_UPSTREAM_PORT: '18903',
      TB_PROXY_MODE: 'learn',
      TB_TASKS_DIR: path.join(dir, 'tasks'),
      TB_DEFER_WRITES: '0',
      TB_PROXY_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    assert.ok(await waitReady(18904))
    await post(18904, call('brain_get_entry', { id: 901 }))
    assert.equal(rowsWith(logPath, 'read').length, 0)
  } finally {
    child.kill('SIGKILL')
    await new Promise((r) => server.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── OUTCOME-VISIBLE-6 — a read of a REFUTED entry is EXPOSURE, not use ───────
//
// ⛔ WHY THIS FAILS ON THE PRE-CHANGE TREE. `noteReadMemory` looked only at the
// REQUEST: any accepted `brain_get_entry` produced `{"read":[id]}`, whatever the
// brain handed back. So there was no row shape for "the agent opened this and was
// given the refutation verdict plus a graded index instead of the text", and the
// credit step counted it as use — `rowsWith(log, 'read_refuted')` is empty and the
// id appears under `read`.
//
// MEASURED 2026-09-13: entry 26809 was refuted with 10 consecutive graded failures
// and QUARANTINED (OUTCOME-VISIBLE-5 — no tool call returns the body). Trial
// redo09130830 opened it, got the quarantined view, authored 27007 and passed 9/9.
// `credit-trial-outcome.mjs` logged `reward=1 -> success for 2 used memories:
// 26809, 27007`, so 26809 went to consecutive_failures 0 / last_outcome success
// and the brain served the full body again — released by a reader who had never
// seen it.
test('a read served the REFUTED view is logged as read_refuted, never as a plain read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-read-refuted-'))
  fs.mkdirSync(path.join(dir, 'tasks', 'zzz-fake-taskname'), { recursive: true })
  const logPath = path.join(dir, 'proxy.jsonl')
  // The two lines the serving layer renders above a quarantined entry, spelled as
  // `crates/memory/src/outcome_stamp.rs` emits them (REFUTED_BANNER_PREFIX and
  // QUARANTINE_PREFIX). The body is absent BY CONSTRUCTION on this surface: what
  // follows the two lines is a graded index of the entry's own update blocks.
  const refutedView = [
    '[REFUTED · 10 graded failures since the last graded success on 2026-09-01] What follows' +
      ' has been acted on and graded since it was written, and it lost 10 times running.',
    '[body quarantined (10 consecutive failures) and is served again after the next graded success;' +
      ' read this index as a ledger of what has already been graded, not as a plan]',
    '  2026-09-12 · failure · "Resize the mask to the source raster before scoring"',
  ].join(String.fromCharCode(10))
  const stub = await startStub(18905, (name) =>
    name === 'brain_search'
      ? JSON.stringify([{ id: 26809 }, { id: 700 }])
      : JSON.stringify({ id: 26809, content: refutedView, outcome: { consecutive_failures: 10 } }),
  )
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TB_PROXY_PORT: '18906',
      TB_PROXY_UPSTREAM_PORT: '18905',
      TB_PROXY_MODE: 'learn',
      TB_TASKS_DIR: path.join(dir, 'tasks'),
      TB_DEFER_WRITES: '0',
      TB_PROXY_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))
  try {
    assert.ok(await waitReady(18906), `proxy did not come up: ${out}`)
    await post(18906, call('brain_get_entry', { id: 26809 }))

    const refuted = rowsWith(logPath, 'read_refuted')
    assert.deepEqual(
      refuted.map((r) => r.read_refuted),
      [[26809]],
      'the id the agent opened, on the key the credit step does NOT treat as use',
    )
    assert.equal(refuted[0].refuted_at_read, true)
    assert.ok(refuted[0].at, 'the row must be timestamped, or it cannot be attributed to a trial')
    assert.equal(
      rowsWith(logPath, 'read').length,
      0,
      'a refuted read must not ALSO appear under `read`, or USED_KEYS credits it anyway',
    )
    // The parallel-line rule every id-bearing row in this proxy obeys.
    for (const row of refuted) {
      assert.ok(!('tool' in row), 'a read row must not be counted as a tool call')
      assert.ok(!('name' in row), 'a read row must not be counted as a brain verdict')
    }
  } finally {
    child.kill('SIGKILL')
    await new Promise((r) => stub.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an ORDINARY read carries refuted_at_read:false — the marker that dates the row', async () => {
  // ⛔ WHY THE `false` IS LOAD-BEARING AND NOT NOISE. The credit step's precedence
  // rule is "the proxy key wins; the ledger is consulted only for legacy rows",
  // and without a marker on the negative case a plain `read` row is ambiguous
  // between "this proxy checked and the entry was fine" and "this proxy predates
  // the check". The whole archived corpus is the second kind. FAILS PRE-CHANGE:
  // the field did not exist, so every row read as legacy and every read in every
  // new sweep would take a needless ledger round-trip — or, with the precedence
  // the other way round, a row refuted SINCE the trial ran would retroactively
  // decredit a read the brain had answered in full.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-read-marker-'))
  fs.mkdirSync(path.join(dir, 'tasks', 'zzz-fake-taskname'), { recursive: true })
  const logPath = path.join(dir, 'proxy.jsonl')
  const stub = await startStub(18907, () =>
    JSON.stringify({ id: 901, content: 'the entry, in full, with no banner above it' }),
  )
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TB_PROXY_PORT: '18908',
      TB_PROXY_UPSTREAM_PORT: '18907',
      TB_PROXY_MODE: 'learn',
      TB_TASKS_DIR: path.join(dir, 'tasks'),
      TB_DEFER_WRITES: '0',
      TB_PROXY_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    assert.ok(await waitReady(18908))
    await post(18908, call('brain_get_entry', { id: 901 }))
    const read = rowsWith(logPath, 'read')
    assert.deepEqual(read.map((r) => r.read), [[901]])
    assert.equal(read[0].refuted_at_read, false)
    assert.equal(rowsWith(logPath, 'read_refuted').length, 0)
  } finally {
    child.kill('SIGKILL')
    await new Promise((r) => stub.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
