#!/usr/bin/env node
// TBENCH-STACK-1 — THE ONE COMMAND THAT BRINGS THE BENCH MCP STACK UP.
//
// WHY THIS EXISTS. Until 2026-08-19 the stack was two hand-typed commands in
// a fixed order with three environment variables that had to be right, and
// EVERY way of getting it wrong failed silently — toward production, or
// toward a dead run. All four of these were hit for real that day:
//
//   1. `start-bench-brain.mjs --port 7424` reported success while the binary
//      had actually bound 7425 (the PROXY's port) because 7424 was still
//      held by a launch that had not died. Two brains, neither where anything
//      expected. Fixed at the source in start-bench-brain.mjs; this launcher
//      inherits that refusal.
//   2. The proxy's token variable was misspelt (`TB_PROXY_TOKEN_FILE`, which
//      nothing reads), so it fell through to the PRODUCTION store's token
//      while fronting the bench brain. It failed safe only by luck — a 401.
//   3. The proxy's own TB_PROXY_UPSTREAM_PORT defaulted to 7423, PRODUCTION,
//      which holds task-specific TerminalBench lessons from earlier
//      campaigns. A proxy started without that variable served them to the
//      agent; only run-terransoul-verifyhook.sh's separate guard caught it.
//   4. The stack had no owned lifecycle. The proxy was started as a
//      harness-tracked background task and was KILLED MID-SWEEP, leaving
//      trials running with no MCP for roughly 12 minutes. The Stop hook fails
//      open, so every stop in that window passed unverified. Harbor itself
//      survived only because it detaches.
//
// So: one command, detached (it outlives this shell), health-checked, and
// verified END TO END — the proxy is not declared up until an authenticated
// tools/list has come back THROUGH it, which is the only check that can catch
// (2) at all.
//
//   node benchmark/terminal-bench-3.0/start-bench-stack.mjs
//   node benchmark/terminal-bench-3.0/start-bench-stack.mjs --status
//   node benchmark/terminal-bench-3.0/start-bench-stack.mjs --stop
//
// Flags: --brain-port 7424  --proxy-port 7425  --data-dir mcp-data-tbench-clean
//        --wait 180 (brain health timeout)  --proxy-wait 30
//        --seed <file> (default generic-technique-seed.json)  --tasks <roster dir>
//
// TWO PREP STEPS WERE ADDED 2026-08-19 BECAUSE BOTH WERE MANUAL AND BOTH FAIL
// SILENTLY WHEN FORGOTTEN — the same shape as incidents (1)-(4) above:
//
//   5. THE SEED IS APPLIED HERE, NOT BY HAND. `extra-instruction-harness.md`
//      was shrunk 72% on the argument that its deleted "How to work" guidance
//      lives in `generic-technique-seed.json` inside the store. Nothing
//      applied that seed: `clean-bench-brain.mjs --seed --apply` was a step in
//      someone's notes. A launch that skipped it produced a run with the
//      guidance in NEITHER the prompt NOR the store — strictly worse than
//      before the shrink, and indistinguishable from a good run afterwards.
//      Idempotent (the gateway's exact-content dedup answers `deduplicated`),
//      and a missing seed file REFUSES rather than no-ops. See
//      seed-bench-brain.mjs.
//   6. THE SERVED INSTRUCTIONS ARE READ BACK FROM THE RUNNING BINARY. A source
//      change is not a deployed change: measured, the deployed .exe still
//      served the suppression text the source had already deleted, with every
//      cargo test green. See check-served-instructions.mjs.
//
// It does NOT build the binary (scripts/copilot-start-mcp.mjs owns that, per
// rules/mcp-single-source-of-truth.md) and it does NOT re-implement the
// brain's own launch/identity logic — it SHELLS OUT to start-bench-brain.mjs,
// so there is exactly one place that knows how to start a bench brain.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkServedInstructions, reportFailure } from './check-served-instructions.mjs'
import { DEFAULT_SEED_FILE, SeedError, applySeed, seedBrain } from './seed-bench-brain.mjs'

function flag(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx < 0) return fallback
  const value = process.argv[idx + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const brainPort = Number(flag('--brain-port', 7424))
const proxyPort = Number(flag('--proxy-port', 7425))
const dataDirArg = flag('--data-dir', 'mcp-data-tbench-clean')
const dataDir = path.isAbsolute(dataDirArg) ? dataDirArg : path.join(repoRoot, dataDirArg)
// The proxy's write mode, set EXPLICITLY rather than inherited from the
// operator's shell — see the long note at the proxy spawn below. '' means the
// proxy's own read-only default. Only TB_STACK_PROXY_MODE (this launcher's own
// variable, not the proxy's TB_PROXY_MODE) can opt into the research arm, so a
// stale `export TB_PROXY_MODE=learn` cannot reach a submission run by accident.
const proxyMode = process.env.TB_STACK_PROXY_MODE || ''
const brainWait = Number(flag('--wait', 180))
const proxyWait = Number(flag('--proxy-wait', 30))
const stopRequested = process.argv.includes('--stop')
const statusRequested = process.argv.includes('--status')
// The disclosed generic prior. Applied on every launch, refused if absent.
// TB_STACK_NO_SEED is the ONLY way past it, it has to be set deliberately, and
// it is printed on the READY receipt and written into the proxy registry — the
// same discipline TB_STACK_PROXY_MODE gets, and for the same reason: a run that
// differs from the documented one must never be indistinguishable afterwards.
const seedPath = flag('--seed', DEFAULT_SEED_FILE)
const tasksDir = flag(
  '--tasks',
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache/harbor/tasks/packages/terminal-bench'),
)
const seedDisabled = Boolean(process.env.TB_STACK_NO_SEED)

const brainLauncher = path.join(here, 'start-bench-brain.mjs')
const proxyScript = path.join(here, 'mcp-auth-proxy.mjs')
const tokenPath = path.join(dataDir, 'mcp-token.txt')
const stackDir = path.join(here, '.stack')
const proxyRegistryPath = path.join(stackDir, `proxy-${proxyPort}.json`)
const proxyLogDir = path.join(here, 'proxy-logs')
const mcpUrl = `http://host.docker.internal:${proxyPort}/mcp`

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
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

// ── A BIND PROBE IS NOT AN OCCUPANCY DETECTOR (TBENCH-STACK-2, 2026-08-20) ──
//
// WHAT THIS FUNCTION USED TO BE, and what it cost. It was a single
// `net.createServer().listen(port, '127.0.0.1')`: bind succeeds -> "free".
// mcp-auth-proxy.mjs listens on 0.0.0.0 ON PURPOSE (the container reaches it
// through host.docker.internal), and on Windows those two addresses do not
// collide. MEASURED on this machine (Windows 11, node v24.3.0), one holder
// process per row, probing every address in turn:
//
//     holder      probe 127.0.0.1   probe 0.0.0.0   probe ::   probe (default)
//     127.0.0.1   EADDRINUSE        FREE            FREE       FREE
//     0.0.0.0     FREE              EADDRINUSE      FREE       FREE
//     ::          FREE              FREE            EADDRINUSE EADDRINUSE
//
// A Windows bind probe sees a holder ONLY at the exact same address. There is
// no single address that detects all three, so no bind probe can answer this
// question at all — which is why the OS's own listener table is now the
// detector and the probes are a fallback for when it cannot be read.
//
// THE INCIDENT THIS COMES FROM, measured 2026-08-20. A proxy from that morning
// (pid 32940, started 09:52) still held 0.0.0.0:7425. This launcher probed
// 127.0.0.1, was told "free", spawned a child, and printed
//   [stack] proxy: started as pid 137464 on 7425 -> 7424
// The child never listened: proxy-logs/stack-proxy-*.log for that very pid ends
//   Error: listen EADDRINUSE: address already in use 0.0.0.0:7425
//   Node.js v24.3.0
// i.e. a bare Node crash tail. Verification then probed THE PORT, the eleven-
// hour-old process answered, and the launcher printed
//   [stack] verified: authenticated tools/list through the proxy served 49 tool(s)
// Both lines were false. An entire graded run shipped with none of the
// proxy-side observability that had been built that evening (the serving binary
// predated mcp-auth-proxy.mjs's 20:38 mtime by eleven hours): no caller
// attribution, no query logging, no payload sizes. The scores were fine; the
// instrumentation silently was not, and nothing anywhere said so.
function imageForPid(pid) {
  try {
    if (process.platform !== 'win32') return null
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
    })
    const m = out.match(/^"([^"]+)"/m)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Who is LISTENING on this port, per the OS. Mirrors start-bench-brain.mjs's
 * `portHolder` deliberately — same question, same answer, and a reader who has
 * seen one recognises the other. Never throws; null means "could not tell",
 * which is NOT the same as "nobody" and is treated differently below.
 */
function portHolder(targetPort) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/)
        // proto local foreign state pid. The STATE WORD IS LOCALISED on a
        // non-English Windows, so a listener is identified by its foreign
        // address (0.0.0.0:0 / [::]:0 / *:*) rather than by the word
        // "LISTENING" — a locale-dependent guard silently stops guarding on
        // someone else's machine.
        if (parts.length < 5 || !/^TCP$/i.test(parts[0])) continue
        const local = parts[1]
        const foreign = parts[2]
        const pid = Number(parts[parts.length - 1])
        if (!Number.isInteger(pid) || pid <= 0) continue
        const colon = local.lastIndexOf(':')
        if (colon < 0 || Number(local.slice(colon + 1)) !== targetPort) continue
        if (!/^(0\.0\.0\.0:0|\[::\]:0|\*:\*)$/.test(foreign)) continue
        // The local address is reported so a refusal can say WHICH address the
        // holder took — the whole point of the table above.
        return { pid, image: imageForPid(pid), address: local.slice(0, colon) }
      }
      return null
    }
    const out = execFileSync(
      'sh',
      ['-c', `lsof -nP -iTCP:${targetPort} -sTCP:LISTEN -t 2>/dev/null | head -1`],
      { encoding: 'utf8' },
    ).trim()
    const pid = Number(out.split('\n')[0])
    return Number.isInteger(pid) && pid > 0 ? { pid, image: null, address: null } : null
  } catch {
    return null
  }
}

function bindProbe(targetPort, address) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'))
    server.once('listening', () => server.close(() => resolve(false)))
    try {
      server.listen(targetPort, address)
    } catch {
      // A host with no IPv6 stack throws rather than emitting 'error'. Absence
      // of a stack is not evidence of a holder.
      resolve(false)
    }
  })
}

/**
 * Occupied = the OS names a listener, OR any of the three addresses a listener
 * could plausibly have taken refuses to bind. Both halves are load-bearing: the
 * table above proves one probe is blind to two thirds of the cases, and the
 * listener table is unavailable on a host with neither netstat nor lsof.
 */
async function portIsOccupied(targetPort) {
  if (portHolder(targetPort)) return true
  for (const address of ['127.0.0.1', '0.0.0.0', '::']) {
    if (await bindProbe(targetPort, address)) return true
  }
  return false
}

/**
 * When did this process start, per the OS? Used to prove a listener we are
 * about to ADOPT is running the current mcp-auth-proxy.mjs rather than a build
 * from before its last edit. Best effort; null means "could not tell".
 */
function processStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
        ],
        { encoding: 'utf8', timeout: 15000 },
      ).trim()
      const ms = Date.parse(out)
      return Number.isFinite(ms) ? ms : null
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const ms = Date.parse(out)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

async function health(base) {
  try {
    const res = await fetch(`${base}/health`)
    if (!res.ok) return null
    const body = JSON.parse(await res.text())
    if (body.status && body.status !== 'ok') return null
    return body
  } catch {
    return null
  }
}

async function waitForHealth(base, seconds) {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const h = await health(base)
    if (h) return h
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 500))
  }
}

// The MCP streamable-HTTP transport answers either JSON or SSE; take the last
// data frame either way (same parse clean-bench-brain.mjs and the runner's
// preflight use).
function parseRpc(text) {
  const line = text
    .replace(/^data:\s*/gm, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

let rpcId = 0
async function rpc(base, method, params, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 160)}`)
  const body = parseRpc(text)
  if (!body) throw new Error(`${method} returned an unparseable body: ${text.slice(0, 160)}`)
  if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error).slice(0, 160)}`)
  return { result: body.result, sessionId: res.headers.get('mcp-session-id') || sessionId }
}

// --stop HAD THE SAME BLIND SPOT AS THE LAUNCH PATH, and it is worth naming
// separately because it is the operator's remedy. It signalled the REGISTRY's
// pid and then deleted the record. On 2026-08-20 the registry named 137464 — a
// child that had crashed at startup — while the process actually holding the
// port was 32940. `--stop` would have reported "pid 137464 is not running;
// clearing the record", exited 0, LEFT THE REAL PROXY RUNNING, and thrown away
// the only record that anything had ever been started there. The next launch
// then meets an unexplained listener with no registry at all.
//
// It does NOT auto-kill a stranger: this launcher did not start it, cannot know
// what it is, and a benchmark host is not a place to shoot unidentified
// processes. It names it and prints the command.
function stopProxy() {
  const reg = readJson(proxyRegistryPath)
  if (!reg || !reg.pid) {
    console.log(`[stack] no proxy record at ${proxyRegistryPath}; nothing to stop.`)
  } else if (!pidAlive(reg.pid)) {
    console.log(`[stack] proxy pid ${reg.pid} is not running; clearing the record.`)
  } else {
    try {
      // SIGTERM, not SIGKILL: mcp-auth-proxy.mjs's shutdown handler flushes any
      // deferred writes and prints its own tool-call tally, which is part of
      // the run's evidence.
      process.kill(reg.pid, 'SIGTERM')
      console.log(`[stack] sent SIGTERM to proxy pid ${reg.pid} (port ${proxyPort}).`)
    } catch (err) {
      console.log(`[stack] could not signal proxy pid ${reg.pid}: ${err.code ?? err.message}`)
    }
  }
  fs.rmSync(proxyRegistryPath, { force: true })

  // THEN ASK THE OS, because the record is exactly what cannot be trusted here.
  const stillThere = portHolder(proxyPort)
  if (stillThere && (!reg || stillThere.pid !== reg.pid)) {
    console.log(
      `[stack] WARNING: ${proxyPort} is STILL held by pid ${stillThere.pid}${stillThere.image ? ` (${stillThere.image})` : ''}` +
        `${stillThere.address ? ` on ${stillThere.address}` : ''}${reg ? ` — the record named pid ${reg.pid}` : ''}.`,
    )
    console.log('[stack] This launcher did not start it and will not kill it. Stop it yourself before relaunching:')
    console.log(
      `[stack]   ${process.platform === 'win32' ? `taskkill /PID ${stillThere.pid} /F` : `kill ${stillThere.pid}`}`,
    )
  }
}

// ── WHY THE BODY IS A FUNCTION AND NOTHING CALLS process.exit() ─────────────
// MEASURED on this machine (node v24.3.0, Windows, 2026-08-19), reduced to a
// two-line repro:
//   node -e 'for (const p of [P,P]) { const r = await fetch(url); await r.text() }
//            process.exit(1)'
//   -> Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c
//   -> the process ABORTS with exit code 127 instead of 1.
// This launcher probes /health several times and then exits with a verdict, so
// process.exit() would hand every caller -- `&&` chains, the runner's
// TB_START_STACK path, any gate -- a meaningless 127 in place of the real
// status. `process.exitCode` + letting the loop drain exits immediately
// (0.12 s measured) with the intended code, so every exit point RETURNS one.
// Verified against --status, which reported NOT READY and then aborted 127
// five times out of five before this change.
async function main() {
  if (stopRequested) {
    stopProxy()
    const r = spawnSync(process.execPath, [brainLauncher, '--stop', '--port', String(brainPort), '--data-dir', dataDir], {
      stdio: 'inherit',
    })
    return r.status ?? 0
  }

  if (statusRequested) {
    const brainHealth = await health(`http://127.0.0.1:${brainPort}`)
    const proxyHealth = await health(`http://127.0.0.1:${proxyPort}`)
    const brainReg = readJson(path.join(stackDir, `brain-${brainPort}.json`))
    const proxyReg = readJson(proxyRegistryPath)
    console.log(
      `[stack] brain  ${brainPort}: ${brainHealth ? `up (serving port ${brainHealth.port}, memory_total=${brainHealth.memory_total ?? '?'})` : 'DOWN'}` +
        `${brainReg ? ` pid=${brainReg.pid} data-dir=${brainReg.dataDir}` : ''}`,
    )
    console.log(
      `[stack] proxy  ${proxyPort}: ${proxyHealth ? `up (serving a brain that reports port ${proxyHealth.port})` : 'DOWN'}` +
        `${proxyReg ? ` pid=${proxyReg.pid} upstream=${proxyReg.upstreamPort} store=${proxyReg.dataDir}` : ''}`,
    )
    // WHO IS ACTUALLY THERE. Every field printed above except the health probe
    // comes from a FILE this launcher wrote, and on 2026-08-20 that file was
    // wrong: it named pid 137464, which had crashed at startup, while pid 32940
    // — started eleven hours earlier, before mcp-auth-proxy.mjs's own mtime —
    // served every request. `--status` said READY. It was not lying about
    // health; it was answering a question nobody had asked.
    //
    // The VERDICT is deliberately left alone (health-driven, exit code
    // unchanged): a graded sweep can be in flight when someone runs --status,
    // and flipping its exit code mid-campaign is a change to something other
    // people's scripts read. The facts go next to it instead, where they cannot
    // be missed.
    const proxyOwner = portHolder(proxyPort)
    if (proxyHealth && proxyOwner) {
      const startedMs = processStartMs(proxyOwner.pid)
      const proxyMtimeMs = fs.existsSync(proxyScript) ? fs.statSync(proxyScript).mtimeMs : null
      const stale = Number.isFinite(startedMs) && proxyMtimeMs !== null && startedMs < proxyMtimeMs
      console.log(
        `[stack]   the process on ${proxyPort} is pid ${proxyOwner.pid}${proxyOwner.image ? ` (${proxyOwner.image})` : ''}` +
          `${proxyOwner.address ? ` bound to ${proxyOwner.address}` : ''}` +
          `${Number.isFinite(startedMs) ? `, started ${new Date(startedMs).toISOString()}` : ''}.`,
      )
      if (proxyReg && proxyOwner.pid !== proxyReg.pid) {
        console.log(
          `[stack]   WARNING: that is NOT the pid on record (${proxyReg.pid}). Whatever is serving this port, this`,
        )
        console.log('[stack]   launcher did not start it, and the registry describes a different process.')
      }
      if (stale) {
        console.log(
          `[stack]   WARNING: it predates ${path.basename(proxyScript)} (modified ${new Date(proxyMtimeMs).toISOString()}),`,
        )
        console.log('[stack]   so it CANNOT be running the current build. Any behaviour added since is absent.')
      }
    } else if (proxyHealth) {
      console.log('[stack]   (could not read the OS listener table, so the pid serving this port is unverified)')
    }
    const ok = !!brainHealth && !!proxyHealth && Number(proxyHealth.port) === brainPort
    console.log(`[stack] ${ok ? 'READY' : 'NOT READY'} — export TERRANSOUL_MCP_URL=${mcpUrl}`)
    return ok ? 0 : 1
  }

  // ── 0. The seed, VALIDATED BEFORE ANYTHING IS SPAWNED ───────────────────────
  // Deliberately the first thing that happens. A launch that cannot be seeded
  // must fail while nothing is running — refusing after the brain is up leaves
  // a half-built stack behind, and the operator's next move is usually to
  // press on with it.
  let seedLessons = null
  if (seedDisabled) {
    console.log('[stack] SEEDING DISABLED by TB_STACK_NO_SEED. The store gets no generic prior, and')
    console.log('[stack] extra-instruction-harness.md no longer carries that guidance either — a run')
    console.log('[stack] from this stack ships it in NEITHER channel and must be reported as such.')
  } else {
    try {
      const dry = await seedBrain({ seedPath, tasksDir, dryRun: true, log: (l) => console.log(l) })
      seedLessons = dry.lessons
    } catch (err) {
      if (!(err instanceof SeedError)) throw err
      console.error(`[stack] REFUSING: ${err.message}`)
      console.error('[stack] The seed is not optional. extra-instruction-harness.md was shrunk 72% on the')
      console.error('[stack] argument that its deleted guidance lives in the STORE instead; an unseeded run')
      console.error('[stack] has it in neither place and looks exactly like a good one from the outside.')
      console.error('[stack] Point --seed at the file, or set TB_STACK_NO_SEED=1 to launch without it and')
      console.error('[stack] have that stated on the receipt.')
      return 4
    }
  }

  // ── 1. The brain, through its own launcher (single source of truth) ─────────
  // --reuse is passed deliberately: this launcher is meant to be idempotent, and
  // start-bench-brain.mjs grants reuse ONLY for an instance it started itself,
  // on this exact port, against this exact data dir. A stranger on the port —
  // including the same binary serving a different store — is still refused
  // there, and that refusal propagates straight through here.
  console.log(`[stack] brain: port ${brainPort}, data-dir ${dataDir}`)
  const brainRun = spawnSync(
    process.execPath,
    [brainLauncher, '--port', String(brainPort), '--data-dir', dataDir, '--wait', String(brainWait), '--reuse'],
    { stdio: 'inherit' },
  )
  if ((brainRun.status ?? 1) !== 0) {
    console.error(`[stack] REFUSING to continue: the bench brain did not come up on ${brainPort}.`)
    return brainRun.status ?? 1
  }

  if (!fs.existsSync(tokenPath)) {
    console.error(`[stack] REFUSING: the brain is up but has no token file at ${tokenPath}.`)
    console.error('[stack] The proxy derives its bearer token from the upstream store; without that file there')
    console.error('[stack] is nothing legitimate to authenticate with, and the old production fallback is gone.')
    return 2
  }

  // ── 1b. The disclosed generic prior goes INTO the store ─────────────────────
  // DIRECT to the brain, not through the proxy: the proxy is read-only on the
  // submission path and refuses `brain_ingest_lesson` with -32001. This is prep,
  // before any agent exists; the agent's own path stays write-blocked.
  //
  // Idempotent WITHOUT client-side state (rules/mcp-single-source-of-truth.md):
  // the gateway dedups on exact trimmed content and answers `deduplicated:true`,
  // so a re-launch writes nothing and the counts below come from the SERVER's
  // answer rather than from a local record of what we think we wrote.
  let seedCounts = null
  if (seedLessons) {
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    try {
      seedCounts = await applySeed({
        url: `http://127.0.0.1:${brainPort}`,
        token,
        lessons: seedLessons,
        log: (l) => console.log(l),
      })
      console.log(
        `[stack] seed: ${seedCounts.total} generic lesson(s) in the store — ${seedCounts.written} written now, ` +
          `${seedCounts.deduplicated} already present.`,
      )
    } catch (err) {
      if (!(err instanceof SeedError)) throw err
      console.error(`[stack] REFUSING: the seed could not be applied — ${err.message}`)
      console.error('[stack] A refused write can also be the earned-autonomy `safe_write` gate on a store with')
      console.error('[stack] no trust history; a denied retry does not reset its cooldown. Either way the run')
      console.error('[stack] would go out with the generic prior in neither the prompt nor the store, so this')
      console.error('[stack] stops here rather than starting the proxy.')
      return 4
    }
  }

  // ── 2. The proxy ────────────────────────────────────────────────────────────
  //
  // ADOPTION IS PROVEN, NOT ASSUMED. "Something healthy answers on the port" was
  // the exact evidence that made 2026-08-20's stale listener invisible, and it
  // is not evidence of anything: /health is served by whoever holds the socket,
  // which is the process we are trying to distinguish FROM. None of this branch
  // ran on 2026-08-20 — the occupancy probe reported the port free, so the
  // launcher went straight to spawning. It is hardened anyway, because the
  // detector above now DOES see that listener and everything below is what it
  // will be judged by. Four independent facts must line up:
  //   (a) the registry names a pid and that pid is alive. The registry alone is
  //       worthless: that night it named 137464, a child that had already
  //       crashed, while a different process served every request.
  //   (b) THE OS SHOWS THAT SAME PID LISTENING ON THIS PORT (pid-to-port). This
  //       is the fact nothing checked. The port answered; nobody asked who.
  //   (c) it is pointed at this brain and this store, and reports so.
  //   (d) IT IS THE CURRENT BUILD: it started AFTER mcp-auth-proxy.mjs was last
  //       modified. The stale listener served a build eleven hours older than
  //       the proxy source, so every observability field added that evening was
  //       missing from a graded run while the launcher called it verified.
  const existingProxy = readJson(proxyRegistryPath)
  // Set ONLY when this invocation spawned a proxy. Verification below is tied
  // to THIS handle — a pid we own and can watch die — rather than to whatever
  // happens to answer the port.
  let spawnedProxy = null
  if (await portIsOccupied(proxyPort)) {
    const served = await health(`http://127.0.0.1:${proxyPort}`)
    const holder = portHolder(proxyPort)
    const proxyMtimeMs = fs.statSync(proxyScript).mtimeMs
    // The OS's own answer first; the registry's own claim only as a fallback,
    // because a host where neither netstat nor lsof runs still deserves a
    // freshness check rather than none.
    const listenerStartedMs =
      (existingProxy ? processStartMs(existingProxy.pid) : null) ??
      (existingProxy && existingProxy.startedAt ? Date.parse(existingProxy.startedAt) : null)
    const currentBuild = Number.isFinite(listenerStartedMs) && listenerStartedMs >= proxyMtimeMs
    // "Could not read the listener table" must not silently become "the pid
    // matches". It falls back to liveness and SAYS so on the receipt.
    const pidToPort = holder ? holder.pid === (existingProxy && existingProxy.pid) : null
    const mine =
      existingProxy &&
      pidAlive(existingProxy.pid) &&
      pidToPort !== false &&
      Number(existingProxy.upstreamPort) === brainPort &&
      path.resolve(existingProxy.dataDir) === path.resolve(dataDir) &&
      served &&
      Number(served.port) === brainPort &&
      currentBuild
    if (mine) {
      console.log(
        `[stack] proxy already running on ${proxyPort} as pid ${existingProxy.pid}, serving ${brainPort}; reusing it.`,
      )
      if (pidToPort === null) {
        console.log(
          `[stack] WARNING: could not read the OS listener table, so pid ${existingProxy.pid} is only known to be`,
        )
        console.log('[stack] ALIVE, not proven to be the process bound to that port.')
      }
      console.log(
        `[stack] proxy: adopted pid ${existingProxy.pid} — bound to ${proxyPort}, started ${new Date(listenerStartedMs).toISOString()}, after mcp-auth-proxy.mjs's ${new Date(proxyMtimeMs).toISOString()}.`,
      )
    } else {
      console.error(`[stack] REFUSING: port ${proxyPort} is occupied by something this launcher cannot vouch for.`)
      if (holder) {
        console.error(
          `[stack]   the OS shows pid ${holder.pid}${holder.image ? ` (${holder.image})` : ''} listening on ${holder.address ? `${holder.address}:` : ''}${proxyPort}.`,
        )
      } else {
        console.error(
          '[stack]   the port refuses to bind but netstat/lsof could not name the holder — it is held all the same.',
        )
      }
      if (served) {
        console.error(`[stack]   whatever answers there serves a brain that reports port ${served.port} (expected ${brainPort}).`)
      } else {
        console.error('[stack]   it does not answer /health at all.')
      }
      if (existingProxy) {
        console.error(`[stack]   ${proxyRegistryPath} records pid ${existingProxy.pid} upstream ${existingProxy.upstreamPort} store ${existingProxy.dataDir}.`)
        if (!pidAlive(existingProxy.pid)) {
          console.error(`[stack]   that pid is NOT running — the record is stale and something else took the port.`)
        } else if (pidToPort === false) {
          console.error(
            `[stack]   that pid is alive but is NOT the process on the port — the record describes a different process.`,
          )
        } else if (!currentBuild) {
          console.error(
            `[stack]   STALE BUILD: it started ${Number.isFinite(listenerStartedMs) ? new Date(listenerStartedMs).toISOString() : 'at an unknown time'}, but ${path.basename(proxyScript)} was last modified ${new Date(proxyMtimeMs).toISOString()}.`,
          )
          console.error('[stack]   A listener older than the source cannot contain it. On 2026-08-20 that shape put a')
          console.error('[stack]   graded run through an eleven-hour-old proxy with none of the observability it')
          console.error('[stack]   was supposed to record, and the launcher reported "verified".')
        }
      } else {
        console.error('[stack]   this launcher has no record of starting a proxy on that port.')
      }
      console.error(`[stack] Stop it first: node benchmark/terminal-bench-3.0/start-bench-stack.mjs --stop --proxy-port ${proxyPort}`)
      if (holder) {
        console.error(
          `[stack] or kill the holder: ${process.platform === 'win32' ? `taskkill /PID ${holder.pid} /F` : `kill ${holder.pid}`}`,
        )
      }
      return 3
    }
  } else {
    fs.mkdirSync(proxyLogDir, { recursive: true })
    fs.mkdirSync(stackDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const proxyLogPath = path.join(proxyLogDir, `stack-proxy-${stamp}.log`)
    const callLogPath = path.join(proxyLogDir, `proxy-stack-${stamp}.jsonl`)
    const out = fs.openSync(proxyLogPath, 'a')
    // DETACHED, and its stdio goes to a file — incident (4): the proxy was a
    // harness-tracked background task and was killed mid-sweep, taking MCP away
    // from live trials for ~12 minutes while the fail-open Stop hook reported
    // nothing. It must outlive the shell that starts it, exactly as harbor does.
    const proxy = spawn(process.execPath, [proxyScript], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        TB_PROXY_PORT: String(proxyPort),
        TB_PROXY_UPSTREAM_PORT: String(brainPort),
        TB_PROXY_UPSTREAM_HOST: '127.0.0.1',
        TB_PROXY_UPSTREAM_DATA_DIR: dataDir,
        TERRANSOUL_MCP_TOKEN_FILE: tokenPath,
        TB_PROXY_LOG: process.env.TB_PROXY_LOG || callLogPath,
        // ── Writes stay blocked, and that has to be ENFORCED, not assumed ──
        //
        // An earlier revision of this block carried the comment "Writes stay
        // blocked. TB_PROXY_MODE is deliberately NOT set here." That was wrong
        // in the most dangerous way available: NOT SETTING IS NOT CLEARING.
        // `...process.env` above forwards the operator's whole environment, so
        // a `TB_PROXY_MODE=learn` exported once in their shell — for a research
        // arm, hours earlier — rode straight into the detached proxy of a
        // supposedly read-only submission run.
        //
        // MEASURED by the verify pass before this shipped: the identical
        // `brain_ingest_lesson` call refused with -32001 under the intended
        // mode and was proxied straight to the upstream under the inherited
        // one. TB-3's acceptance criterion is literally "0 brain writes during
        // a run", so this silently voids the run's central claim.
        //
        // Nothing downstream could catch it, which is what makes it worth an
        // explicit line: the suite's guard greps FILES for `TB_PROXY_MODE=learn`
        // and cannot see an exported variable; the runner's preflight calls
        // `tools/list`, which is unfiltered and returns the same 49 tools in
        // both modes; and the READY receipt and `.stack/proxy-*.json` recorded
        // port, upstream, store and token but not the mode. A run could be
        // write-enabled with no artifact anywhere saying so.
        //
        // So the mode is set EXPLICITLY here rather than inherited. Opting into
        // the research arm now means passing TB_STACK_PROXY_MODE to this
        // launcher, which is recorded on the receipt and in the registry.
        TB_PROXY_MODE: proxyMode,
      },
      stdio: ['ignore', out, out],
    })
    proxy.unref()
    // THE CHILD'S OWN DEATH IS THE ONLY WITNESS THAT IT NEVER CAME UP.
    // `unref()` stops the child from holding the event loop open; it does NOT
    // stop 'exit' from being delivered while this launcher is still running, so
    // a crash-on-start is observable here and only here. Before this, a child
    // that died at startup was indistinguishable from a slow one, and then from
    // a healthy one, because the probe that followed hit THE PORT — which on
    // 2026-08-20 an eleven-hour-old process answered.
    let childExit = null
    proxy.on('exit', (code, signal) => {
      childExit = { code, signal }
    })
    proxy.on('error', (err) => {
      childExit = { code: null, signal: null, error: err.code || err.message }
    })
    fs.writeFileSync(
      proxyRegistryPath,
      `${JSON.stringify(
        {
          pid: proxy.pid,
          port: proxyPort,
          upstreamPort: brainPort,
          dataDir,
          tokenPath,
          // Recorded because a write-enabled run must never be
          // indistinguishable from a read-only one after the fact.
          proxyMode: proxyMode || 'read-only',
          // Same reason, for the other thing that silently changes what a run
          // measures: whether the store holds the disclosed generic prior.
          seed: seedCounts
            ? { file: seedPath, total: seedCounts.total, written: seedCounts.written, alreadyPresent: seedCounts.deduplicated }
            : 'disabled by TB_STACK_NO_SEED',
          logPath: proxyLogPath,
          callLogPath,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    )
    // NOT "started". SPAWNED. On 2026-08-20 this line read
    //   [stack] proxy: started as pid 137464 on 7425 -> 7424
    // for a child that was, at that moment, already writing an EADDRINUSE stack
    // trace into its log and exiting. A launcher that announces success at
    // spawn time is announcing that `spawn()` returned, which is not a fact
    // anyone needs. The "started" receipt now comes AFTER the proof, below.
    spawnedProxy = { pid: proxy.pid, logPath: proxyLogPath, exit: () => childExit }
    console.log(`[stack] proxy: spawned pid ${proxy.pid} for ${proxyPort} -> ${brainPort}, log ${proxyLogPath}`)
    console.log('[stack] proxy: not declared started until it is proven alive, bound to that port, and answering.')
  }

  // ── 3. Verify, do not assume ────────────────────────────────────────────────
  const proxyBase = `http://127.0.0.1:${proxyPort}`

  function proxyLogTail(logPath, lines = 40) {
    if (!logPath || !fs.existsSync(logPath)) return null
    return fs.readFileSync(logPath, 'utf8').split('\n').slice(-lines).join('\n').trimEnd()
  }

  /** A refusal that SURFACES the child's own output instead of hiding it. */
  function abandonProxy(reason, code = 1) {
    console.error(`[stack] REFUSING: ${reason}`)
    const logPath = spawnedProxy ? spawnedProxy.logPath : (readJson(proxyRegistryPath) || {}).logPath
    const tail = proxyLogTail(logPath)
    if (tail) {
      console.error(`[stack] the proxy's own output (${logPath}):`)
      console.error(tail)
    } else {
      console.error(`[stack] the proxy left no output at ${logPath ?? '(no log path recorded)'}.`)
    }
    stopProxy()
    return code
  }

  let proxyHealth = null
  if (spawnedProxy) {
    // WATCH THE CHILD, NOT THE PORT. Each iteration asks, in order: did the
    // process we started die, is it still alive, and only then does it probe.
    // The pre-change loop asked only the third question, so a dead child and a
    // stranger on the port both read as success.
    const deadline = Date.now() + proxyWait * 1000
    for (;;) {
      // TWO DETECTORS, ONE FACT, ONE SENTENCE. `process.kill(pid, 0)` reflects
      // OS truth the instant the child is gone; the 'exit' event has to wait for
      // libuv to reap it, and MEASURED here the liveness check wins that race
      // roughly every time. Reporting them as two different outcomes would make
      // the message depend on which detector happened to fire — so the exit
      // status is waited for briefly (only once the child is already known dead,
      // so this costs nothing on the happy path) and the verdict reads the same
      // either way. The alternative is a guard whose text a test cannot pin.
      let exit = spawnedProxy.exit()
      if (!exit && !pidAlive(spawnedProxy.pid)) {
        for (let i = 0; i < 5 && !exit; i += 1) {
          await new Promise((r) => setTimeout(r, 100))
          exit = spawnedProxy.exit()
        }
        exit = exit || { code: null, signal: null, unknown: true }
      }
      if (exit) {
        const how = exit.error
          ? ` (${exit.error})`
          : exit.unknown
            ? ' (the OS reports it is gone; no exit status was delivered)'
            : ` (exit code ${exit.code}${exit.signal ? `, signal ${exit.signal}` : ''})`
        return abandonProxy(
          `the proxy process (pid ${spawnedProxy.pid}) DIED DURING STARTUP${how} and never served ${proxyPort}.`,
        )
      }
      proxyHealth = await health(proxyBase)
      if (proxyHealth) break
      if (Date.now() >= deadline) {
        return abandonProxy(
          `the proxy (pid ${spawnedProxy.pid}) never became healthy on ${proxyPort} within ${proxyWait}s.`,
        )
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    // PID-TO-PORT. The health answer above proves only that SOMETHING serves
    // this port. It has to be OURS: 2026-08-20's "verified" line was produced by
    // a process this launcher had never started and could not see.
    const listener = portHolder(proxyPort)
    if (listener && listener.pid !== spawnedProxy.pid) {
      return abandonProxy(
        `the answer on ${proxyPort} comes from pid ${listener.pid}${listener.image ? ` (${listener.image})` : ''}, ` +
          `not from pid ${spawnedProxy.pid}, which is the process this launcher started. Whatever is being verified, it is not ours.`,
        3,
      )
    }
    if (!listener) {
      console.log('[stack] WARNING: could not read the OS listener table; pid-to-port is UNPROVEN for this run.')
    }
    console.log(
      `[stack] proxy: started as pid ${spawnedProxy.pid} on ${proxyPort} -> ${brainPort}` +
        (listener ? ', confirmed by the OS as the process bound to that port.' : '.'),
    )
  } else {
    proxyHealth = await waitForHealth(proxyBase, proxyWait)
    if (!proxyHealth) {
      return abandonProxy(`the adopted proxy stopped answering on ${proxyPort}.`)
    }
  }
  if (Number(proxyHealth.port) !== brainPort) {
    console.error(
      `[stack] REFUSING: the proxy on ${proxyPort} is serving a brain that reports port ${proxyHealth.port}, not ${brainPort}.`,
    )
    console.error('[stack] That is incident (1)/(3) of 2026-08-19 exactly: a proxy fronting the wrong store, or a')
    console.error('[stack] brain that bound a port nobody asked for. Nothing is started until it is right.')
    stopProxy()
    return 3
  }

  // THE CHECK THAT CATCHES A WRONG TOKEN. /health is unauthenticated, so it is
  // green even when the bearer token belongs to another store — which is exactly
  // how the 2026-08-19 misspelt-variable bug survived to a 401 mid-run. An
  // authenticated tools/list through the proxy is the first call that proves the
  // credential actually opens this upstream.
  try {
    const init = await rpc(proxyBase, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tb-stack-preflight', version: '1' },
    })
    const listed = await rpc(proxyBase, 'tools/list', {}, init.sessionId)
    const names = (listed.result?.tools || []).map((t) => t.name)
    for (const required of ['brain_health', 'brain_search']) {
      if (!names.includes(required)) {
        throw new Error(`tools/list does not serve ${required} (served: ${names.join(', ') || 'none'})`)
      }
    }
    console.log(`[stack] verified: authenticated tools/list through the proxy served ${names.length} tool(s).`)

    // THE BINARY, NOT THE SOURCE. `initialize` has already been called above,
    // so reading its `instructions` costs nothing and answers the one question
    // no cargo test can: is the brain that is RUNNING serving the de-suppressed
    // text? Measured 2026-08-19, the deployed .exe still carried both
    // suppression literals and none of the consultation triggers while every
    // test in the repo was green — and extra-instruction-harness.md had already
    // been shrunk on the assumption that it did not.
    const verdict = checkServedInstructions(init.result?.instructions)
    if (!verdict.ok) {
      reportFailure(verdict, (l) => console.error(l), `${proxyBase} (brain ${brainPort})`)
      console.error('[stack] REFUSING: nothing is left running that would serve stale instructions.')
      stopProxy()
      return 5
    }
    console.log('[stack] verified: the served SERVER_INSTRUCTIONS carry every consultation trigger and no')
    console.log('[stack] suppression literal — this brain binary is the rebuilt one.')
  } catch (err) {
    console.error(`[stack] REFUSING: the proxy is up but an authenticated MCP call failed — ${err.message}`)
    console.error('[stack] A 401 here means the bearer token does not belong to the upstream store. The token was')
    console.error(`[stack] read from ${tokenPath}; the upstream is the brain on ${brainPort}.`)
    stopProxy()
    return 2
  }

  // The seed state goes ON THE RECEIPT for the same reason the proxy mode does:
  // a run whose store has no generic prior must not be indistinguishable from
  // one that has it, after the fact.
  const seedReceipt = seedCounts
    ? `seed=${seedCounts.total}(${seedCounts.written} new)`
    : 'seed=NONE(TB_STACK_NO_SEED — no generic prior in the store)'
  console.log(
    `[stack] READY brain=${brainPort}(${path.relative(repoRoot, dataDir) || dataDir}) proxy=${proxyPort} mode=${proxyMode || 'read-only'} ${seedReceipt} memory_total=${proxyHealth.memory_total ?? '?'}`,
  )
  console.log(`[stack] export TERRANSOUL_MCP_URL=${mcpUrl}`)
  console.log('[stack] stop the whole stack with: node benchmark/terminal-bench-3.0/start-bench-stack.mjs --stop')
  return 0
}

process.exitCode = await main()
