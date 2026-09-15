// The bench proxy must never hand a benchmark agent a `terransoul-repo` row.
//
// ⛔ WHY THIS FAILS ON THE PRE-CHANGE TREE. The proxy forwarded every row a
// retrieval call returned. The bench store carries 982 rows (of 2525) tagged
// `terransoul-repo`: TerranSoul's OWN development lessons and app settings,
// the tag that exists "so MCP agents can isolate project-coding context from
// generic meta-lessons". They reached benchmark containers and displaced
// on-topic lessons. In the ts0914*/ts0915* sweep 4 of 66 brain_search responses
// carried one (7 of 256 served rows). Pre-change, the proxy case below receives
// all five rows and logs all five as served, and the module the pure cases
// import does not exist. The pure cases import it dynamically so the proxy
// case still RUNS against the old proxy and fails on its own assertion.
//
// THE KEY IS THE EXPLICIT TAG AND NOTHING ELSE. A near-miss tag, and a row
// whose PROSE mentions the tag, are both kept. No words, task names or content
// heuristics decide anything here.
//
// Drives the REAL proxy against a stub upstream: no brain, no network.
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
const MODULE = './withhold-tagged-rows.mjs'
const NL = String.fromCharCode(10)

const ROWS = [
  { id: 1, content: 'a lesson about building the app', tags: 'vite,terransoul-repo', score: 0.9 },
  { id: 2, content: 'a generic technique', tags: 'python,testing', score: 0.8 },
  { id: 3, content: 'a near-miss tag is not the tag', tags: 'terransoul-repository, notes', score: 0.7 },
  { id: 4, content: 'this prose mentions terransoul-repo but the row is not tagged', tags: 'git', score: 0.6 },
  { id: 5, content: 'the tag with spaces around it', tags: 'x , terransoul-repo ', score: 0.5 },
]
const KEPT = [2, 3, 4]
const WITHHELD = [1, 5]

const rpcWith = (text) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })
const idsIn = (rpc) => JSON.parse(rpc.result.content[0].text).map((r) => r.id)

test('rows carrying the terransoul-repo TAG are withheld; a near-miss tag or a prose mention is kept', async () => {
  const { withholdTaggedRows, WITHHELD_TAG } = await import(MODULE)
  assert.equal(WITHHELD_TAG, 'terransoul-repo')
  const out = withholdTaggedRows(JSON.stringify(rpcWith(JSON.stringify(ROWS))))
  assert.deepEqual(out.withheld, WITHHELD)
  assert.deepEqual(idsIn(JSON.parse(out.text)), KEPT)
})

test('an SSE frame is filtered in place, and a response with nothing to withhold is byte-identical', async () => {
  const { withholdTaggedRows } = await import(MODULE)
  const sse = `event: message${NL}data: ${JSON.stringify(rpcWith(JSON.stringify(ROWS)))}${NL}${NL}`
  const out = withholdTaggedRows(sse)
  assert.deepEqual(out.withheld, WITHHELD)
  const lines = out.text.split(NL)
  assert.equal(lines[0], 'event: message', 'the framing around the data line is preserved')
  assert.deepEqual(idsIn(JSON.parse(lines[1].slice('data:'.length))), KEPT)

  // Nothing tagged: the upstream bytes pass through untouched, not re-serialised.
  const clean = JSON.stringify(rpcWith(JSON.stringify([ROWS[1], ROWS[2]])), null, 1)
  const same = withholdTaggedRows(clean)
  assert.equal(same.text, clean)
  assert.deepEqual(same.withheld, [])
  // Not JSON at all: untouched.
  assert.deepEqual(withholdTaggedRows('upstream unreachable'), { text: 'upstream unreachable', withheld: [] })
})

test('a nested pack is pruned too: tagged hits are dropped and a tagged row held in a field is nulled', async () => {
  const { withholdTaggedRows } = await import(MODULE)
  const pack = { hits: ROWS, kg: { center: ROWS[0], neighbors: [] }, fingerprint: 'f' }
  const out = withholdTaggedRows(JSON.stringify(rpcWith(JSON.stringify(pack))))
  const got = JSON.parse(JSON.parse(out.text).result.content[0].text)
  assert.deepEqual(got.hits.map((r) => r.id), KEPT)
  assert.equal(got.kg.center, null)
  assert.deepEqual(out.withheld, [1, 5, 1])
})

function startStub(port) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        // a probe
      }
      const reply = JSON.stringify(rpcWith(JSON.stringify(ROWS)))
      if (parsed?.params?.arguments?.query === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`event: message${NL}data: ${reply}${NL}${NL}`)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(reply)
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

function logRows(logPath, key) {
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  const out = []
  for (const line of text.split(NL)) {
    try {
      const o = JSON.parse(line)
      if (Array.isArray(o?.[key])) out.push(o)
    } catch {
      // not a JSON line
    }
  }
  return out
}

const search = (query) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brain_search', arguments: { query } } })

test('the proxy hands the agent no terransoul-repo row, and logs what it withheld apart from what it served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-withhold-'))
  fs.mkdirSync(path.join(dir, 'tasks', 'zzz-fake-taskname'), { recursive: true })
  const logPath = path.join(dir, 'proxy.jsonl')
  const stub = await startStub(18931)
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TB_PROXY_PORT: '18932',
      TB_PROXY_UPSTREAM_PORT: '18931',
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
    assert.ok(await waitReady(18932), `proxy did not come up: ${out}`)

    const json = await post(18932, search('anything'))
    assert.deepEqual(idsIn(JSON.parse(json)), KEPT, 'a JSON response reaches the agent without the tagged rows')

    const sse = await post(18932, search('sse'))
    const data = sse.split(NL).find((l) => l.startsWith('data:'))
    assert.ok(data, `an SSE response keeps its framing: ${sse}`)
    assert.deepEqual(idsIn(JSON.parse(data.slice('data:'.length))), KEPT, 'so does an SSE response')

    // `served` is what the agent SAW, so outcome credit never lands on a row it
    // was never shown; `withheld` is its own line, keyed apart from every key a
    // witness counts (tool, name, served, authored, read).
    assert.deepEqual(logRows(logPath, 'served').map((r) => r.served), [KEPT, KEPT])
    const withheld = logRows(logPath, 'withheld')
    assert.deepEqual(withheld.map((r) => r.withheld), [WITHHELD, WITHHELD])
    for (const row of withheld) {
      assert.equal(row.withheld_tag, 'terransoul-repo')
      for (const key of ['tool', 'name', 'served', 'authored', 'read']) assert.ok(!(key in row), `withheld line carries ${key}`)
    }
  } finally {
    child.kill('SIGKILL')
    await new Promise((r) => stub.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
