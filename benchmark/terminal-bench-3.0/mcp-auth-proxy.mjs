#!/usr/bin/env node
// Header-injecting MCP proxy for Terminal-Bench D-G.
//
// WHY THIS EXISTS — measured 2026-08-04, see rules/tbench-playbook.md.
//
// Harbor CANNOT pass MCP auth headers. Its
// `claude_code.py::_build_register_mcp_servers_command` serialises every
// non-stdio server as exactly `{"type": transport, "url": server.url}` — a
// `headers` block in --mcp-config is silently dropped, and the stdio branch
// carries no `env` either. TerranSoul's MCP router accepts only
// `Authorization: Bearer <token>` (router.rs::validate_auth), so the task
// container could reach the brain but never authenticate: the trial reported
// `"mcp_servers":[{"name":"terransoul","status":"failed"}]` and would have
// scored plain Claude Code while carrying TerranSoul's name.
//
// This proxy takes the container's unauthenticated request and adds the
// header on the host side, so the real token never enters the container.
//
// READ-ONLY BY DEFAULT, deliberately. TB-3's acceptance criterion is
// literally "0 brain writes during a 5-task run", and rules/bench-agi-purity.md
// forbids a benchmark contaminating the brain it is being measured against.
// The allowlist below mirrors router.rs::is_public_tool_name exactly. Set
// TB_PROXY_ALLOW_WRITES=1 to lift it (and then do NOT publish the run as a
// clean measurement).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const LISTEN_PORT = Number(process.env.TB_PROXY_PORT || 7425)
const UPSTREAM_HOST = process.env.TB_PROXY_UPSTREAM_HOST || '127.0.0.1'

// ── WHICH BRAIN THIS PROXY SERVES (TBENCH-STACK-1, measured 2026-08-19) ─────
// THE DEFAULT USED TO BE 7423 — THE PRODUCTION BRAIN. On 2026-08-19 a proxy
// was started for a bench run without TB_PROXY_UPSTREAM_PORT and therefore
// served production, which holds task-specific TerminalBench lessons from
// earlier campaigns, straight to the agent. Only run-terransoul-verifyhook.sh's
// separate contamination guard caught it. That guard is good and stays, but a
// default that is wrong-by-design is the root cause: a downstream guard is not
// a licence to ship a footgun upstream of it.
//
// This is a BENCH-SCOPED script (it lives in benchmark/terminal-bench-3.0/ and
// exists only to front the isolated bench brain), so the bench brain is the
// only defensible default. Pointing it at production is still possible, but
// only as a deliberate, acknowledged act: TB_PROXY_ALLOW_PRODUCTION_UPSTREAM=1.
const PRODUCTION_BRAIN_PORT = Number(process.env.TB_PRODUCTION_BRAIN_PORT || 7423)
const BENCH_BRAIN_PORT = Number(process.env.TB_BENCH_BRAIN_PORT || 7424)
const UPSTREAM_PORT = Number(process.env.TB_PROXY_UPSTREAM_PORT || BENCH_BRAIN_PORT)
const ALLOW_WRITES = process.env.TB_PROXY_ALLOW_WRITES === '1'
const LOG_PATH = process.env.TB_PROXY_LOG || ''

// The port -> store mapping this campaign actually runs on. Used to DERIVE the
// bearer token from the upstream being served instead of defaulting to a store
// that has nothing to do with it (see the token block further down).
const PRODUCTION_DATA_DIR = path.join(REPO_ROOT, 'mcp-data')
const STORE_FOR_PORT = new Map([
  [PRODUCTION_BRAIN_PORT, PRODUCTION_DATA_DIR],
  [BENCH_BRAIN_PORT, path.join(REPO_ROOT, 'mcp-data-tbench-clean')],
])
const UPSTREAM_IS_LOOPBACK = UPSTREAM_HOST === '127.0.0.1' || UPSTREAM_HOST === 'localhost' || UPSTREAM_HOST === '::1'

if (UPSTREAM_PORT === PRODUCTION_BRAIN_PORT && UPSTREAM_IS_LOOPBACK && process.env.TB_PROXY_ALLOW_PRODUCTION_UPSTREAM !== '1') {
  console.error(
    `[tb-proxy] REFUSING: upstream is the PRODUCTION brain (port ${PRODUCTION_BRAIN_PORT}). It holds ` +
      'task-specific TerminalBench lessons from earlier campaigns; serving them to a benchmark agent ' +
      'is contamination and invalidates the submission (rules/bench-agi-purity.md).',
  )
  console.error(`[tb-proxy] Point this proxy at the isolated bench brain: TB_PROXY_UPSTREAM_PORT=${BENCH_BRAIN_PORT}`)
  console.error('[tb-proxy] Or bring up the whole stack in one command: node benchmark/terminal-bench-3.0/start-bench-stack.mjs')
  console.error('[tb-proxy] If you genuinely mean to front production, set TB_PROXY_ALLOW_PRODUCTION_UPSTREAM=1 and do NOT publish the run.')
  process.exit(2)
}

// Mirrors src-tauri/src/ai_integrations/mcp/router.rs::is_public_tool_name.
// Kept as an explicit copy rather than imported: this is a bench-scoped guard,
// and if the server's list ever changes we want the divergence to be visible
// here rather than silently inherited.
//
// ⚠️ MEASURED 2026-08-04: this list is a SUPERSET of what the server actually
// serves. `is_public_tool_name` is the LAN-anonymous READ POLICY; the tools on
// the wire are `tools.rs::EXPOSED_TOOLS`, an owner-approved product API
// (2026-08-01, "one coherent CRUD+RAG API", down from 84; widened 9 -> 11 on
// 2026-08-16 for the loop's own safety net, see below). Several names below —
// brain_suggest_context, brain_summarize, brain_list_recent, brain_failover_status
// and every brain_wiki_* — are allowlisted here but are NOT advertised by the
// server, so allowing them changes nothing. Harmless as a permission, actively
// misleading as a description: keep the policy mirror intact, and tell the
// agent about EXPOSED_BRAIN_TOOLS instead (see gate()).
//
// `brain_verify_completion` ADDED 2026-08-17, TerranSoul's Stop hook. Its
// `op='verify'` (default, and the ONLY op this campaign's hook ever calls)
// judges completion — it does not mutate `memories`. `op='record'` /
// `mark_edited'` write to a SEPARATE verification-evidence ledger, not the
// memory store the "0 brain writes" acceptance criterion is about, and
// nothing in this repo currently calls them through this proxy — read-only
// in effect for every call this gate will ever actually see.
const READ_ONLY_TOOLS = new Set([
  'brain_search',
  'brain_get_entry',
  'brain_list_recent',
  'brain_kg_neighbors',
  'brain_summarize',
  'brain_suggest_context',
  'brain_health',
  'brain_failover_status',
  'brain_wiki_audit',
  'brain_wiki_spotlight',
  'brain_wiki_serendipity',
  'brain_wiki_revisit',
  'brain_verify_completion',
])

// The brain tools genuinely ON THE WIRE — mirrors tools.rs::EXPOSED_TOOLS.
// Used only to tell a refused caller what it CAN call, so the proxy never
// advertises a tool the server does not serve.
const EXPOSED_BRAIN_TOOLS = [
  'brain_search',
  'brain_get_entry',
  'brain_kg_neighbors',
  'brain_health',
  'brain_ingest_lesson',
  'brain_append',
  'brain_add_edge',
  'brain_close_edge',
  'brain_delete_memory',
  'brain_observe_outcome',
  'brain_verify_completion',
]

// Tools whose reads reach the HOST rather than the brain. Blocked for a
// different reason than writes are, and the refusal says so (see gate()).
const HOST_SCOPED_PREFIXES = ['code_', 'repo_', 'obs_', 'canvas_', 'cross_source_']

// TB_PROXY_MODE=learn — cross-trial learning (owner decision 2026-08-04).
// Adds exactly the tools needed for trial N to record what it learned so trial
// N+1 can retrieve it, and NOTHING else. Blanket TB_PROXY_ALLOW_WRITES=1 would
// also hand the container brain_clear_memory and brain_delete_memory; an agent
// running untrusted benchmark code should never be one bad call away from
// wiping the store it is being measured with.
const LEARN_MODE = process.env.TB_PROXY_MODE === 'learn'
// The full self-learning surface, not just "write a lesson":
//   brain_ingest_lesson  record something new
//   brain_append         REFINE an existing entry instead of creating a
//                        near-duplicate (saves a version snapshot, re-embeds)
//   brain_add_edge       link entries into the knowledge graph
//   brain_close_edge     retract a link that turned out to be wrong
// Deliberately still excluded: brain_delete_memory and anything destructive.
// An agent running untrusted benchmark code may refine and relate what it
// knows; it may not erase it.
// Write tools that carry a prose `content` argument the markup can contaminate.
const LESSON_TOOLS = new Set(['brain_ingest_lesson', 'brain_append'])

// ── VERIFY/OUTCOME TOOLS (TBENCH-EXIT-GATE-1, 2026-08-24) ──────────────────
//
// `brain_verify_completion` is the pre-stop check the server itself designates
// ("the only check available to you before you stop") and the exit gate the
// submission plan specifies. `brain_observe_outcome` is the repeat-action /
// dead-end detector. Both were absent from EVERY allowlist here, so both were
// refused as "write/mutating" tools -- and separately absent from the
// instruction's tool preload, so the agent could not call them anyway.
//
// Measured consequence: across the k=1 failures, 6 of 7 trials stopped with
// 47-85% of their budget unspent and no verification step. The mechanism built
// to prevent exactly that was disconnected at two layers.
//
// WHY THEY ARE EXEMPT FROM THE TASK-IDENTITY GATE, deliberately. That gate
// exists to stop task identity entering CROSS-TASK memory -- lessons that a
// LATER task can retrieve. These two write session-scoped verification state
// (keyed by session_id/root) and negative dead-end memories about the agent's
// own repeated actions. Their payloads legitimately contain the agent's own
// commands, which routinely include task paths; applying the lesson gate would
// refuse nearly every call and re-disable the gate we are here to enable.
// They are allowed for their function, not exempted from scrutiny.
const VERIFY_TOOLS = new Set(['brain_verify_completion', 'brain_observe_outcome'])

// ── PER-TRIAL VERIFICATION SCOPE (TBENCH-LEDGER-SCOPE-1, 2026-08-24) ────────
//
// The verification ledger is keyed by (session_id, root). Every task container
// works in /app, and an agent that omits session_id lands in a shared "default"
// bucket -- so `op:"status"` returned a DIFFERENT, CONCURRENTLY RUNNING trial's
// evidence. Measured: a curve-fitting trial was handed an XSS-filter run's PASS
// from its sibling trial 8 minutes earlier.
//
// Relying on the agent to pass a unique id is the fragility that caused this.
// This proxy fronts exactly one worker running one trial at a time, so it knows
// the scope and stamps it. TB_TRIAL_SCOPE is set per trial by run-dg.sh; the
// port is a correct fallback because workers own distinct ports.
const TRIAL_SCOPE = process.env.TB_TRIAL_SCOPE || `tb-trial-${LISTEN_PORT}`
const SCOPED_TOOLS = new Set(['brain_verify_completion', 'brain_observe_outcome'])


const LEARN_TOOLS = new Set([
  'brain_ingest_lesson',
  'brain_append',
  'brain_add_edge',
  'brain_close_edge',
  // ADDED 2026-08-17: the loop's own dead-end detector. Writes a negative
  // memory after three identical consecutive (context, action, response)
  // observations — the same shape of write as brain_ingest_lesson, just
  // triggered structurally instead of by the agent's own judgement.
  'brain_observe_outcome',
])

// TB_DEFER_WRITES=1 — makes k=5 submittable WITHOUT cross-attempt leakage.
//
// The leaderboard requires >=5 trials per task (leaderboard/SUBMIT.md), but
// with a writable memory attempt 1 of a task could record a lesson that
// attempts 2..5 of the SAME task then retrieve, inflating pass@k.
//
// Rather than filtering reads (which needs response rewriting and a reliable
// way to know which task a request came from), we defer the WRITES: lessons
// are buffered here and flushed to the brain only when this proxy shuts down,
// which run-dg.sh does at the end of each single-task job. So:
//
//   attempts 2..5 of task X  -> cannot see task X's lessons (still buffered)
//   task X+1                 -> sees every lesson from tasks 1..X (flushed)
//
// which is exactly cross-task learning without cross-attempt leakage. It
// requires one task per harbor job; run-sweep.sh does that in deferred mode.
const DEFER_WRITES = process.env.TB_DEFER_WRITES === '1'
const deferred = []

// SPOOL DEFERRED WRITES TO DISK, not only to RAM.
//
// The agent is told "Lesson accepted" the moment a write is deferred, but the
// payload lived only in `deferred[]` until the explicit /__flush. This sweep's
// driver has been killed six times mid-run (script edits, a credential blip, a
// retry-policy fix) and every kill silently discarded whatever was buffered —
// lessons the agent believed it had stored, gone, with the log still showing the
// synthetic ack. That is the same family as every other bug found here: a
// success reported before the effect exists.
//
// Each deferred body is appended to a spool file the moment it arrives, and the
// flush drains the FILE. A killed proxy therefore leaves its lessons on disk,
// and the next run reports them instead of losing them in silence.
const SPOOL_PATH = process.env.TB_DEFER_SPOOL ||
  (LOG_PATH ? `${LOG_PATH}.deferred.jsonl` : '')

function spoolDeferred(bodyBuf) {
  if (!SPOOL_PATH) return
  try {
    fs.appendFileSync(SPOOL_PATH, JSON.stringify({ body: bodyBuf.toString('utf8') }) + '\n')
  } catch (err) {
    console.error(`[tb-proxy] could not spool a deferred lesson: ${err.message}`)
  }
}

/** Deferred bodies still on disk — from THIS run and any killed predecessor. */
function readSpool() {
  if (!SPOOL_PATH || !fs.existsSync(SPOOL_PATH)) return []
  const out = []
  for (const line of fs.readFileSync(SPOOL_PATH, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(Buffer.from(JSON.parse(t).body, 'utf8'))
    } catch {
      // A torn last line (killed mid-append) is skipped, not fatal.
    }
  }
  return out
}

function clearSpool() {
  if (!SPOOL_PATH) return
  try {
    fs.rmSync(SPOOL_PATH, { force: true })
  } catch {
    /* best effort */
  }
}

// ── THE BEARER TOKEN IS DERIVED FROM THE UPSTREAM, NOT DEFAULTED ────────────
// MEASURED 2026-08-19: the correct variable is TERRANSOUL_MCP_TOKEN_FILE, and
// an operator passed `TB_PROXY_TOKEN_FILE` instead — a name that no code reads.
// The old fallback then silently resolved
// `path.join(process.cwd(), 'mcp-data', 'mcp-token.txt')`: THE PRODUCTION
// STORE'S TOKEN, while the upstream was the isolated bench brain. It failed
// safe purely by luck — the bench brain has a different token, so the run got
// a 401 rather than a wrong-store success. A misspelt variable must never be
// able to reach for production credentials.
//
// The rule now: the token belongs to the STORE BEHIND THE UPSTREAM, and a
// token path pointing anywhere else is a hard error, never a default.
//   * TB_PROXY_UPSTREAM_DATA_DIR names the store explicitly (start-bench-stack.mjs
//     passes it), otherwise it is derived from the upstream port.
//   * With an unknown upstream (a remote host, or an unmapped port) there is
//     NO default at all: pass TERRANSOUL_MCP_TOKEN_FILE or TERRANSOUL_MCP_TOKEN.
const upstreamDataDir = process.env.TB_PROXY_UPSTREAM_DATA_DIR
  ? path.resolve(process.env.TB_PROXY_UPSTREAM_DATA_DIR)
  : UPSTREAM_IS_LOOPBACK
    ? STORE_FOR_PORT.get(UPSTREAM_PORT) || null
    : null
const upstreamLabel = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`

// ── An EXPLICIT data dir must still agree with a KNOWN upstream port ────────
//
// TB_PROXY_UPSTREAM_DATA_DIR used to be trusted outright. That reopened the
// very hole the token derivation below closes: the "production token for a
// non-production upstream" check is reached only when the data dir was
// DERIVED, so naming the dir explicitly walked straight past it. Demonstrated
// by the verify pass before this shipped:
//
//   TB_PROXY_UPSTREAM_PORT=7424  TB_PROXY_UPSTREAM_DATA_DIR=<repo>/mcp-data
//   -> upstream=127.0.0.1:7424 store=mcp-data
//   -> token=<repo>\mcp-data\mcp-token.txt   ... and it served.
//
// i.e. the PRODUCTION token fronting the BENCH brain — the same shape as the
// original misspelt-variable incident, surviving to a 401 mid-run. Failing
// safe by luck is not failing safe.
//
// When the port is one this campaign knows, the mapping is authoritative and a
// contradicting explicit dir is an operator error, not an override. Unknown
// ports (a remote host, an ad-hoc stub) keep taking the explicit dir, because
// there is nothing to contradict.
if (process.env.TB_PROXY_UPSTREAM_DATA_DIR && UPSTREAM_IS_LOOPBACK && STORE_FOR_PORT.has(UPSTREAM_PORT)) {
  const mapped = STORE_FOR_PORT.get(UPSTREAM_PORT)
  if (path.resolve(mapped) !== upstreamDataDir) {
    console.error(
      `[tb-proxy] REFUSING: TB_PROXY_UPSTREAM_DATA_DIR says the upstream ${upstreamLabel} is ` +
        `${upstreamDataDir}, but port ${UPSTREAM_PORT} serves ${mapped}.`,
    )
    console.error(
      '[tb-proxy] These disagree, so the bearer token would be taken from a store the upstream does ' +
        'not serve. Drop TB_PROXY_UPSTREAM_DATA_DIR to derive it from the port, or point the upstream ' +
        'at the store you actually named.',
    )
    process.exit(2)
  }
}

// HALF THE RECEIPT, PRINTED BEFORE ANYTHING CAN FAIL. Which brain this proxy
// will front is decided above; printing it here means even a refusal further
// down leaves a record of what was being attempted. (The token half follows
// once it resolves — never the token itself, only where it came from.)
console.log(
  `[tb-proxy] upstream=${upstreamLabel} store=${upstreamDataDir ? path.relative(REPO_ROOT, upstreamDataDir) || upstreamDataDir : 'unknown'}`,
)

/** A token path is legitimate only if it lives in the upstream's own store. */
function refuseTokenMismatch(tokenFile, why) {
  console.error(`[tb-proxy] REFUSING: ${why}`)
  console.error(`[tb-proxy]   upstream:   ${upstreamLabel}${upstreamDataDir ? ` (store ${upstreamDataDir})` : ' (store unknown)'}`)
  console.error(`[tb-proxy]   token file: ${tokenFile}`)
  console.error('[tb-proxy] A token from a different store cannot authenticate this upstream; it produces a')
  console.error('[tb-proxy] 401 at best and reads the WRONG BRAIN at worst. Measured 2026-08-19: a misspelt')
  console.error('[tb-proxy] TB_PROXY_TOKEN_FILE fell through to the production store while fronting the bench brain.')
  console.error('[tb-proxy] Bring the stack up with: node benchmark/terminal-bench-3.0/start-bench-stack.mjs')
  process.exit(2)
}

let token = process.env.TERRANSOUL_MCP_TOKEN || ''
let tokenSource = 'TERRANSOUL_MCP_TOKEN (inline)'
if (token) {
  // Even an inline token is checkable when the upstream's store is known: if
  // that store has a token file and it says something else, the inline value
  // belongs to some other brain.
  if (upstreamDataDir) {
    const storeToken = path.join(upstreamDataDir, 'mcp-token.txt')
    if (fs.existsSync(storeToken)) {
      let onDisk = ''
      try {
        onDisk = fs.readFileSync(storeToken, 'utf8').trim()
      } catch {
        onDisk = ''
      }
      if (onDisk && onDisk !== token) {
        refuseTokenMismatch(
          'TERRANSOUL_MCP_TOKEN (inline)',
          `the inline token does not match the token of the store behind ${upstreamLabel}`,
        )
      }
    }
  }
} else {
  const explicitTokenFile = process.env.TERRANSOUL_MCP_TOKEN_FILE
    ? path.resolve(process.env.TERRANSOUL_MCP_TOKEN_FILE)
    : null
  if (!explicitTokenFile && !upstreamDataDir) {
    console.error(`[tb-proxy] REFUSING: no token, and upstream ${upstreamLabel} maps to no known store.`)
    console.error('[tb-proxy] There is deliberately NO default token path here — the old one reached into the')
    console.error('[tb-proxy] PRODUCTION store regardless of which brain was upstream (measured 2026-08-19).')
    console.error('[tb-proxy] Set TB_PROXY_UPSTREAM_DATA_DIR=<the upstream brain\'s data dir>, or pass')
    console.error('[tb-proxy] TERRANSOUL_MCP_TOKEN_FILE / TERRANSOUL_MCP_TOKEN explicitly.')
    process.exit(2)
  }
  const tokenFile = explicitTokenFile || path.join(upstreamDataDir, 'mcp-token.txt')
  if (explicitTokenFile && upstreamDataDir && path.resolve(path.dirname(explicitTokenFile)) !== upstreamDataDir) {
    refuseTokenMismatch(
      explicitTokenFile,
      `TERRANSOUL_MCP_TOKEN_FILE points into a different store than the upstream ${upstreamLabel} serves`,
    )
  }
  if (
    explicitTokenFile &&
    !upstreamDataDir &&
    path.resolve(path.dirname(explicitTokenFile)) === PRODUCTION_DATA_DIR &&
    UPSTREAM_PORT !== PRODUCTION_BRAIN_PORT
  ) {
    refuseTokenMismatch(
      explicitTokenFile,
      `the production store's token was given for upstream ${upstreamLabel}, which is not the production brain`,
    )
  }
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim()
  } catch (err) {
    console.error(`[tb-proxy] cannot read MCP token from ${tokenFile}: ${err.message}`)
    process.exit(2)
  }
  tokenSource = tokenFile
}
if (!token) {
  console.error('[tb-proxy] MCP token is empty')
  process.exit(2)
}

console.log(`[tb-proxy] token=${tokenSource} listen=${LISTEN_PORT}`)

// Every tool call the container makes is recorded here. This is a HOST-SIDE
// record of whether TerranSoul was actually used, independent of grepping the
// agent's own logs — so "did the brain get used?" has a second witness that
// does not depend on harbor's log format.
const toolCalls = []
function record(entry) {
  toolCalls.push(entry)
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() })
  console.log(`[tb-proxy] ${line}`)
  if (LOG_PATH) {
    try {
      fs.appendFileSync(LOG_PATH, line + '\n')
    } catch {
      // Never let logging failure break the bench run.
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Decide whether to forward. Returns null to allow, or a JSON-RPC error object
 * to return instead. Anything we cannot parse is allowed through — the
 * upstream server is the real authority; this guard exists to stop WRITES, not
 * to second-guess the protocol.
 */
// ── TASK-IDENTITY WRITE PURITY GATE (TBENCH-WRITE-PURITY-1) ────────────────
//
// WHY THIS EXISTS. LEARN_MODE lets the agent write lessons, and with
// TB_DEFER_WRITES=0 those lessons are retrievable by LATER ATTEMPTS OF THE
// SAME TASK. That is the product's real self-improvement behaviour (owner
// decision 2026-08-06) and it is what we want to measure — but the
// Terminal-Bench leaderboard judge defines `harness_level_cheating` to include
// "prior-run post-mortems", and a positive verdict RENDERS THE SUBMISSION
// INVALID (leaderboard/src/leaderboard/ci/judge.py + its instruction.md).
//
// So the question is not "may the agent learn" but "WHAT may it carry
// forward". rules/bench-agi-purity.md already draws the line: generic
// transferable technique may persist; task-specific knowledge may not. This
// gate enforces that line AT WRITE TIME, which is the only place it can be
// enforced honestly — once a task-identifying lesson is in the store it is
// retrievable, and the brain's own PURITY-AUDIT-1 lesson records that a
// search-based purity check FAILS OPEN and silently certifies a contaminated
// store.
//
// THE ASYMMETRY IS DELIBERATE. A false positive costs one lesson and returns a
// message telling the agent to rewrite it generically — which is the behaviour
// we want anyway. A false negative costs the entire submission. So this gate
// refuses on any whole-name match rather than trying to be clever.
//
// GENERIC BY CONSTRUCTION: the term list is read from the DATASET on disk, not
// hardcoded here. No task name appears in this source file
// (rules/brain-driven-self-improvement.md: no hardcoded domain logic).
const TASKS_DIR =
  process.env.TB_TASKS_DIR ||
  (process.env.TB21_DIR ? path.join(process.env.TB21_DIR, 'tasks') : '')

function loadTaskIdentityTerms(dir) {
  if (!dir) return []
  let names = []
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    return []
  }
  // Normalise the same way the haystack is normalised so `fix_git`, `fix git`
  // and `fix-git` all collide with the directory name `fix-git`.
  return names.map(n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-')).filter(n => n.length >= 4)
}

const TASK_IDENTITY_TERMS = loadTaskIdentityTerms(TASKS_DIR)

// ── ANSWER FINGERPRINTS (TBENCH-WRITE-PURITY-2) ─────────────────────────────
//
// ⛔ PURGING THE POISONED ROW IS USELESS: THE LOOP REWRITES IT. Proven live
// 2026-09-01. Memory 26496 carried a solution recipe for one task — "the image
// sits at 0x400000 and EVERY key is off by that", "Skip disassembly entirely".
// Measured across all 34 graded trials of that task: served -> 0/15 passed;
// absent -> 14/19 (73.7%). It was deleted from the store. The very next trial
// of that task ran, failed, and the self-improve loop WROTE IT BACK as row
// 26629, tagged `load-base, 0x400000, p_vaddr, signed-vs-unsigned`.
//
// That is a self-reinforcing poison loop: the recipe makes the next attempt
// fail, and the failed attempt writes the recipe again. A pre-trial store scan
// catches it only on the FOLLOWING trial — which is exactly what happened, and
// is why the run after it was refused. The only place to break the cycle is at
// the WRITE.
//
// THE PROVENANCE ARGUMENT, identical to the task-name gate's: a constant that
// appears in NO task's own prompt cannot have been READ. It was solved for, and
// carrying it forward is a prior-run post-mortem in numeric form. The refusal
// message the task-name gate already prints even says "name no answer value" —
// that intent was never enforced.
//
// SCOPE. Only tag-shaped magic constants: a raw address as a curated keyword is
// not a topic, it is a remembered answer. Scanning prose for long hex flagged
// 33 of 2192 stored rows, nearly all benign (CSS colour tokens, a Windows error
// code), and a gate that cries wolf is one an operator learns to wave through.
const MAGIC_CONSTANT = /^0x[0-9a-fA-F]{4,}$|^[0-9a-fA-F]{8,}$/

function loadTaskPromptCorpus(dir) {
  if (!dir) return ''
  let text = ''
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const p = path.join(dir, d.name, 'instruction.md')
      try {
        text += `\n${fs.readFileSync(p, 'utf8')}`
      } catch {
        // A task without an instruction.md contributes nothing; that is fine.
      }
    }
  } catch {
    return ''
  }
  return text.toLowerCase()
}

const TASK_PROMPT_CORPUS = loadTaskPromptCorpus(TASKS_DIR)


// ⛔ AN INERT GUARD MUST BE LOUD. MEASURED 2026-08-23, self-inflicted.
//
// TASKS_DIR is read from the environment, and run-dg.sh set TB21_DIR as a PLAIN
// SHELL ASSIGNMENT rather than exporting it, so the proxy child saw neither
// TB_TASKS_DIR nor TB21_DIR. TASK_IDENTITY_TERMS was therefore an EMPTY ARRAY,
// taskIdentityHits() returned [] for every payload, and the write purity gate
// allowed everything for an entire 89-task sweep. It looked like success: the
// proxy log showed zero refusals, which reads as "the agent writes clean
// lessons" and is indistinguishable from "the check is switched off".
//
// The store-purity preflight caught the resulting row (a lesson naming a task)
// only because run-dg.sh passes it --tasks as an explicit ARGUMENT.
//
// The unit test did not catch it because the test sets TB_TASKS_DIR itself: it
// proved the function WORKS, never that the function RUNS. A guard whose
// disabled state is silent will eventually be disabled silently, so the empty
// case is now a refusal to start rather than a permissive default.
// ⛔ ALLOW_WRITES MUST NOT REACH A SUBMITTABLE RUN BY INHERITANCE.
//
// TB_PROXY_ALLOW_WRITES is read straight from the environment and NO launcher
// sets it, which means the only way it becomes '1' is by riding in from
// whatever shell started the sweep. When it does, it disables gate() entirely
// AND the task-identity purity refusal above -- so a lesson naming a benchmark
// task would be stored, and the leaderboard judge classes that as
// harness_level_cheating.
//
// run-dg.sh refuses this combination for the 2.1 path, but a guard that lives
// only in one launcher protects only that launcher. The refusal belongs where
// the setting is READ, so every caller inherits it.
if (ALLOW_WRITES && process.env.TB_SUBMITTABLE === '1') {
  console.error(
    '[tb-proxy] REFUSING: TB_PROXY_ALLOW_WRITES=1 with TB_SUBMITTABLE=1. Allowing every write ' +
      'bypasses the task-identity purity gate, so a lesson naming a benchmark task could enter ' +
      'the store mid-sweep -- which the leaderboard judge treats as harness cheating.',
  )
  console.error('[tb-proxy] Unset TB_PROXY_ALLOW_WRITES (it is almost certainly inherited from your shell).')
  process.exit(2)
}
if (ALLOW_WRITES) {
  console.error('[tb-proxy] ⚠️  TB_PROXY_ALLOW_WRITES=1 — the write purity gate is OFF. This run is NOT publishable.')
}

if (LEARN_MODE && !ALLOW_WRITES && TASK_IDENTITY_TERMS.length === 0) {
  console.error(
    '[tb-proxy] REFUSING: learn mode allows brain writes, but the task-identity purity gate ' +
      'has NO task list, so it would allow every lesson through while reporting zero refusals.',
  )
  console.error(`[tb-proxy] TB_TASKS_DIR=${JSON.stringify(process.env.TB_TASKS_DIR || '')} ` +
    `TB21_DIR=${JSON.stringify(process.env.TB21_DIR || '')} -> resolved ${JSON.stringify(TASKS_DIR)}`)
  console.error('[tb-proxy] Set TB_TASKS_DIR to the dataset tasks directory (and EXPORT it).')
  process.exit(2)
}

function normaliseForIdentity(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** Every task name appearing anywhere in a lesson's writable fields. */
/**
 * Magic constants offered as TAGS that appear in no task's own prompt.
 *
 * Deliberately reads only tag-shaped fields rather than walking every string:
 * the whole payload is prose, and prose legitimately quotes numbers it was
 * shown. A curated keyword is a different claim — it says "this value is what
 * this lesson is ABOUT" — and that is the shape measured to poison a task.
 * See TBENCH-WRITE-PURITY-2 above.
 */
function answerFingerprintHits(args) {
  if (!args) return []
  const tagFields = []
  const collect = (node, depth) => {
    if (!node || depth > 8 || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const v of node) collect(v, depth + 1)
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (/^tags?$/i.test(k)) {
        if (typeof v === 'string') tagFields.push(...v.split(','))
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') tagFields.push(x)
      } else {
        collect(v, depth + 1)
      }
    }
  }
  collect(args, 0)
  const hits = new Set()
  for (const raw of tagFields) {
    const tag = String(raw).trim()
    if (!MAGIC_CONSTANT.test(tag)) continue
    // Provenance: a value the prompt itself states could legitimately be READ.
    if (TASK_PROMPT_CORPUS && TASK_PROMPT_CORPUS.includes(tag.toLowerCase())) continue
    hits.add(tag)
  }
  return [...hits]
}

function taskIdentityHits(args) {
  if (!args || !TASK_IDENTITY_TERMS.length) return []
  // ⛔ SCAN EVERY STRING, NEVER A LIST OF FIELD NAMES. MEASURED 2026-08-23.
  //
  // This used to read a hardcoded allowlist -- content, tags, title, summary,
  // category. `brain_append` carries its prose in `addition`, so NOTHING
  // matched, `parts` came back empty, and the gate returned [] -- allowed. The
  // agent instruction file explicitly tells the agent to PREFER brain_append
  // for corrections ("append to that entry instead of writing a near-duplicate")
  // and the campaign logs show it used more than a thousand times, so the gate
  // was blind on the busier half of the write surface while reporting zero
  // refusals -- indistinguishable, again, from working.
  //
  // A field-name allowlist cannot be made safe by adding `addition` to it: it is
  // blind to every field it does not already know, and the next tool with a new
  // argument name reopens the hole silently. So the shape of the check changes:
  // walk the whole payload and match against EVERY string in it. There is no
  // field name to get wrong, and a new tool is covered the day it is added.
  //
  // Numeric ids and booleans are stringified harmlessly -- a task name cannot
  // hide in `42` -- so nothing needs to be excluded, and excluding by name is
  // the very mistake being corrected.
  const parts = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 8) return
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (typeof node === 'number' || typeof node === 'boolean') return
    if (typeof node !== 'object') return
    if (seen.has(node)) return // cycles: a payload is JSON, but never assume
    seen.add(node)
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1)
      return
    }
    for (const v of Object.values(node)) walk(v, depth + 1)
  }
  walk(args, 0)
  if (!parts.length) return []
  const hay = normaliseForIdentity(parts.join(' '))
  const hits = new Set()
  for (const t of TASK_IDENTITY_TERMS) if (hay.includes(t)) hits.add(t)
  return [...hits]
}

function gate(bodyBuf, meta) {
  if (ALLOW_WRITES) return null
  let req
  try {
    req = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return null
  }
  if (!req || req.method !== 'tools/call') return null
  const name = req.params?.name
  if (typeof name !== 'string') return null
  if (READ_ONLY_TOOLS.has(name)) return null
  // Do NOT record here. Allowed calls are recorded exactly once, in noteCall.
  // An earlier version recorded in gate(), noteCall() AND the rewrite pass,
  // so a SINGLE brain_ingest_lesson produced three log lines and the usage
  // check reported "3 tool calls served" for one call — inflated evidence of
  // exactly the thing that check exists to measure honestly.
  // The exit gate and the dead-end detector are allowed whenever writes are
  // allowed at all. See TBENCH-EXIT-GATE-1: refusing these is what left the
  // agent with no pre-stop check.
  if (LEARN_MODE && VERIFY_TOOLS.has(name)) return null
  if (LEARN_MODE && LEARN_TOOLS.has(name)) {
    // Learning is allowed; carrying TASK IDENTITY forward is not. See
    // TBENCH-WRITE-PURITY-1 above.
    // Answer fingerprints first: a numeric answer is the shape that was
    // measured to poison a task, and the loop rewrites it the moment the
    // resident row is purged (TBENCH-WRITE-PURITY-2).
    const fingerprints = answerFingerprintHits(req.params?.arguments)
    if (fingerprints.length) {
      record({ tool: name, allowed: false, reason: 'answer-fingerprint' })
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32002,
          message:
            `bench proxy: this lesson tags the constant(s) ${fingerprints.join(', ')}, which appear ` +
            'in NO task prompt, so it was NOT stored. A value absent from every prompt cannot have ' +
            'been read — it was solved for, and carrying it into a later attempt is a prior-run ' +
            'post-mortem in numeric form. It is also measurably harmful: one such lesson correlated ' +
            'with 0 of 15 passes on its own task against 14 of 19 without it. Rewrite it as a ' +
            'TRANSFERABLE TECHNIQUE — say what to LOOK UP and how to derive the value, never the ' +
            'value itself — and call the tool again.',
        },
      }
    }

    const hits = taskIdentityHits(req.params?.arguments)
    if (hits.length) {
      record({ tool: name, allowed: false, reason: 'task-identity' })
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32002,
          message:
            `bench proxy: this lesson names the benchmark task(s) ${hits.join(', ')}, so it was ` +
            'NOT stored. A lesson that needs the task name to make sense is task-specific ' +
            'knowledge, and carrying it into a later attempt is what the leaderboard judge ' +
            'classes as a prior-run post-mortem. Rewrite it as a TRANSFERABLE TECHNIQUE: ' +
            'state the symptom, the cause and the general rule so it would read identically ' +
            'for a task about a different subject, and name no task, no task-unique path and ' +
            'no answer value. Then call the tool again.',
        },
      }
    }
    return null
  }
  // The refusal text used to assert every blocked tool "is a write/mutating
  // tool". Measured 2026-08-04: the server advertises 47 tools and this
  // allowlist refuses 43 of them, of which 21 (code_*, repo_*, obs_*,
  // canvas_snapshot, cross_source_search) are classified SafeRead by
  // action_trust.rs — so the message was simply false, and an agent that
  // believed it would draw the wrong conclusion about what the brain is.
  //
  // They stay BLOCKED, deliberately and for a different reason than writes:
  // those tools read the HOST's filesystem and code index. A Terminal-Bench
  // container runs untrusted benchmark code and is solving a coding task —
  // handing it a search tool over TerranSoul's own repository is both a host
  // exposure and a contamination path (rules/bench-agi-purity.md). Only the
  // reason changes here, not the policy.
  const kind = HOST_SCOPED_PREFIXES.some(p => name.startsWith(p))
    ? 'reads the host filesystem/code index'
    : 'is a write/mutating tool'
  {
    // A refusal is a request too: without the caller identity on this line,
    // "which trial kept trying to write" is unanswerable after the fact.
    const entry = { tool: name, allowed: false, reason: 'blocked' }
    applyRequestMeta(entry, req, meta)
    record(entry)
  }
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    error: {
      code: -32001,
      message:
        `bench proxy: '${name}' ${kind}, so it is blocked during a Terminal-Bench ` +
        'run (TB-3 requires 0 brain writes; host-scoped tools are out of scope for a ' +
        'containerised task). The brain tools available to you are: ' +
        `${EXPOSED_BRAIN_TOOLS.filter(t => READ_ONLY_TOOLS.has(t) || (LEARN_MODE && LEARN_TOOLS.has(t))).join(', ')}.`,
    },
  }
}

/**
 * In learn mode, force every ingested lesson to category `self-improve-attempt`.
 *
 * WHY — this is the product's OWN purity control, not a workaround.
 * gateway.rs::ingest_lesson does:
 *
 *     let sync_to_shared_seed = req.category != "self-improve-attempt";
 *
 * i.e. lessons in that category are written to the runtime store but
 * deliberately NOT appended to the committed mcp-data/shared/seed-lessons.sql.
 * Its comment cites the 2026-07-12 incident where 8 Boeing geometry lessons
 * leaked into the shared seed and were worth roughly +3 bench points to every
 * later run — precisely the answer-derived head-start rules/bench-agi-purity.md
 * forbids.
 *
 * MEASURED HERE 2026-08-04: a learn-mode smoke using category "lesson" landed
 * in the ISOLATED store (memory_id 1123, not production's ~25908 range) but
 * ALSO appended 20 lines to the repo's production seed-lessons.sql. Pointing
 * TERRANSOUL_MCP_DATA_DIR at a bench store isolates the DATABASE but not the
 * seed-persistence path. Isolating the store is therefore NOT sufficient; the
 * category is the control that actually works.
 *
 * Enforced here rather than trusted to the instruction, because a benchmark
 * agent choosing its own category is one wrong string away from contaminating
 * the shipped seed.
 */
/**
 * ...and, in the same pass, PIN THE THINKING MODE.
 *
 * OWNER INSTRUCTION 2026-08-04: "thinking is max". `brain_search` exposes a
 * `thinking_mode` dial — chat | think | research | max — and it DEFAULTS TO
 * CHAT (tools.rs:53). extra-instruction.md described the ladder and left
 * escalation to the agent's judgement, so every sweep so far measured
 * TerranSoul at its cheapest rung while carrying its name. The four rungs are
 * cumulative, not stylistic: chat = plain recall; think = + the reason-then-rank
 * judge; research = + iterative sub-queries, completeness critic and KG-edge
 * expansion; max = research's deep recall + claim-level verification and
 * ranking. Running chat therefore does not merely make the bench faster — it
 * removes the reranker, the graph expansion and the verifier from the
 * measurement entirely.
 *
 * Enforced here, not requested in the prompt, for the same reason the category
 * rewrite above is: an instruction the agent may decline is not a
 * configuration. `TB_THINKING_MODE=off` restores agent discretion; any of the
 * four rung names pins that rung instead.
 *
 * Applied ONLY to tools whose schema actually declares the argument —
 * verified against tools.rs, where `brain_search` has it and
 * `brain_suggest_context` / `brain_kg_neighbors` / `brain_get_entry` do not.
 * Sending it to a tool that does not accept it would be a silent no-op that
 * reads, in the log, exactly like a mode that took effect.
 */
// DEFAULT IS `think`, NOT `max` — owner decision 2026-08-05, revising the
// 2026-08-04 "thinking is max" instruction on measurement rather than taste.
// `max` costs ~374 s per brain_search against the local 12B versus ~1 s at
// `think` (independently confirmed over this campaign: 104 real calls at think
// measured p50 0.95 s, p90 2.20 s, max 5.46 s). On a wall-clock-bounded
// benchmark that is not a latency cost, it is a CORRECTNESS cost — a
// Terminal-Bench task that runs out of time scores 0 no matter how good its
// retrieval was, and this campaign lost 6 tasks to AgentTimeoutError already.
// The owner's words: "we changed to think mode now because of timeout and
// uncertainty of completion."
//
// This default previously read `max` while run-sweep.sh exported `think`, so
// the sweep was correct and anyone invoking run-dg.sh DIRECTLY silently got
// max. Two layers disagreeing about the same setting is how a `think` run gets
// published as a `max` one; they now agree.
const THINKING_MODE = (process.env.TB_THINKING_MODE || 'think').toLowerCase()
const THINKING_MODE_TOOLS = new Set(['brain_search'])
const VALID_THINKING_MODES = new Set(['chat', 'think', 'research', 'max'])

function rewriteOutbound(bodyBuf) {
  let req
  try {
    req = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return bodyBuf
  }
  if (req?.method !== 'tools/call') return bodyBuf

  const name = req.params?.name
  let changed = false
  // Force the verification scope. Overwrites whatever the agent supplied --
  // including "default", which is exactly the value that collided.
  if (SCOPED_TOOLS.has(req.params?.name) && req.params?.arguments) {
    if (req.params.arguments.session_id !== TRIAL_SCOPE) {
      req.params.arguments.session_id = TRIAL_SCOPE
      // MUST set `changed`, or rewriteOutbound returns the ORIGINAL buffer and
      // this mutation is discarded -- the fix would look applied and do nothing.
      changed = true
    }
  }

  // REPAIR TOOL-CALL MARKUP THAT LEAKED INTO THE LESSON BODY.
  //
  // Measured over the 62 lessons this sweep wrote: 21 (34%) arrived with the
  // agent's own tool-call syntax appended to `content` --
  //     "...bit-identical in render output (cmp on the .tga).</content>
  //      <parameter name="tags">pov-ray,build,...</parameter>"
  // and the tag loss is ENTIRELY explained by it: 13 calls had markup AND lost
  // their tags, 8 had markup alone, and ZERO lost tags without markup.
  //
  // The corruption is upstream of the brain -- the tool_use input is already
  // malformed -- so the brain stored it faithfully and no brain-side change can
  // prevent it. But it is RECOVERABLE, because the real body is intact up to the
  // first marker and the stranded arguments are still parseable out of the tail.
  //
  // It is not cosmetic. An untagged lesson is much harder to retrieve: the
  // untagged `pkill` lesson was rediscovered from scratch by the very next task
  // 35 minutes later, which wrote a DUPLICATE instead of appending to it. That is
  // the self-improvement loop losing to a string-handling bug.
  // brain_ingest_lesson calls its prose `content`; brain_append calls it
  // `addition`. This repair only ever looked at `content`, so for every
  // brain_append it was dead code and leaked tool-call markup was stored
  // verbatim -- the same field-name assumption as the purity gate above.
  const _proseField = typeof req.params?.arguments?.content === 'string'
    ? 'content'
    : typeof req.params?.arguments?.addition === 'string'
      ? 'addition'
      : null
  if (LESSON_TOOLS.has(name) && _proseField) {
    const raw = req.params.arguments[_proseField]
    const cut = raw.search(/<\/content>|<parameter\s+name=|<\/invoke>/)
    if (cut > 0) {
      const tail = raw.slice(cut)
      req.params.arguments[_proseField] = raw.slice(0, cut).trimEnd()
      // Recover arguments the markup swallowed, without overwriting anything the
      // agent set correctly.
      // The tail is UNTERMINATED in practice — measured on ids 1192/1193:
      //   </content>\n<parameter name="tags">pytorch,pth,checkpoint,zipfile,...
      // with no closing </parameter>, because the agent's emission was cut off
      // mid-tool-call. An earlier version required a trailing '<' to close the
      // capture, so it matched nothing and the tags stayed lost: the body was
      // cleaned while the tags — the thing that makes a lesson findable — were
      // still dropped. Anchor on the marker only, and stop at a newline or the
      // next tag if one happens to be there.
      // TWO DIALECTS, both observed in this sweep's own trajectories. Fixing
      // against one sample at a time is why this took three passes:
      //   ids 1192/1193 : </content>\n<parameter name="tags">a,b,c        (unterminated)
      //   ids 1204/1205 : </content>\n<tags>a,b,c</tags>\n<importance>8</importance>\n</invoke>
      // The second form has no `name=` attribute at all, so a regex written for
      // the first matches nothing — the body got cleaned while the tags, the
      // whole point of the repair, were still dropped.
      const tags = tail.match(/<tags>\s*([^<]*)<\/tags>/) ||
                   tail.match(/name="tags">\s*([^<\n]*)/)
      if (tags && tags[1].trim() && !req.params.arguments.tags) {
        req.params.arguments.tags = tags[1].trim()
      }
      const imp = tail.match(/<importance>\s*(\d+)\s*<\/importance>/) ||
                  tail.match(/name="importance">\s*(\d+)/)
      if (imp && req.params.arguments.importance == null) {
        req.params.arguments.importance = Number(imp[1])
      }
      lastRepairedMarkup = { cutAt: cut, recoveredTags: !!tags, recoveredImportance: !!imp }
      changed = true
    }
  }

  if (LEARN_MODE && name === 'brain_ingest_lesson') {
    req.params.arguments = req.params.arguments || {}
    const was = req.params.arguments.category
    if (was !== 'self-improve-attempt') {
      req.params.arguments.category = 'self-improve-attempt'
      // Reported through noteCall's single record, not a second line of its own.
      lastRewrittenFrom = was ?? null
      changed = true
    }
  }

  if (VALID_THINKING_MODES.has(THINKING_MODE) && THINKING_MODE_TOOLS.has(name)) {
    req.params.arguments = req.params.arguments || {}
    // Record the rung on EVERY pinned call, not only when a rewrite happened.
    // Keying the record on "did we change something" meant that an agent which
    // already sent the pinned rung produced no record at all, and witness 5
    // then reported "ran at the server default (chat)" — the witness failing
    // precisely when the agent complied. What is being witnessed is the rung on
    // the wire, which is pinned either way.
    lastThinkingModeFrom = req.params.arguments.thinking_mode ?? null
    if (req.params.arguments.thinking_mode !== THINKING_MODE) {
      req.params.arguments.thinking_mode = THINKING_MODE
      changed = true
    }
  }

  return changed ? Buffer.from(JSON.stringify(req), 'utf8') : bodyBuf
}

// Set by rewriteOutbound, consumed by the next noteCall. Single-threaded
// request handling makes this safe; it exists so one call yields one log line.
let lastRewrittenFrom
let lastThinkingModeFrom
let lastRepairedMarkup

/**
 * The BRAIN's verdict on a call the proxy forwarded — not the proxy's own.
 *
 * WHY (rules/tbench-playbook.md, "Second thing to fix before any sweep"):
 * every witness this proxy produced was an ATTEMPT counter. `noteCall` records
 * `allowed:true` before the request is even written upstream, so a run in which
 * the brain refused every single write still reported "N tool call(s) served".
 * That is the same family as the three instrumentation inflations already fixed
 * on 2026-08-04, and it was live: with `safe_write` trust at 0.50 vs a 0.60
 * threshold (TRUST-BOOTSTRAP-1), every learn-mode write came back
 * `isError:true` and nothing counted it.
 *
 * An MCP error arrives as HTTP 200 with `result.isError:true` (router.rs:190-196),
 * so the status code is no help — the body has to be read. The response is teed,
 * never buffered-then-forwarded, so SSE streaming is unaffected.
 *
 * Uses the key `name`, deliberately NOT `tool`: `"tool":` is the call counter
 * the usage check greps, and one call must still produce exactly one of those.
 */
// MEASURED 2026-08-05: a real `brain_search` response is 17,773 bytes and its
// `"isError"` marker sits at byte 17,738 — i.e. MCP puts the flag we key on at
// the very END of the body. The original 16 KB cap truncated exactly that,
// every large search failed to parse, and the call was logged "unreadable".
// On a task whose only call was one such search, witness 3 then reported
// "THE BRAIN ACCEPTED NOTHING" for a perfectly healthy call — a false alarm
// from the instrument itself, which is the badge-cascade shape
// rules/mcp-response-audit.md exists to catch. 1 MB comfortably clears a
// limit=20 response; the copy is per-request and short-lived.
const OUTCOME_CAP_BYTES = 1_048_576

function parseRpcPayload(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  // Streamable HTTP / SSE: "event: message\ndata: {...}"
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      return JSON.parse(line.slice(5).trim())
    } catch {
      // keep scanning — a partial frame is not a parse failure of the whole
    }
  }
  return null
}

// ── WHAT A CALL ASKED FOR, AND WHAT CAME BACK (TBENCH-OBS-1, 2026-08-19) ─────
//
// This log recorded a tool NAME and a verdict, and nothing about the content of
// either side. Measured cost of that gap: a whole campaign's log could show ~17
// agent-initiated `brain_search` calls against 222 hook-fired
// `brain_verify_completion` calls and STILL not answer the question the
// campaign turned on — did those searches return anything? An empty search and
// a search that came back with six relevant hits were the same line, so "the
// agent stopped consulting memory" and "the agent consulted memory and the
// store had nothing for it" were indistinguishable in the artifact, and both
// explanations survived the whole campaign unfalsified. Answering it afterwards
// required re-running a bench, which is exactly what an artifact exists to
// avoid.
//
// So the verdict line now carries WHAT WAS ASKED (bounded) alongside HOW MUCH
// came back and HOW MANY rows. `[]` — an empty search — is `results: 0` here
// instead of being invisible.
//
// POLICY, deliberately narrowed from noteCall's older "only these two
// identifiers, never argument content": the agent's own QUERY text is logged,
// truncated, and response SIZE and COUNT are logged. Lesson/append `content`
// bodies and response PAYLOAD TEXT are still never logged. The query is what
// the agent chose to ask rather than anything the environment handed it, it is
// capped at QUERY_LOG_CHARS so a pasted stack trace or file excerpt cannot be
// captured wholesale, and this log is host-side, gitignored and never read back
// into a run — so recording it creates no path back into the trial that
// produced it.
const QUERY_LOG_CHARS = 200

/** Bounded description of what a tools/call asked for. Never throws. */
function describeRequestArgs(args) {
  const out = {}
  try {
    if (!args || typeof args !== 'object') return out
    if (typeof args.query === 'string') {
      out.query = args.query.slice(0, QUERY_LOG_CHARS)
      // Recorded so truncation is VISIBLE rather than silent: a 200-char slice
      // of a 4 KB query reads exactly like a 200-char query without it.
      out.queryChars = args.query.length
    }
    if (typeof args.limit === 'number' && Number.isFinite(args.limit)) out.limit = args.limit
    // `searchMode`, NOT `mode`: `mode` is already this log's key for
    // 'learn-write' / 'deferred', and silently overloading it would break every
    // existing reader of those lines.
    if (typeof args.mode === 'string') out.searchMode = args.mode.slice(0, 32)
  } catch {
    // An enrichment failure degrades the record, never the request.
  }
  return out
}

/**
 * How much the brain actually returned, and how many rows.
 *
 * Exact for this server: every `brain_search` rung serialises
 * `serde_json::to_string(&hits)` — a top-level JSON array — into
 * `result.content[0].text`, so `JSON.parse(text).length` IS the hit count and
 * an empty search is the literal two-character `[]`. `code_query` answers with
 * `{results:[...]}`, which costs one more line to handle. Anything else still
 * gets a size. Sizes and counts only — never the payload text, which is brain
 * content and can carry campaign material to a human reader.
 */
function describeResponsePayload(rpc) {
  const out = {}
  try {
    const text = rpc?.result?.content?.[0]?.text
    if (typeof text !== 'string') return out
    out.payloadChars = text.length
    try {
      const payload = JSON.parse(text)
      if (Array.isArray(payload)) out.results = payload.length
      else if (Array.isArray(payload?.results)) out.results = payload.results.length
    } catch {
      // Not every tool answers with JSON; a prose payload still has a size.
    }
  } catch {
    // As above: logging must never be able to fail a served request.
  }
  return out
}

// ── WHICH CALLER MADE THIS CALL ─────────────────────────────────────────────
//
// There is no transport session id to lean on, and pretending otherwise is how
// the last attribution mistake happened. The MCP router never issues an
// `Mcp-Session-Id` (router.rs::handle_request reads headers only for auth), so
// a conformant client never echoes one back.
//
// The `session_id` that DOES appear on some records is a TOOL ARGUMENT, not a
// transport identity. COUNTED 2026-08-19 against
// src-tauri/src/ai_integrations/mcp/tools.rs: NINE tool schemas declare a
// `session_id` property — brain_observe_outcome, brain_verify_completion,
// brain_assess_confidence, brain_export_trajectory, brain_control,
// brain_model_other, brain_remember_to, brain_govern_memory and
// brain_commitments. (An earlier revision of this comment said "only two". That
// was wrong, and it was wrong in the direction that makes the argument look
// stronger than it is, which is the failure mode this file keeps re-learning.)
// The count does not rescue attribution anyway: `brain_search` — the call this
// campaign is about — declares no `session_id`, and only two of those nine are
// even on the wire (EXPOSED_BRAIN_TOOLS above). Every trial also shares one
// proxy URL and one log file, so there is no file or URL boundary either.
//
// SO WHAT IS `conn`, HONESTLY. It is the TCP connection ordinal — the only
// correlator this process owns without the caller's cooperation — and what it
// buys is an ASSUMPTION, not a fact:
//
//   PROVEN, by construction: two containers cannot share one TCP connection to
//   this proxy, so a `conn` value NEVER merges two callers. Whatever it groups
//   really did come from one client socket.
//
//   ASSUMED, and NOT verified here: that one MCP client keeps ONE connection
//   alive across `initialize` and every later `tools/call`. Nothing in this
//   process enforces that. Node's `fetch`/undici pools connections and may open
//   several to the same origin; any client may close and reopen; a keep-alive
//   idle timeout mid-task reopens one. If that happens, `conn` SPLITS one
//   caller across several ordinals, and a later call carries a `conn` that
//   never saw the `initialize` line its `client` name is on.
//
// So `conn` alone CANNOT answer "was this call the agent's or the hook's" —
// it can only ever say "these calls shared a socket". `peer` is recorded
// beside it because whether Docker NAT preserves a per-container source address
// here is likewise unverified, and one real run settles it.
//
// The deterministic answer is `caller`, below: the Stop hook DECLARES itself in
// an HTTP header instead of leaving the proxy to infer it. See CALLER_HEADER.
//
// Request and verdict lines for the same call join on (`conn`, `rpcId`).
const connIds = new WeakMap()
let connSeq = 0

// ── THE CALLER DECLARES ITSELF (TBENCH-OBS-2, 2026-08-19) ───────────────────
//
// THE GAP THIS CLOSES. The campaign's headline finding — the PUSHED mechanism
// outfired the PULLED one by more than 13x (222 hook-fired
// `brain_verify_completion` calls against ~17 agent-initiated searches) — was
// read off the TOOL NAME, and that only works while the two callers happen to
// use disjoint tools. The moment the hook calls `brain_search`, or the agent
// calls `brain_verify_completion`, the number becomes unreadable. Everything
// above (`conn`, `client` on `initialize`) narrows that by INFERENCE and, as
// the block above now says plainly, rests on an unverified assumption about
// connection reuse. An assumption is not a measurement.
//
// So the caller says who it is. `packages/terransoul-cli/src/mcp.mjs` sends
// this header when constructed with a `caller`, and
// `bin/terransoul.mjs`'s `stop-hook` subcommand constructs it with
// `caller: 'stop-hook'`. Claude Code's own MCP client knows nothing about this
// header and sends none, which is the point: the ABSENCE of the header is
// itself the agent's signature, and it is recorded explicitly as 'unknown'
// rather than as a missing key.
//
// STRICTLY ADDITIVE AND FAIL-OPEN. Nothing branches on this value — it is not
// forwarded upstream, not gated on, not compared. A missing, empty, duplicated
// or hostile header changes no byte on the wire and no verdict; the worst case
// is a log field reading 'unknown'.
const CALLER_HEADER = 'x-terransoul-caller'
// Recorded verbatim, bounded only so a runaway or hostile header cannot bloat
// every line of a bench-long log. Every value this repo sends is one short
// token, far under the bound, so "verbatim" is literal in practice.
const CALLER_LOG_CHARS = 64
const CALLER_UNKNOWN = 'unknown'

/** Per-request identifiers, from the connection rather than the payload. */
function requestMeta(clientReq) {
  const meta = {}
  try {
    const socket = clientReq?.socket
    if (socket && connIds.has(socket)) meta.conn = connIds.get(socket)
    if (socket && typeof socket.remoteAddress === 'string') meta.peer = socket.remoteAddress
    // Absent on this server today (see above), recorded when a client does send
    // one so a future transport that DOES carry a session needs no code change.
    const header = clientReq?.headers?.['mcp-session-id']
    if (typeof header === 'string' && header) meta.mcpSessionId = header.slice(0, 64)
    // Node lowercases incoming header names and joins repeats of a non-special
    // header with ', ', so this is a string or undefined — never an array.
    const declared = clientReq?.headers?.[CALLER_HEADER]
    if (typeof declared === 'string' && declared) meta.caller = declared.slice(0, CALLER_LOG_CHARS)
  } catch {
    // Never let identification failure stop a call being recorded at all.
  }
  return meta
}

/** Stamp caller identity onto a record in place. Never throws. */
function applyRequestMeta(entry, req, meta) {
  try {
    const id = req?.id
    if (typeof id === 'string' || typeof id === 'number') entry.rpcId = id
    // ALWAYS written, and explicit when the header is absent. A record with no
    // `caller` key at all would be indistinguishable from a record written by a
    // proxy predating this field — "the agent made this call" and "this log is
    // too old to say" must not look the same, because that ambiguity is exactly
    // what made the last campaign's numbers unfalsifiable.
    entry.caller =
      meta && typeof meta.caller === 'string' && meta.caller ? meta.caller : CALLER_UNKNOWN
    if (!meta) return
    if (typeof meta.conn === 'number') entry.conn = meta.conn
    if (typeof meta.peer === 'string' && meta.peer) entry.peer = meta.peer
    if (typeof meta.mcpSessionId === 'string' && meta.mcpSessionId) entry.mcpSessionId = meta.mcpSessionId
  } catch {
    // An enrichment failure must degrade to the OLD record shape, never to no
    // record: the call counter this log exists to keep honest is on that line.
  }
}

/** Classify one forwarded tools/call by what the brain actually answered. */
function noteOutcome(reqBuf, responseText, meta) {
  let name
  let base = {}
  try {
    const req = JSON.parse(reqBuf.toString('utf8'))
    if (req?.method !== 'tools/call') return
    name = req.params?.name
    base = describeRequestArgs(req.params?.arguments)
    applyRequestMeta(base, req, meta)
  } catch {
    return
  }
  if (typeof name !== 'string') return
  // `name` first so the verdict line still reads the same way; `base` carries
  // only NEW keys, so nothing existing can be shadowed by it.
  base = { name, ...base }
  base.envelopeChars = responseText.length
  // The tee stops copying at OUTCOME_CAP_BYTES, so say when a size is a floor
  // rather than a measurement.
  if (meta?.capped) base.capped = true

  const rpc = parseRpcPayload(responseText)
  if (!rpc) {
    // Belt-and-braces for the truncation case above: a body we cannot parse is
    // still readable enough to answer the only question that matters. The
    // error markers are literal strings, so look for them directly rather than
    // defaulting to "unreadable" — which reads as a failure and is what raised
    // a false alarm on a healthy call.
    if (responseText.includes('"isError":true')) {
      const gated = responseText.includes('action gated by earned autonomy')
      record({ ...base, verdict: gated ? 'gate-denied' : 'refused', detail: 'detected in an unparseable body' })
    } else if (responseText.includes('"result"')) {
      record({ ...base, verdict: 'accepted', truncated: true })
    } else {
      record({ ...base, verdict: 'unparseable', detail: responseText.slice(0, 120) })
    }
    return
  }
  if (rpc.error) {
    record({ ...base, verdict: 'refused', detail: String(rpc.error.message ?? '').slice(0, 160) })
    return
  }
  if (rpc.result?.isError) {
    const detail = String(rpc.result?.content?.[0]?.text ?? '').slice(0, 160)
    // The earned-autonomy gate has a stable prefix (action_trust.rs::
    // GATE_DENY_PREFIX). Calling it out by name is the difference between
    // "the brain said no" and "the brain said no BECAUSE it does not trust
    // this agent yet", which is the one a sweep must never ignore.
    const gated = detail.startsWith('action gated by earned autonomy')
    record({ ...base, verdict: gated ? 'gate-denied' : 'refused', detail })
    return
  }
  record({ ...base, verdict: 'accepted', ...describeResponsePayload(rpc) })
}

function noteCall(bodyBuf, meta) {
  try {
    const req = JSON.parse(bodyBuf.toString('utf8'))
    if (req?.method === 'tools/call' && typeof req.params?.name === 'string') {
      const entry = { tool: req.params.name, allowed: true }
      // ATTRIBUTION FIELDS — added 2026-08-19, and this cost a real
      // misdiagnosis to learn.
      //
      // This log used to record only `tool` and `at`. For a multi-trial run
      // that is not enough to say WHICH trial made a call or WHAT it asked
      // for: `brain_verify_completion` is one tool name covering four very
      // different ops (`mark_edited`, `record`, `status`, `verify`), and the
      // first three are cheap ledger writes while `verify` is an LLM judge
      // call. With only the tool name on the wire, attributing 19 calls to 6
      // overlapping trials required inferring from wall-clock windows and
      // response LATENCY (>200 ms => must have been the judge).
      //
      // That inference was doable but nobody did it in time: the campaign
      // recorded, in four separate places, that the judge had run and returned
      // a wrong verdict on two trials where it had in fact never been called
      // at all — and one of those places told the next engineer not to
      // re-examine it. See TBENCH-BYPASS-PROVENANCE-RETRACTION-1.
      //
      // `op` and `session_id` are both already present in the arguments the
      // caller sends; they were simply being dropped on the floor. Logging
      // them makes trial attribution and op-level accounting exact instead of
      // inferred.
      //
      // POLICY NOTE, updated 2026-08-19 (TBENCH-OBS-1): this comment used to
      // read "Never log argument CONTENT here". That rule has been narrowed,
      // not abandoned, and it is enforced one function down rather than here —
      // see describeRequestArgs: the agent's own `query` is recorded on the
      // VERDICT line, truncated, because a log that cannot say what was asked
      // cannot say whether the answer was any good. Lesson/append `content`
      // bodies and response payload TEXT are still never logged, anywhere.
      const args = req.params.arguments
      if (args && typeof args === 'object') {
        if (typeof args.op === 'string') entry.op = args.op
        if (typeof args.session_id === 'string') entry.session_id = args.session_id
      }
      if (LEARN_MODE && LEARN_TOOLS.has(req.params.name)) entry.mode = 'learn-write'
      if (lastRewrittenFrom !== undefined) {
        entry.categoryRewrittenFrom = lastRewrittenFrom
        lastRewrittenFrom = undefined
      }
      if (lastRepairedMarkup !== undefined) {
        entry.repairedMarkup = lastRepairedMarkup
        lastRepairedMarkup = undefined
      }
      if (lastThinkingModeFrom !== undefined) {
        entry.thinkingMode = THINKING_MODE
        entry.thinkingModeWas = lastThinkingModeFrom
        lastThinkingModeFrom = undefined
      }
      applyRequestMeta(entry, req, meta)
      record(entry)
    } else if (req?.method) {
      const entry = { method: req.method, allowed: true }
      applyRequestMeta(entry, req, meta)
      // CORROBORATION for the caller identity, not the source of it.
      // `initialize` already carries `clientInfo.name` and it was simply being
      // dropped; Claude Code's MCP client and the CLI Stop hook are separate
      // processes with separate clientInfo, so recording it is free evidence.
      //
      // But read it for what it is: this line attributes only the `initialize`
      // ITSELF. Extending it to the later calls on the same socket requires the
      // connection-reuse assumption spelled out at `connIds` — which is why
      // `caller` (declared per-request, on every line) is the field to trust
      // when the two disagree, and why this one stays as the cross-check that
      // can expose such a disagreement.
      if (req.method === 'initialize') {
        try {
          const info = req.params?.clientInfo
          if (info && typeof info === 'object') {
            if (typeof info.name === 'string') entry.client = info.name.slice(0, 80)
            if (typeof info.version === 'string') entry.clientVersion = info.version.slice(0, 40)
          }
        } catch {
          // Degrade to the old {method, allowed} line rather than losing it.
        }
      }
      record(entry)
    }
  } catch {
    // Non-JSON body — forwarded verbatim, nothing to record.
  }
}

const server = http.createServer(async (clientReq, clientRes) => {
  // Explicit flush endpoint. Signals are NOT usable for this: on Windows,
  // `kill -TERM` from Git Bash hard-terminates node without running the
  // SIGTERM handler, and the first version of this proxy silently DROPPED
  // every deferred lesson as a result (caught by deferred-writes.test.sh —
  // "lesson lost"). run-dg.sh calls this before stopping the proxy, so the
  // flush is an ordinary request whose completion we can actually observe.
  if (clientReq.url && clientReq.url.startsWith('/__flush')) {
    const t = await flushDeferred()
    // `flushed` stays the ACCEPTED count, not the sent count: it is the number
    // a human reads as "lessons that landed", and reporting sends there is the
    // inflation this file exists to stop.
    const payload = Buffer.from(
      JSON.stringify({ flushed: t.accepted, sent: t.sent, refused: t.refused }),
      'utf8',
    )
    clientRes.writeHead(200, {
      'content-type': 'application/json',
      'content-length': payload.length,
    })
    clientRes.end(payload)
    console.log(
      `[tb-proxy] flushed ${t.accepted}/${t.sent} deferred lesson(s) on request` +
        (t.refused ? `, ${t.refused} REFUSED by the brain` : ''),
    )
    return
  }

  // Caller identity, taken from the connection before the body is read so that
  // even a torn request is attributable. Logging-only: nothing below branches
  // on it.
  const meta = requestMeta(clientReq)

  let bodyBuf = Buffer.alloc(0)
  try {
    bodyBuf = await readBody(clientReq)
  } catch {
    clientRes.writeHead(400).end('bad request body')
    return
  }

  const blocked = gate(bodyBuf, meta)
  if (blocked) {
    const payload = Buffer.from(JSON.stringify(blocked), 'utf8')
    clientRes.writeHead(200, {
      'content-type': 'application/json',
      'content-length': payload.length,
    })
    clientRes.end(payload)
    return
  }

  // Rewrite BEFORE recording: the single log line reports what was actually
  // forwarded, including any category rewrite.
  bodyBuf = rewriteOutbound(bodyBuf)
  // Deferred write: acknowledge to the agent, hold the payload, forward it to
  // the brain only at shutdown (end of this task's job).
  if (DEFER_WRITES) {
    let parsed
    try {
      parsed = JSON.parse(bodyBuf.toString('utf8'))
    } catch {
      parsed = null
    }
    // Defer EVERY learning write, not just lesson ingest. brain_append and
    // brain_add_edge mutate retrievable state too, so letting them through
    // immediately would reopen exactly the cross-attempt leakage that
    // deferring exists to close.
    if (parsed?.method === 'tools/call' && LEARN_TOOLS.has(parsed.params?.name)) {
      // Spool BEFORE acknowledging: the agent is about to be told the lesson
      // was accepted, so it must already be recoverable if this process dies.
      spoolDeferred(bodyBuf)
      deferred.push(bodyBuf)
      // Carry the pending rewrite markers on THIS line and clear them. The
      // deferred branch returns before `noteCall`, so previously a repair or a
      // category rewrite applied to a deferred write was never logged — and the
      // marker dangled, to be misattributed to whatever tool call came next.
      // Measured cost of that: the markup repair looked like it had never fired
      // (count 0) while the stored lessons proved it had, which cost a whole
      // iteration to tell apart.
      {
        const entry = { tool: parsed.params.name, allowed: true, mode: 'deferred' }
        if (lastRepairedMarkup !== undefined) {
          entry.repairedMarkup = lastRepairedMarkup
          lastRepairedMarkup = undefined
        }
        if (lastRewrittenFrom !== undefined) {
          entry.categoryRewrittenFrom = lastRewrittenFrom
          lastRewrittenFrom = undefined
        }
        if (lastThinkingModeFrom !== undefined) {
          entry.thinkingMode = THINKING_MODE
          lastThinkingModeFrom = undefined
        }
        applyRequestMeta(entry, parsed, meta)
        record(entry)
      }
      const ack = {
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                deferred: true,
                note: 'Lesson accepted. It becomes retrievable for later tasks, not for further attempts at this one.',
              }),
            },
          ],
        },
      }
      const payload = Buffer.from(JSON.stringify(ack), 'utf8')
      clientRes.writeHead(200, {
        'content-type': 'application/json',
        'content-length': payload.length,
      })
      clientRes.end(payload)
      return
    }
  }

  noteCall(bodyBuf, meta)

  // Forward verbatim, minus hop-by-hop and length headers we are re-deriving,
  // plus the Authorization the container could never have supplied.
  const headers = { ...clientReq.headers }
  delete headers.host
  delete headers.connection
  delete headers['content-length']
  headers.authorization = `Bearer ${token}`
  if (bodyBuf.length > 0) headers['content-length'] = String(bodyBuf.length)

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: clientReq.method,
      path: clientReq.url,
      headers,
    },
    upstreamRes => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      // TEE, not buffer: the client keeps receiving chunks as they arrive (the
      // MCP streamable-HTTP transport uses SSE, so buffering would stall every
      // streamed response), while a bounded copy is kept so `noteOutcome` can
      // report what the brain actually answered.
      //
      // DECODE ACROSS CHUNK BOUNDARIES. This used to be a bare
      // `chunk.toString('utf8')` per chunk, which decodes each TCP chunk
      // independently: any multi-byte UTF-8 sequence straddling a boundary
      // became U+FFFD. Harmless while the only use was an ASCII `"isError":true`
      // substring scan, but a corrupted character is a corrupted CHARACTER
      // COUNT, and `payloadChars` / `results` are now reported as measurements.
      // A StringDecoder holds the partial sequence until the next chunk
      // completes it.
      const decoder = new StringDecoder('utf8')
      let seen = 0
      let capped = false
      let copy = ''
      upstreamRes.on('data', chunk => {
        try {
          if (seen >= OUTCOME_CAP_BYTES) {
            capped = true
            return
          }
          copy += decoder.write(chunk)
          seen += chunk.length
        } catch {
          // The client's copy of this chunk is piped independently below, so a
          // failure here costs a log field, never the response.
        }
      })
      upstreamRes.on('end', () => {
        try {
          copy += decoder.end()
          // `caller` travels to the verdict line too, not just the request
          // line: the verdict is where `results` lives, so "did the AGENT's
          // searches come back empty" is answerable on one line instead of
          // needing a join that may not hold.
          noteOutcome(bodyBuf, copy, { conn: meta.conn, caller: meta.caller, capped })
        } catch (err) {
          // The response has already been piped to the client by this point;
          // an exception escaping here would kill the process and take every
          // LATER request with it, which is a far worse failure than a missing
          // log line.
          console.error(`[tb-proxy] outcome logging failed (request was still served): ${err.message}`)
        }
      })
      upstreamRes.pipe(clientRes)
    },
  )

  upstream.on('error', err => {
    console.error(`[tb-proxy] upstream error: ${err.message}`)
    if (!clientRes.headersSent) clientRes.writeHead(502)
    clientRes.end('upstream unreachable')
  })

  if (bodyBuf.length > 0) upstream.write(bodyBuf)
  upstream.end()
})

// Assign each TCP connection an ordinal the moment it is accepted — before any
// request on it is parsed, so `requestMeta` always finds one. A WeakMap keyed on
// the socket rather than a property stamped on it: nothing else can collide with
// it, and the entry disappears with the socket.
server.on('connection', socket => {
  try {
    connSeq += 1
    connIds.set(socket, connSeq)
  } catch {
    // A call with no `conn` is still a recorded call.
  }
})

// 0.0.0.0 on purpose: the container reaches this through host.docker.internal,
// which is NOT the loopback interface. Bench-scoped and torn down after the
// run — see run-dg.sh, which starts and stops it around the harbor invocation.
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(
    `[tb-proxy] thinking_mode: ${
      VALID_THINKING_MODES.has(THINKING_MODE)
        ? `PINNED to '${THINKING_MODE}' on ${[...THINKING_MODE_TOOLS].join(',')}`
        : `agent's choice (TB_THINKING_MODE=${THINKING_MODE}) — brain_search defaults to chat`
    }`,
  )
  console.log(
    `[tb-proxy] listening on 0.0.0.0:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} ` +
      `(writes ${
        ALLOW_WRITES
          ? 'ALL ALLOWED — run is NOT a clean measurement'
          : LEARN_MODE
            ? `learn-mode: ${[...LEARN_TOOLS].join(',')} only`
            : 'blocked'
      })`,
  )
})

/** Flush deferred lessons to the brain. Sequential: order is the order the
 *  agent wrote them, and the brain's dedup guard prefers a stable sequence.
 *
 *  Returns {sent, accepted, refused}. It used to `res.resume()` — discard the
 *  body — and count every request it managed to SEND as a flushed lesson, so a
 *  brain that refused all of them still reported `flushed:N`. Under
 *  TB_DEFER_WRITES that made three separate layers claim success for a write
 *  that never landed: the synthetic ack returned to the agent, this count, and
 *  the usage check's "N calls served". The response is now read and classified,
 *  and a refusal is printed rather than swallowed. */
function flushDeferred() {
  return new Promise(resolve => {
    const tally = { sent: 0, accepted: 0, refused: 0 }
    // The SPOOL is the source of truth, not the in-memory array: it also holds
    // anything a killed predecessor buffered but never flushed.
    const pending = readSpool()
    if (pending.length > deferred.length) {
      console.error(
        `[tb-proxy] recovered ${pending.length - deferred.length} deferred lesson(s) ` +
          'left on disk by an earlier proxy that was killed before flushing',
      )
    }
    const queue = pending.length ? pending : deferred.slice()
    deferred.length = 0
    if (queue.length === 0) {
      clearSpool()
      return resolve(tally)
    }
    const next = () => {
      const body = queue.shift()
      if (!body) {
        // Only drop the spool once every body in it has been answered for.
        clearSpool()
        return resolve(tally)
      }
      const req = http.request(
        {
          host: UPSTREAM_HOST,
          port: UPSTREAM_PORT,
          method: 'POST',
          path: '/mcp',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            'content-length': String(body.length),
          },
        },
        res => {
          // DECODE ACROSS CHUNK BOUNDARIES — the SAME fix as the main response
          // tee, which this second tee was left out of when that one was
          // repaired. A one-sided fix is worse than none: it makes the two
          // paths disagree while both look fixed.
          //
          // A bare `c.toString('utf8')` per chunk decodes every TCP chunk
          // independently, so a multi-byte UTF-8 sequence straddling a chunk
          // boundary becomes U+FFFD on both sides of the split. That is not
          // cosmetic here — `text` feeds THREE consumers: `parseRpcPayload`
          // (a corrupted byte inside the JSON turns an accepted lesson into a
          // logged `unparseable`, i.e. a false refusal in the artifact), the
          // `detail` string printed to the operator, and
          // `describeResponsePayload`, whose `payloadChars` is published as a
          // measurement. A StringDecoder holds the partial sequence until the
          // next chunk completes it.
          //
          // The cap is now counted in BYTES like the main tee's, not in
          // decoded characters, so both tees mean the same thing by
          // OUTCOME_CAP_BYTES.
          const decoder = new StringDecoder('utf8')
          let seen = 0
          let capped = false
          let text = ''
          res.on('data', c => {
            try {
              if (seen >= OUTCOME_CAP_BYTES) {
                capped = true
                return
              }
              text += decoder.write(c)
              seen += c.length
            } catch {
              // This copy exists only to classify and log the answer; the
              // flush's own tally and `next()` do not depend on it, so a
              // failure here must cost a log field and never a lesson.
            }
          })
          res.on('end', () => {
            try {
              // Flush any bytes the decoder is still holding BEFORE anything
              // reads `text` — otherwise a body whose final character is
              // multi-byte loses it from the tally's `detail` too.
              text += decoder.end()
            } catch {
              // A short body still classifies: parseRpcPayload returns null
              // and the branch below reports a refusal rather than throwing.
            }
            tally.sent += 1
            const rpc = parseRpcPayload(text)
            const failed = !rpc || rpc.error || rpc.result?.isError
            if (failed) {
              tally.refused += 1
              const detail = String(
                rpc?.error?.message ?? rpc?.result?.content?.[0]?.text ?? text,
              ).slice(0, 160)
              console.error(`[tb-proxy] deferred lesson REFUSED by the brain: ${detail}`)
            } else {
              tally.accepted += 1
            }
            // A logging failure must not abandon the flush queue: `next()` is
            // what drains the remaining lessons and resolves the /__flush
            // response, so an exception escaping here would hang the caller
            // and lose every lesson still queued behind this one.
            try {
              // `capped` travels with the text so a truncated size reads as a
              // floor here exactly as it does on the main tee. There is no
              // client connection behind a deferred flush, so no caller
              // identity is passed and `applyRequestMeta` stamps the explicit
              // `caller: 'unknown'` default — which is the honest answer: the
              // agent that queued this lesson is long gone by flush time.
              noteOutcome(body, text, { capped })
            } catch (err) {
              console.error(`[tb-proxy] deferred outcome logging failed: ${err.message}`)
            }
            next()
          })
        },
      )
      req.on('error', err => {
        tally.sent += 1
        tally.refused += 1
        console.error(`[tb-proxy] deferred flush failed: ${err.message}`)
        next()
      })
      req.write(body)
      req.end()
    }
    next()
  })
}

async function shutdown() {
  const t = await flushDeferred()
  const allowed = toolCalls.filter(c => c.allowed && c.tool).length
  const blockedCount = toolCalls.filter(c => !c.allowed).length
  // Brain-side verdicts, which are the only ones that mean "it worked".
  const accepted = toolCalls.filter(c => c.verdict === 'accepted').length
  const refused = toolCalls.filter(c => c.verdict === 'refused' || c.verdict === 'gate-denied').length
  console.log(
    `[tb-proxy] shutting down: ${allowed} tool call(s) forwarded ` +
      `(brain accepted ${accepted}, refused ${refused}), ${blockedCount} blocked by this proxy` +
      (DEFER_WRITES ? `, ${t.accepted}/${t.sent} deferred lesson(s) flushed` : ''),
  )
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
