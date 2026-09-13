#!/usr/bin/env node
// TBENCH-TRAY-OPS-1 (corrected 2026-08-17): the isolated bench brain used by
// this campaign (mcp-data-tbench-clean/, :7424) had NO committed launcher --
// every restart reconstructed the invocation from memory. CAMPAIGN-RECORD.md
// names the resulting risk in its own words: "the misconfiguration risk that
// comes with it." This script is that committed launcher.
//
// It does NOT build target-mcp -- that stays scripts/copilot-start-mcp.mjs's
// job for the SAME binary (single source of truth for the build/freshness
// dance; duplicating it here would drift, the exact class of bug
// rules/mcp-single-source-of-truth.md exists to prevent). Run
// `node scripts/copilot-start-mcp.mjs` (or `npm run mcp`) at least once first
// so target-mcp/release/terransoul.exe exists; this script only launches a
// SECOND, isolated instance of that already-built binary via --headless
// against its own port and data directory.
//
// --headless mode (src-tauri/src/lib.rs::run_headless_host) hardcodes idle
// timeout to 0 and never reads TERRANSOUL_MCP_IDLE_TIMEOUT -- unlike
// --mcp-tray, it cannot self-shut-down on idle, so there is no idle-timeout
// footgun to script around here (see the milestone entry's own correction
// history before assuming otherwise).
//
// ── PORT IDENTITY IS A HARD GATE (TBENCH-STACK-1, measured 2026-08-19) ──────
// MEASURED THAT DAY: a first, foreground launch of this script did not die
// when it was expected to; a second launch was then issued for the same
// --port 7424, and the binary -- finding 7424 taken -- BOUND 7425 INSTEAD and
// this script reported success. 7425 is the auth proxy's own listen port, so
// the "brain" was now answering where the proxy was supposed to, and
// run-terransoul-verifyhook.sh's contamination guard reported the surreal
// "the proxy on ... is serving a brain that reports port 7425". Two brains
// were running and neither was where anything expected it.
//
// Three consequences are baked into the code below and must stay:
//   1. The requested port is probed for occupancy BEFORE anything is spawned.
//      An occupied port is a REFUSAL naming the holder, never a fallback.
//   2. Reuse of an already-running instance is EXPLICIT (--reuse) and is only
//      granted to an instance this script itself started, on this exact port,
//      against this exact --data-dir (recorded in .stack/brain-<port>.json).
//      A healthy stranger on the port -- including this same binary serving a
//      DIFFERENT data dir -- is refused, because "healthy" says nothing about
//      WHICH STORE answers.
//   3. After spawning, the child must be serving the REQUESTED port (checked
//      against /health's own `port` field, router.rs::handle_health emits
//      `state.port`). If it is not, or it never became healthy, the child is
//      KILLED rather than left running -- the pre-change script exited 1 and
//      left the stray process alive, which is how two brains came to exist.
//
// Usage:
//   node benchmark/terminal-bench-3.0/start-bench-brain.mjs [--port 7424] [--data-dir mcp-data-tbench-clean]
//   node benchmark/terminal-bench-3.0/start-bench-brain.mjs --reuse   # accept an instance this script already started there
//   node benchmark/terminal-bench-3.0/start-bench-brain.mjs --stop [--port 7424]
//
// PREFER THE STACK LAUNCHER. `start-bench-stack.mjs` brings up this brain AND
// its auth proxy together, with the proxy's upstream/token derived from this
// brain rather than typed by hand:
//   node benchmark/terminal-bench-3.0/start-bench-stack.mjs
// Starting the two by hand still works, and the proxy no longer defaults to
// the production brain, but the stack launcher is the one command that is
// verified end to end.

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function flag(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx < 0) return fallback
  const value = process.argv[idx + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const port = Number(flag('--port', 7424))
const dataDirArg = flag('--data-dir', 'mcp-data-tbench-clean')
const dataDir = path.isAbsolute(dataDirArg) ? dataDirArg : path.join(repoRoot, dataDirArg)
const stopRequested = process.argv.includes('--stop')
const reuseRequested = process.argv.includes('--reuse')
// 180s default, not 60s: LIVE-MEASURED against the real mcp-data-tbench-clean/
// dir (2026-08-18) -- a data dir reused across many campaign phases can carry
// a large memory.db (measured 310MB here) whose vector index needs a full
// rebuild on the FIRST boot after an embedder/dimension change ("[ann] index
// holds 0 vector(s) but N row(s) carry a ...-d embedding - rebuilding"),
// which alone took over a minute on top of normal subsystem startup. A short
// wait would report a false timeout on an instance that was actually fine.
const waitSeconds = Number(flag('--wait', 180))

const mcpBinary = path.join(
  repoRoot,
  'target-mcp',
  'release',
  process.platform === 'win32' ? 'terransoul.exe' : 'terransoul',
)
const logDir = path.join(dataDir, 'logs')
const logPath = path.join(dataDir, 'logs', 'bench-brain.log')
const pidPath = path.join(dataDir, 'bench-brain.pid')
const tokenPath = path.join(dataDir, 'mcp-token.txt')

// THE REGISTRY IS PORT-KEYED, NOT DATA-DIR-KEYED, on purpose. The pid file
// above lives inside the data dir, so it can only ever answer "is MY store
// running?" -- it cannot see an instance of the same binary serving a
// DIFFERENT store on the port we want. The 2026-08-19 incident was exactly
// that shape (two instances, different intent, one port), so the identity
// record has to be keyed by the contended resource: the port.
const stackDir = path.join(here, '.stack')
const registryPath = path.join(stackDir, `brain-${port}.json`)

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  } catch {
    return null
  }
}

function writeRegistry(entry) {
  fs.mkdirSync(stackDir, { recursive: true })
  fs.writeFileSync(registryPath, `${JSON.stringify(entry, null, 2)}\n`)
}

async function fetchHealth(targetPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}/health`)
    if (!response.ok) return null
    const body = JSON.parse(await response.text())
    if (body.status && body.status !== 'ok') return null
    return body
  } catch {
    return null
  }
}

async function isHealthy(targetPort) {
  return (await fetchHealth(targetPort)) !== null
}

/** Bind-probe: locale-independent, unlike parsing netstat's LISTENING word. */
function portIsOccupied(targetPort) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'))
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen(targetPort, '127.0.0.1')
  })
}

/** Best effort: who holds the port. Never throws; null means "could not tell". */
function portHolder(targetPort) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/)
        // proto local foreign state pid. The STATE WORD IS LOCALISED on a
        // non-English Windows, so a listener is identified by its foreign
        // address (0.0.0.0:0 / [::]:0 / *:*) rather than by the word
        // "LISTENING" -- a locale-dependent guard is a guard that silently
        // stops guarding on someone else's machine.
        if (parts.length < 5 || !/^TCP$/i.test(parts[0])) continue
        const local = parts[1]
        const foreign = parts[2]
        const pid = Number(parts[parts.length - 1])
        if (!Number.isInteger(pid) || pid <= 0) continue
        const colon = local.lastIndexOf(':')
        if (colon < 0 || Number(local.slice(colon + 1)) !== targetPort) continue
        if (!/^(0\.0\.0\.0:0|\[::\]:0|\*:\*)$/.test(foreign)) continue
        return { pid, image: imageForPid(pid) }
      }
      return null
    }
    const out = execFileSync(
      'sh',
      ['-c', `lsof -nP -iTCP:${targetPort} -sTCP:LISTEN -t 2>/dev/null | head -1`],
      { encoding: 'utf8' },
    ).trim()
    const pid = Number(out.split('\n')[0])
    return Number.isInteger(pid) && pid > 0 ? { pid, image: null } : null
  } catch {
    return null
  }
}

function imageForPid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
    })
    const m = out.match(/^"([^"]+)"/m)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function waitForHealth(targetPort, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const health = await fetchHealth(targetPort)
    if (health) return health
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

function readPid() {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function printProxyHint() {
  console.log(
    `[bench-brain] point the proxy at this instance with: TB_PROXY_UPSTREAM_PORT=${port} TERRANSOUL_MCP_TOKEN_FILE=${tokenPath} node benchmark/terminal-bench-3.0/mcp-auth-proxy.mjs`,
  )
  console.log(
    '[bench-brain] or bring the whole stack up in one verified command: node benchmark/terminal-bench-3.0/start-bench-stack.mjs',
  )
}

// ── WHY THE BODY IS A FUNCTION AND NOTHING CALLS process.exit() ─────────────
// MEASURED on this machine (node v24.3.0, Windows, 2026-08-19), reduced to a
// two-line repro:
//   node -e 'for (const p of [P,P]) { const r = await fetch(url); await r.text() }
//            process.exit(1)'
//   -> Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\winsync.c
//   -> the process ABORTS with exit code 127 instead of 1.
// Two successful fetches followed by process.exit() abort the process, so a
// launcher that probes /health twice and then exits with a status hands the
// operator (and every `&&` chain and CI gate keyed off it) a meaningless 127.
// `process.exitCode` + letting the loop drain exits immediately (0.12 s
// measured) with the intended code, so every exit point below RETURNS a code.
async function main() {
  if (stopRequested) {
    const reg = readRegistry()
    const pid = readPid() ?? (reg && reg.pid) ?? null
    if (!pid) {
      console.log(`[bench-brain] no pid file at ${pidPath}; nothing to stop.`)
      fs.rmSync(registryPath, { force: true })
      return 0
    }
    try {
      process.kill(pid)
      console.log(`[bench-brain] sent stop signal to pid ${pid} (port ${port}, data-dir ${dataDir}).`)
    } catch (err) {
      console.log(`[bench-brain] pid ${pid} was not running (${err.code ?? err.message}); nothing to stop.`)
    }
    fs.rmSync(pidPath, { force: true })
    fs.rmSync(registryPath, { force: true })
    return 0
  }

  // ── GATE 1: the requested port must be OURS or FREE ─────────────────────────
  // Never a fallback, never a silent reuse of a stranger. See the incident note
  // at the top of this file: the pre-change code reached this point, saw
  // "healthy", and exited 0 for whatever happened to answer -- which on
  // 2026-08-19 was a second brain that had bound the PROXY's port.
  if (await portIsOccupied(port)) {
    const health = await fetchHealth(port)
    const holder = portHolder(port)
    const reg = readRegistry()
    const reportedPort = health ? Number(health.port) : null
    const sameInstance =
      !!health &&
      !!reg &&
      Number(reg.port) === port &&
      reportedPort === port &&
      path.resolve(reg.dataDir) === path.resolve(dataDir) &&
      (!holder || !reg.pid || holder.pid === reg.pid || pidAlive(reg.pid))

    if (sameInstance && reuseRequested) {
      console.log(
        `[bench-brain] reusing the instance this launcher started on ${port} (pid ${reg.pid}, data-dir ${dataDir}), by --reuse.`,
      )
      if (fs.existsSync(tokenPath)) console.log(`[bench-brain] token available at ${tokenPath}`)
      printProxyHint()
      return 0
    }

    const who = holder
      ? `pid ${holder.pid}${holder.image ? ` (${holder.image})` : ''}`
      : 'an unidentified process (netstat/lsof could not name it)'
    console.error(`[bench-brain] REFUSING: port ${port} is already held by ${who}.`)
    if (health) {
      console.error(
        `[bench-brain]   it answers /health and reports it is serving port ${reportedPort}` +
          `${reportedPort !== port ? ' — that is NOT the port requested here' : ''}` +
          `${health.memory_total !== undefined ? `, memory_total=${health.memory_total}` : ''}.`,
      )
    } else {
      console.error('[bench-brain]   it does not answer /health, so it is not a TerranSoul brain at all.')
    }
    if (reg) {
      console.error(
        `[bench-brain]   ${registryPath} records pid ${reg.pid} with data-dir ${reg.dataDir}` +
          `${path.resolve(reg.dataDir) === path.resolve(dataDir) ? '' : ' — a DIFFERENT store than the one requested here'}.`,
      )
    } else {
      console.error('[bench-brain]   this launcher has no record of starting anything on that port.')
    }
    console.error(
      '[bench-brain] NOT falling back to another port: on 2026-08-19 that behaviour put a brain on 7425,',
    )
    console.error('[bench-brain] the auth proxy\'s own port, and the run measured two brains and no proxy.')
    console.error(`[bench-brain] Stop it first:  node ${path.relative(repoRoot, fileURLToPath(import.meta.url)).replace(/\\/g, '/')} --stop --port ${port}`)
    if (holder) {
      console.error(
        `[bench-brain] or kill the holder: ${process.platform === 'win32' ? `taskkill /PID ${holder.pid} /F` : `kill ${holder.pid}`}`,
      )
    }
    console.error(`[bench-brain] To accept an instance THIS launcher started there, pass --reuse.`)
    return 3
  }

  if (reuseRequested) {
    console.log(`[bench-brain] --reuse given but nothing holds ${port}; starting a fresh instance.`)
  }

  if (!fs.existsSync(mcpBinary)) {
    console.error(`[bench-brain] ${mcpBinary} does not exist yet.`)
    console.error('[bench-brain] this script only LAUNCHES the already-built binary; build it first with:')
    console.error('[bench-brain]   node scripts/copilot-start-mcp.mjs   (or: npm run mcp)')
    return 1
  }

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })
  const log = fs.openSync(logPath, 'a')

  const child = spawn(mcpBinary, ['--headless'], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      TERRANSOUL_HEADLESS_PORT: String(port),
      TERRANSOUL_HEADLESS_DATA_DIR: dataDir,
    },
    stdio: ['ignore', log, log],
  })
  child.unref()
  fs.writeFileSync(pidPath, `${child.pid}\n`)
  writeRegistry({
    pid: child.pid,
    port,
    dataDir,
    startedAt: new Date().toISOString(),
    logPath,
    tokenPath,
  })
  console.log(`[bench-brain] started --headless instance as pid ${child.pid}; port=${port} data-dir=${dataDir} log=${logPath}`)

  // ── GATE 2: it must be serving the port we ASKED for ────────────────────────
  function abandon(reason) {
    console.error(`[bench-brain] ${reason}`)
    try {
      process.kill(child.pid)
      console.error(`[bench-brain] killed pid ${child.pid} rather than leave a stray brain running.`)
    } catch (err) {
      console.error(`[bench-brain] could not kill pid ${child.pid}: ${err.code ?? err.message}`)
    }
    fs.rmSync(pidPath, { force: true })
    fs.rmSync(registryPath, { force: true })
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').slice(-80).join('\n') : ''
    if (tail.trim()) console.error(`[bench-brain] log tail:\n${tail}`)
    return 1
  }

  const health = await waitForHealth(port, waitSeconds)
  if (!health) {
    return abandon(`timed out waiting for http://127.0.0.1:${port}/health`)
  }
  if (Number(health.port) !== port) {
    // The 2026-08-19 shape, caught at the source instead of three layers later.
    return abandon(
      `the instance came up but reports it is serving port ${health.port}, not the requested ${port}.`,
    )
  }

  console.log(`[bench-brain] healthy on ${port} (self-reported port ${health.port}, memory_total=${health.memory_total ?? '?'})`)
  if (fs.existsSync(tokenPath)) {
    console.log(`[bench-brain] token available at ${tokenPath}`)
  }
  printProxyHint()
  console.log(`[bench-brain] stop it later with: node benchmark/terminal-bench-3.0/start-bench-brain.mjs --stop --port ${port}`)
  return 0
}

process.exitCode = await main()
