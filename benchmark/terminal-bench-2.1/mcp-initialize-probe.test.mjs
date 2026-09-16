/**
 * mcp-initialize-probe.mjs must send a REAL MCP `initialize` handshake and
 * retry a connection-level refusal, never a well-formed error.
 *
 * FAILS ON THE PRE-CHANGE TREE: mcp-initialize-probe.mjs did not exist, so
 * every `import` below throws MODULE_NOT_FOUND and every test fails at
 * collection. The capability it adds did not exist either: whatever checked
 * "is the brain listening" before this (a bare TCP probe, or a `tools/list`
 * with no retry) could not tell a listening port with a dead MCP layer behind
 * it from a real handshake, and — the root cause this whole fix targets —
 * nothing retried a transient refusal the way Claude Code itself does not.
 *
 * `retryRecoversATransientRefusal` below is the load-bearing case: a
 * single-attempt version of this probe (delete the retry loop, keep
 * everything else) would fail it specifically, because the fake server does
 * not start listening until after the first two attempts have already been
 * refused. That is the exact shape measured in the 22-trial corpus: the
 * proxy not fully bound yet when the container's first `initialize` lands.
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import test from 'node:test'
import { probeMcpInitialize } from './mcp-initialize-probe.mjs'

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function startServer(port, handler) {
  const srv = http.createServer(handler)
  return new Promise((resolve, reject) => {
    srv.listen(port, '127.0.0.1', () => resolve(srv))
    srv.on('error', reject)
  })
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const REAL_INITIALIZE_RESULT = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: 'terransoul-brain', version: '0.0.0' },
  },
}

test('a real initialize handshake succeeds on the first attempt', async () => {
  const port = await freePort()
  const srv = await startServer(port, async (req, res) => {
    const body = await readBody(req)
    const parsed = JSON.parse(body)
    assert.equal(parsed.method, 'initialize', 'the probe must send the initialize method, not tools/list')
    const payload = Buffer.from(JSON.stringify(REAL_INITIALIZE_RESULT), 'utf8')
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length })
    res.end(payload)
  })
  try {
    const result = await probeMcpInitialize({ port, retries: 3, retryDelayMs: 10 })
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)
    assert.equal(result.protocolVersion, '2024-11-05')
  } finally {
    srv.close()
  }
})

test('retry recovers a transient refusal — THE case this fix exists for', async () => {
  const port = await freePort()
  // Nothing listens on `port` for the first two attempts (a real
  // ConnectionRefused, the exact failure the 22 corrupted trials hit), then a
  // real server starts. A caller that never retries — Claude Code's own
  // behaviour, and the pre-fix "check the port" preflights — would fail this
  // trial permanently; this probe must not.
  let srv
  setTimeout(async () => {
    srv = await startServer(port, async (req, res) => {
      const payload = Buffer.from(JSON.stringify(REAL_INITIALIZE_RESULT), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length })
      res.end(payload)
    })
  }, 350)
  try {
    const result = await probeMcpInitialize({ port, retries: 6, retryDelayMs: 150 })
    assert.equal(result.ok, true, `expected recovery, got error: ${result.error}`)
    assert.ok(result.attempts > 1, `expected more than one attempt, got ${result.attempts}`)
    assert.equal(result.protocolVersion, '2024-11-05')
  } finally {
    if (srv) srv.close()
  }
})

test('a well-formed MCP error is NOT retried — it is an answer, not an absence', async () => {
  const port = await freePort()
  let hits = 0
  const srv = await startServer(port, async (req, res) => {
    hits++
    const payload = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'unsupported protocol version' } }),
      'utf8',
    )
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length })
    res.end(payload)
  })
  try {
    const result = await probeMcpInitialize({ port, retries: 5, retryDelayMs: 10 })
    assert.equal(result.ok, false)
    assert.equal(hits, 1, 'a real MCP error must not be retried')
    assert.match(result.error, /unsupported protocol version/)
  } finally {
    srv.close()
  }
})

test('a malformed response (no result.protocolVersion) fails without retrying', async () => {
  const port = await freePort()
  let hits = 0
  const srv = await startServer(port, async (req, res) => {
    hits++
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), 'utf8')
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length })
    res.end(payload)
  })
  try {
    const result = await probeMcpInitialize({ port, retries: 4, retryDelayMs: 10 })
    assert.equal(result.ok, false)
    assert.equal(hits, 1)
    assert.match(result.error, /protocolVersion/)
  } finally {
    srv.close()
  }
})

test('a permanent refusal exhausts every retry and reports it, not a hang', async () => {
  const port = await freePort() // nothing ever listens here
  const result = await probeMcpInitialize({ port, retries: 3, retryDelayMs: 20 })
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 3)
  assert.match(result.error, /ECONNREFUSED|refused/i)
})
