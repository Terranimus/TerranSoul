// TBENCH-WEB-RESEARCH-1 — `brain_ingest_url` must be callable in learn mode.
//
// WHY THIS EXISTS. The owner decided (2026-09-01) that a Terminal-Bench agent
// may research online and KEEP what it finds: fetch a page, have the brain
// chunk + embed + store it, and retrieve it later. The web -> brain -> retrieve
// half of that already worked end to end (gateway.rs::ingest_url ->
// IngestSink::start_ingest -> commands/ingest.rs::run_ingest_task -> live
// fetch_url -> chunk -> embed -> store_ingest_row with source_url). What did not
// work was REACHABILITY: this proxy's learn-mode allowlist held exactly the four
// brain-write tools, so `brain_ingest_url` was refused as "a write/mutating
// tool" before it ever left the host.
//
// WHY EACH CASE FAILS ON THE PRE-CHANGE TREE
// (rules/tests-must-be-able-to-fail.md):
//   1. `brain_ingest_url is forwarded in learn mode`
//      gate() fell through to the blanket refusal because the name was in
//      neither READ_ONLY_TOOLS, VERIFY_TOOLS nor LEARN_TOOLS, so the call came
//      back as JSON-RPC error -32001 and NOTHING reached the upstream stub.
//      Observed pre-change: {"code":-32001,"message":"bench proxy:
//      'brain_ingest_url' is a write/mutating tool, so it is blocked during a
//      Terminal-Bench run ..."}.
//   2. `a task-naming URL is refused by the EXISTING purity gate (-32002)`
//      Pre-change this returned -32001 (blanket block), not -32002, because the
//      payload was never reached by taskIdentityHits() at all. NO NEW GATE IS
//      ADDED HERE: the owner explicitly accepted the self-seeding risk and asked
//      for no extra restriction, so `brain_ingest_url` simply joins LEARN_TOOLS
//      and inherits the write-purity scan every other learn write already
//      passes through. This case pins that inheritance so a later edit cannot
//      route the tool around it silently.
//   3. `the refused-tool message advertises brain_ingest_url`
//      EXPOSED_BRAIN_TOOLS (the proxy's mirror of tools.rs::EXPOSED_TOOLS) did
//      not list it, so an agent told what it MAY call was never told about the
//      one tool that lets it keep what it read.
//
// Case 4 (`read-only mode still blocks it`) passes both before and after by
// design — it is the guard that this change did not widen the DEFAULT posture,
// and it is called out here rather than claimed as fail-first evidence.
//
// Uses a stub upstream, so it needs no brain and no network.
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

/** Task names that appear NOWHERE in any proxy source, same trick as write-purity.test.sh. */
function makeTasksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ingest-url-'))
  fs.mkdirSync(path.join(dir, 'tasks', 'zzz-fake-taskname'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tasks', 'another-fake-task'), { recursive: true })
  return dir
}

function startStub(port, seen) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        if (parsed.method === 'tools/call') {
          seen.push({ tool: parsed.params?.name, args: parsed.params?.arguments })
        }
      } catch {
        // a non-JSON probe is not a tools/call; ignore
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '{"task_id":"stub"}' }] },
        }),
      )
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

function startProxy(env) {
  const child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))
  return { child, log: () => out }
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

const ingestCall = (url) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'brain_ingest_url', arguments: { url, tags: 'research' } },
})

/**
 * Bring up stub + proxy, run `body(ctx)`, tear everything down.
 * `mode` is the TB_PROXY_MODE value under test.
 */
async function withProxy(mode, basePort, body) {
  const dir = makeTasksDir()
  const seen = []
  const stub = await startStub(basePort, seen)
  const { child, log } = startProxy({
    TERRANSOUL_MCP_TOKEN: 'stub-token',
    TB_PROXY_PORT: String(basePort + 1),
    TB_PROXY_UPSTREAM_PORT: String(basePort),
    TB_PROXY_MODE: mode,
    TB_TASKS_DIR: path.join(dir, 'tasks'),
    TB_DEFER_WRITES: '0',
    TB_PROXY_LOG: path.join(dir, 'proxy.jsonl'),
  })
  try {
    const ready = await waitReady(basePort + 1)
    assert.ok(ready, `proxy did not come up: ${log()}`)
    await body({ port: basePort + 1, seen, dir, log })
  } finally {
    child.kill('SIGKILL')
    await new Promise((r) => stub.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('brain_ingest_url is forwarded to the brain in learn mode', async () => {
  await withProxy('learn', 18861, async ({ port, seen }) => {
    const res = await post(port, ingestCall('https://docs.example.org/library/reference.html'))
    assert.ok(
      !res.includes('-32001'),
      `brain_ingest_url must not be blocked as a write tool in learn mode; got ${res}`,
    )
    assert.ok(
      !res.includes('-32002'),
      `a URL naming no benchmark task must not trip the purity gate; got ${res}`,
    )
    const forwarded = seen.filter((c) => c.tool === 'brain_ingest_url')
    assert.equal(forwarded.length, 1, `expected exactly one forwarded ingest, got ${JSON.stringify(seen)}`)
    assert.equal(forwarded[0].args.url, 'https://docs.example.org/library/reference.html')
  })
})

test('a task-naming URL is refused by the EXISTING write-purity gate', async () => {
  await withProxy('learn', 18863, async ({ port, seen }) => {
    const res = await post(port, ingestCall('https://example.org/zzz-fake-taskname/solution.html'))
    assert.ok(res.includes('-32002'), `expected the task-identity refusal, got ${res}`)
    assert.equal(
      seen.filter((c) => c.tool === 'brain_ingest_url').length,
      0,
      'a refused ingest must never reach the brain',
    )
  })
})

test('the blocked-tool message tells the agent brain_ingest_url is available', async () => {
  await withProxy('learn', 18865, async ({ port }) => {
    // brain_clear_memory is refused in every mode, and its refusal text lists
    // what the agent CAN call. That list is the proxy's mirror of the server's
    // exposed surface, so it has to name the new tool too.
    const res = await post(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'brain_clear_memory', arguments: { confirm: 'no' } },
    })
    assert.ok(res.includes('-32001'), `brain_clear_memory must stay blocked; got ${res}`)
    assert.ok(
      res.includes('brain_ingest_url'),
      `the "tools available to you" list must name brain_ingest_url; got ${res}`,
    )
  })
})

test('read-only mode (no TB_PROXY_MODE=learn) still blocks brain_ingest_url', async () => {
  // Passes before AND after — the point is that this change did not widen the
  // default posture, only the learn-mode one.
  await withProxy('', 18867, async ({ port, seen }) => {
    const res = await post(port, ingestCall('https://docs.example.org/library/reference.html'))
    assert.ok(res.includes('-32001'), `read-only mode must still block the write; got ${res}`)
    assert.equal(seen.filter((c) => c.tool === 'brain_ingest_url').length, 0)
  })
})
