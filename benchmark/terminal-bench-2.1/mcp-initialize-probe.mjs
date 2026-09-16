#!/usr/bin/env node
// mcp-initialize-probe.mjs — send a REAL MCP `initialize` handshake and
// confirm a real response, with retries.
//
// ⛔ WHY THIS EXISTS (TBENCH-BRAIN-CONNECT-1 / fix F1). Forensics over the
// 2026-09 corpus found 22 trials corpus-wide that started with the
// in-container MCP connection NEVER established: the container's Claude Code
// process got ConnectionRefused talking to the host proxy at its very first
// `initialize` call and — this is the load-bearing fact — Claude Code never
// retries that failure. Whatever checked "is the brain listening" before
// those trials only ever checked the PORT or the PROCESS (a `tools/list` or a
// bare TCP probe), which a listening socket with a dead or misconfigured MCP
// layer behind it, or a proxy that is up but not YET able to complete a real
// handshake, still passes.
//
// This module is the fix for that gap: it sends the actual JSON-RPC 2.0
// `initialize` method (the one Claude Code itself sends first, and the one
// the router validates a full response for — see
// src-tauri/src/ai_integrations/mcp/router.rs, which answers with
// `protocolVersion` + `serverInfo`) and RETRIES with backoff before giving
// up. The retry is deliberate: it moves the resilience Claude Code lacks into
// the harness that starts it, so a momentary refusal (the proxy's listener
// not fully up yet, a Docker NAT path still settling) is absorbed here
// instead of silently failing the whole trial.
//
// Used two ways by run-dg.sh: (1) a host-side check against 127.0.0.1, and
// (2) — the part that was actually missing — a check run FROM INSIDE A
// CONTAINER against host.docker.internal, the exact network path Claude Code
// itself uses (see container-mcp-probe.sh). A host-only check proves nothing
// about that second path: Docker Desktop's host.docker.internal is not the
// loopback interface, and a proxy reachable from the host can still be
// unreachable, or reachable only after a delay, from inside a container.
import http from 'node:http'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 500

/** Retryable connection-level failures — never a well-formed refusal FROM the
 *  MCP layer, always a failure to even reach it. */
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])

function initializeRequestBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tb-mcp-initialize-probe', version: '1.0' },
    },
  })
}

/** One HTTP attempt. Resolves with `{ok, protocolVersion}` on a well-formed
 *  MCP `initialize` response (a `result` with a string `protocolVersion`,
 *  matching what router.rs actually returns), rejects with the raw error
 *  otherwise so the caller can decide whether it is retryable. */
function attemptOnce({ host, port, path, token, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(initializeRequestBody(), 'utf8')
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(body.length),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const req = http.request(
      { host, port, path, method: 'POST', headers, timeout: timeoutMs },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch (e) {
            reject(new Error(`non-JSON response (status ${res.statusCode}): ${text.slice(0, 200)}`))
            return
          }
          if (parsed && parsed.error) {
            reject(new Error(`MCP error ${parsed.error.code ?? ''}: ${parsed.error.message ?? 'unknown'}`))
            return
          }
          const protocolVersion = parsed?.result?.protocolVersion
          if (typeof protocolVersion !== 'string' || !protocolVersion) {
            reject(new Error(`initialize response has no result.protocolVersion: ${text.slice(0, 200)}`))
            return
          }
          resolve({ ok: true, protocolVersion, statusCode: res.statusCode })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Send a real MCP `initialize` request, retrying on connection-level
 * failures. Never retries a well-formed MCP error response or a malformed
 * body — those are answers, not absences, and retrying them would hide a
 * real misconfiguration behind a false "eventually worked".
 *
 * @returns {Promise<{ok: boolean, attempts: number, protocolVersion: string|null, error: string|null}>}
 */
export async function probeMcpInitialize(opts = {}) {
  const {
    host = '127.0.0.1',
    port,
    path = '/mcp',
    token = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = opts
  if (!port) throw new Error('probeMcpInitialize requires a port')

  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await attemptOnce({ host, port, path, token, timeoutMs })
      return { ok: true, attempts: attempt, protocolVersion: result.protocolVersion, error: null }
    } catch (err) {
      lastError = err
      const code = err?.code || (RETRYABLE_CODES.has(String(err?.message).split(':')[0]) ? err.message : null)
      const retryable = RETRYABLE_CODES.has(err?.code) || /timed out/i.test(String(err?.message))
      if (!retryable || attempt === retries) break
      await sleep(retryDelayMs * attempt)
    }
  }
  return {
    ok: false,
    attempts: Math.min(retries, lastError ? retries : 0) || retries,
    protocolVersion: null,
    error: String(lastError?.message ?? lastError ?? 'unknown error'),
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
// usage: node mcp-initialize-probe.mjs --port N [--host H] [--path P]
//                                       [--token T] [--retries N] [--timeout-ms N]
// Prints one JSON line to stdout and exits 0 on success, 2 on failure — the
// shape run-dg.sh and container-mcp-probe.sh both read.
async function main() {
  const args = process.argv.slice(2)
  const get = (flag, def = undefined) => {
    const i = args.indexOf(flag)
    return i === -1 ? def : args[i + 1]
  }
  const port = Number(get('--port', process.env.TB_MCP_PROBE_PORT))
  if (!port) {
    console.error('usage: node mcp-initialize-probe.mjs --port N [--host H] [--path P] [--token T] [--retries N]')
    process.exit(2)
  }
  const result = await probeMcpInitialize({
    host: get('--host', '127.0.0.1'),
    port,
    path: get('--path', '/mcp'),
    token: get('--token', process.env.TERRANSOUL_MCP_TOKEN || null),
    retries: Number(get('--retries', DEFAULT_RETRIES)),
    retryDelayMs: Number(get('--retry-delay-ms', DEFAULT_RETRY_DELAY_MS)),
    timeoutMs: Number(get('--timeout-ms', DEFAULT_TIMEOUT_MS)),
  })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 2)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (isMain || (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/mcp-initialize-probe.mjs'))) {
  main()
}
