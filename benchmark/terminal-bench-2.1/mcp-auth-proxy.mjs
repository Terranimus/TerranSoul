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
import { buildVerifyLine, buildJudgeInputLine } from './verify-verdict-line.mjs'

const LISTEN_PORT = Number(process.env.TB_PROXY_PORT || 7425)
const UPSTREAM_HOST = process.env.TB_PROXY_UPSTREAM_HOST || '127.0.0.1'
// ── WHICH BRAIN THIS PROXY SERVES ─────────────────────────────────────────
// THE DEFAULT USED TO BE 7423 -- THE PRODUCTION BRAIN. That store holds
// task-specific TerminalBench lessons from earlier campaigns, and serving them
// to a benchmark agent is contamination that invalidates the submission: the
// leaderboard judge classes prior-run post-mortems as harness_level_cheating.
// run-dg.sh does pass TB_PROXY_UPSTREAM_PORT explicitly, so the default was
// never exercised BY IT -- but a default that is wrong-by-design is the root
// cause, and anyone invoking this proxy directly inherited it. Ported from the
// 3.0 proxy, which grew this guard on 2026-08-19 after exactly that happened.
//
// This is a BENCH-SCOPED script, so the bench brain is the only defensible
// default. Fronting production stays possible, but only as a deliberate,
// acknowledged act: TB_PROXY_ALLOW_PRODUCTION_UPSTREAM=1.
const PRODUCTION_BRAIN_PORT = Number(process.env.TB_PRODUCTION_BRAIN_PORT || 7423)
const BENCH_BRAIN_PORT = Number(process.env.TB_BENCH_BRAIN_PORT || 7424)
const UPSTREAM_PORT = Number(process.env.TB_PROXY_UPSTREAM_PORT || BENCH_BRAIN_PORT)
// Tools that fetch an arbitrary URL server-side, and the benchmark-owned
// markers they must never be pointed at. Same pattern as
// trial-contamination-check.mjs's BENCH_URL: host or path, evidence-derived.
const FETCH_TOOLS = new Set(['brain_ingest_url'])
const BENCH_URL_MARKERS = /(?:tbench\.ai|harborframework\.com|harbor-framework|laude-institute|terminal[-_]bench)/i

const ALLOW_WRITES = process.env.TB_PROXY_ALLOW_WRITES === '1'

const UPSTREAM_IS_LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(UPSTREAM_HOST)
if (
  UPSTREAM_PORT === PRODUCTION_BRAIN_PORT &&
  UPSTREAM_IS_LOOPBACK &&
  process.env.TB_PROXY_ALLOW_PRODUCTION_UPSTREAM !== '1'
) {
  console.error(
    `[tb-proxy] REFUSING: upstream is the PRODUCTION brain (port ${PRODUCTION_BRAIN_PORT}). It holds ` +
      'task-specific TerminalBench lessons from earlier campaigns; serving them to a benchmark agent ' +
      'is contamination and invalidates the submission (rules/bench-agi-purity.md).',
  )
  console.error(`[tb-proxy] Point this proxy at the isolated bench brain: TB_PROXY_UPSTREAM_PORT=${BENCH_BRAIN_PORT}`)
  console.error('[tb-proxy] If you genuinely mean to front production, set TB_PROXY_ALLOW_PRODUCTION_UPSTREAM=1 and do NOT publish the run.')
  process.exit(2)
}
const LOG_PATH = process.env.TB_PROXY_LOG || ''

// Mirrors src-tauri/src/ai_integrations/mcp/router.rs::is_public_tool_name.
// Kept as an explicit copy rather than imported: this is a bench-scoped guard,
// and if the server's list ever changes we want the divergence to be visible
// here rather than silently inherited.
//
// ⚠️ MEASURED 2026-08-04: this list is a SUPERSET of what the server actually
// serves. `is_public_tool_name` is the LAN-anonymous READ POLICY; the tools on
// the wire are `tools.rs::EXPOSED_TOOLS`, an owner-approved 9-tool product API
// (2026-08-01, "one coherent CRUD+RAG API", down from 84). Five names below —
// brain_suggest_context, brain_summarize, brain_list_recent, brain_failover_status
// and every brain_wiki_* — are allowlisted here but are NOT advertised by the
// server, so allowing them changes nothing. Harmless as a permission, actively
// misleading as a description: keep the policy mirror intact, and tell the
// agent about EXPOSED_BRAIN_TOOLS instead (see gate()).
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
  // TBENCH-WEB-RESEARCH-1: put on the wire 2026-09-01 (tools.rs::EXPOSED_TOOLS).
  // Named here so the refusal message below tells a blocked agent about the one
  // tool that turns something it read on the web into durable memory.
  'brain_ingest_url',
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


// ── WEB RESEARCH THAT PERSISTS (TBENCH-WEB-RESEARCH-1, 2026-09-01) ─────────
//
// OWNER DECISION: a bench agent may research online and KEEP what it finds,
// unrestricted. The self-seeding risk (an agent fetching a page that gives away
// its own task) was put to the owner and accepted, so NO NEW GATE is added for
// this tool — it joins the learn surface and inherits exactly the checks the
// other learn writes already pass.
//
// `brain_ingest_url` is the only tool that closes the loop: it drives the
// gateway's ingest sink through a live fetch -> text extraction -> chunk ->
// embed -> `store_ingest_row` with `source_url` set, so the page becomes
// ordinary retrievable memory rather than context that dies with the turn.
// Without it an agent can read the web (its own fetch/search tools) but cannot
// remember any of it past the trial, which is the half of "research online"
// that a MEMORY system is supposed to supply.
//
// TWO INHERITED BEHAVIOURS, both deliberate, both pinned by
// ingest-url-learn-mode.test.mjs:
//   * The task-identity write-purity gate below scans EVERY string in the
//     payload, so a URL naming a benchmark task is refused with -32002 like any
//     other write. That is the existing gate doing its existing job, not a new
//     restriction: the URL and tags are simply writable fields like the rest.
//   * Under TB_DEFER_WRITES=1 the ingest is BUFFERED with the other learn
//     writes and flushed at job end, so a fetched page reaches later TASKS but
//     not later ATTEMPTS at the same one. The redo path (redo-task.sh) defaults
//     TB_DEFER_WRITES=0, where the fetch happens immediately and the content is
//     searchable within the same trial.
const LEARN_TOOLS = new Set([
  'brain_ingest_lesson',
  'brain_append',
  'brain_add_edge',
  'brain_close_edge',
  'brain_ingest_url',
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

let token = process.env.TERRANSOUL_MCP_TOKEN || ''
if (!token) {
  const tokenFile =
    process.env.TERRANSOUL_MCP_TOKEN_FILE ||
    path.join(process.cwd(), 'mcp-data', 'mcp-token.txt')
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim()
  } catch (err) {
    console.error(`[tb-proxy] cannot read MCP token from ${tokenFile}: ${err.message}`)
    process.exit(2)
  }
}
if (!token) {
  console.error('[tb-proxy] MCP token is empty')
  process.exit(2)
}

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

/**
 * TBENCH-WRITE-PURITY-3 — a lesson asserting that its own attempt PASSED.
 *
 * ⛔ STRUCTURALLY IMPOSSIBLE, NOT MERELY UNRELIABLE. A lesson is written by the
 * agent DURING its trial; the verifier runs after the agent exits. So no claim
 * an agent makes about its own score can be true when it is written. The
 * harness stamps real verdicts afterwards (the `[OUTCOME]` prefix, and
 * `credit-trial-outcome.mjs`), which is the legitimate path and does not pass
 * through this proxy.
 *
 * MEASURED 2026-09-02, two independent fabrications in the live stores:
 *   * "filter-js-from-html HIT 3 CONSECUTIVE PASSES ... the task was already
 *     SOLVED" (importance 9) — against 0 passes in 69 graded trials across all
 *     40 job roots, with no job dirs existing at all on the date claimed;
 *   * "[VERIFIED SOLVE] ... PASSED 2 of 2 checks (reward 1.0) ... written AFTER
 *     the verifier ran, so it is an outcome and not a theory".
 * A prior session had already recorded the same shape: four graded zeros
 * written up as a "fourth consecutive success".
 *
 * These are the most damaging rows a store can hold. A false "already solved"
 * does not merely mislead on technique — it tells the next attempt to stop
 * investigating, so it reuses the approach that has never worked and cannot
 * discover that it does not.
 *
 * DELIBERATELY ASYMMETRIC: claimed FAILURES are allowed through. An agent
 * saying "the previous attempt scored 0" is repeating what the harness told it
 * in its own prior-attempts block, and a pessimistic claim is not self-serving.
 * Only the unearnable PASS is refused.
 *
 * Scans prose (unlike `answerFingerprintHits`, which reads tags only) because
 * that is where the claim lives — both measured instances were narrative.
 */
// ⛔ NARROWED 2026-09-02 AFTER MEASURING PRECISION ON THE REAL CORPUS.
//
// The first version matched any `reward|scored 1.0`, `passed N of N`, or
// `N consecutive successes`. Run against the two live stores it flagged FIVE
// memories and every one was a FALSE POSITIVE — none was an agent claiming its
// own attempt passed:
//
//   12254  "pure-algo repro PASSED 6/6 while production code never fired"
//            — a test result, and the entire point of the lesson
//   25795  "locking the category behind 5 consecutive successes + a cooldown"
//            — describing a quarantine POLICY
//   25919  "job dg-20260804-160416 PASSED its task with reward 1.0 and made
//    25941   ZERO brain calls" — a historical job cited as evidence that
//            attaching tools does not make an agent use them
//   25993  "a trial passed with reward 1.0 ... and the pass is still not
//            publishable" — an analytical lesson about contamination
//
// Precision 0 of 5. Shipping that would have refused five high-importance
// lessons and caught nothing, actively degrading the loop it exists to protect
// — a gate that blocks good writes is worse than no gate.
//
// CITING a graded outcome is legitimate and valuable; only STAMPING one on your
// own current work is impossible. So match just the self-stamping shapes.
// Re-measured: 0 hits across 2044 bench memories, 1 hit in production — exactly
// the known fabrication (25960, "HIT 3 CONSECUTIVE PASSES ... already SOLVED").
const SELF_GRADED_PASS = [
  /\[\s*VERIFIED\s+SOLVE\s*\]/i,
  // The structural lie: the verifier runs after the agent exits, so nothing an
  // agent writes can postdate it.
  /written\s+AFTER\s+the\s+verifier\s+ran/i,
  // A streak claimed about THIS task's own history, in the emphatic register
  // these fabrications use — not "5 consecutive successes" describing a policy.
  /\bHIT\s+\d+\s+CONSECUTIVE\s+PASSES\b/i,
  /\bthe\s+task\s+was\s+already\s+SOLVED\b/i,
]

function selfGradedPassHits(args) {
  if (!args) return []
  const hits = new Set()
  const walk = (node, depth) => {
    if (node == null || depth > 8) return
    if (typeof node === 'string') {
      for (const re of SELF_GRADED_PASS) {
        const m = node.match(re)
        if (m) hits.add(m[0].trim().slice(0, 60))
      }
      return
    }
    if (typeof node !== 'object') return
    for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, depth + 1)
  }
  walk(args, 0)
  return [...hits]
}

/**
 * Decide whether to forward. Returns null to allow, or a JSON-RPC error object
 * to return instead. Anything we cannot parse is allowed through — the
 * upstream server is the real authority; this guard exists to stop WRITES, not
 * to second-guess the protocol.
 */
function gate(bodyBuf) {
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
  // ── ANSWER-KEY URL GUARD (TBENCH-MCP-FETCH-1) ─────────────────────────────
  //
  // ⛔ CLOSING A HOLE BEFORE IT OPENS. `brain_ingest_url` fetches an arbitrary
  // URL server-side and stores the page. The PreToolUse answer-key guard added
  // in 54e29c4d/5e558448 covers Claude Code's own WebFetch and CANNOT see this
  // path at all: an MCP tools/call never passes through a PreToolUse hook.
  //
  // Today nothing reaches it, because `external_fetch` is a BORN-UNTRUSTED
  // action-trust category (threshold 0.75 against a ~0.67 cold start) that is
  // deny-by-default and, by explicit design, cannot bootstrap — half-open
  // probes are excluded there precisely so they cannot "MINT trust that was
  // never held". MEASURED 2026-09-07: calling it returns
  // "action gated by earned autonomy ... trust (0.67) is below the earned
  // threshold (0.75)", which is why it has ZERO uses across 90 trials while
  // extra-instruction.md tells the agent to use it.
  //
  // That deny is the ONLY thing standing between this tool and the answer key,
  // and action_trust.rs documents that the posture is DATA: "a store that seeds
  // action_trust.threshold.safe_write above the cold start turns safe_write
  // into a born-untrusted category ... with no code change". So the converse is
  // equally a config edit away, and whoever notices the tool never works and
  // lowers the threshold would silently open an unguarded fetch straight to
  // tbench.ai. A trial that reads the benchmark's own material is scored ZERO
  // on review (see the contamination preflight in run-dg.sh).
  //
  // Markers mirror trial-contamination-check.mjs's BENCH_URL, which was derived
  // from the ONE confirmed incident (mteb-retrieve nXLVpLp fetched
  // raw.githubusercontent.com/harbor-framework/terminal-bench-2/.../
  // test_outputs.py and copied the expected string), not from imagination.
  if (FETCH_TOOLS.has(name)) {
    const url = String(req.params?.arguments?.url ?? '')
    if (BENCH_URL_MARKERS.test(url)) {
      record({ tool: name, allowed: false, reason: 'answer-key-url' })
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32002,
          message:
            `bench proxy: refusing to fetch ${url}. That host is this benchmark's own ` +
            'material -- its task registry, grading tests or published solutions. Retrieving it ' +
            'voids the trial no matter what your own verification then says, so it is refused ' +
            'here rather than scored zero on review. Resolve the question from the artifact in ' +
            'front of you, or from an independent source that is not the benchmark itself.',
        },
      }
    }
  }

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

    // TBENCH-WRITE-PURITY-3: a SELF-ASSERTED PASS is unknowable at write time.
    const graded = selfGradedPassHits(req.params?.arguments)
    if (graded.length) {
      record({ tool: name, allowed: false, reason: 'self-graded-pass' })
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32002,
          message:
            `bench proxy: this lesson asserts a graded PASS (${graded.join(', ')}), so it was NOT ` +
            'stored. You cannot know this: the verifier runs AFTER you exit, so no claim about ' +
            'your own score can be true at the moment you write it. Two such claims were measured ' +
            'in the store, and both were false against the run record — one asserted "3 ' +
            'consecutive passes" and "already SOLVED" for a task with 0 passes in 69 graded ' +
            'trials. They are the most damaging rows in the corpus, because an attempt that ' +
            'believes the ground is covered stops investigating and reuses the approach that ' +
            'never worked. Record what you TRIED and what you OBSERVED — the commands, the ' +
            'outputs, the reasoning — and let the harness attach the verdict. Then call again.',
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
  record({ tool: name, allowed: false, reason: 'blocked' })
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
// ── DEFAULT MOVED `think` -> `chat`, 2026-09-06, ON MEASUREMENT ─────────────
//
// THIS DOES NOT REVERSE THE OWNER DECISION ABOVE. That decision was `max` ->
// `think` on LATENCY ("timeout and uncertainty of completion"), and the tool's
// own schema states that **`chat` and `think` are the same cost**. The latency
// criterion that drove it is fully preserved here; what changes is a separate
// axis the max-vs-think comparison never examined.
//
// The rationale block above says the four rungs are "cumulative, not
// stylistic", and that running a cheaper rung "removes the reranker, the graph
// expansion and the verifier from the measurement". For `think` specifically,
// tools.rs now says otherwise, and it was updated with measurements dated AFTER
// this pin was set (2026-09-01 vs 2026-08-05):
//   * `think` adds ONLY a non-LLM knowledge-graph bridge hop. The reason-then-
//     rank judge is "deliberately NOT on this rung".
//   * "⛔ IT CAN AND DOES DROP RESULTS THE PLAIN PASS FOUND." The hop only ADDS
//     candidates before fusion, but the fused list is TRUNCATED AT `limit`, so
//     an added neighbour DISPLACES a genuine hit.
//   * LongMemEval-S 200q: NDCG@10 0.939 (chat) vs 0.510 (think).
//   * A live 2192-row brain: a memory with three corpus-unique strings came
//     back at rank 4 under `chat` and rank 10 under `think`.
//   * Its verdict, verbatim: "Prefer 'chat' unless you specifically need to
//     chain a fact across documents sharing no query terms".
//
// MEASURED ON THIS CAMPAIGN 2026-09-06, which is why it is changed now rather
// than noted: `raman-fitting` failed in BOTH full k=1 sweeps with `offset` as
// the only wrong parameter, and the bench brain CONTAINED the lesson naming
// that exact failure (26660, authored 2026-09-02 — four days before sweep 3 —
// tagged baseline/offset/degeneracy/fit-window). It was never served. FTS ranks
// it FOURTH on the agent's own query, i.e. inside the `limit: 4` cut, yet the
// served four were 26899, 26918, 26704, 25125 — and 25125 (boeing forensics)
// is absent from the FTS ranking entirely and sits at cosine 0.354 to the
// topic against 0.615 for the lesson. The embedding space is healthy (2333
// rows, all 768d, no nulls, random-pair mean cosine 0.337), so this is the
// documented truncation-displacement, not an embedding defect. All 86
// brain_search calls of that sweep ran pinned to `think`.
//
// ⛔ WHAT IS NOT CLAIMED: that this raises k=1. It has not been measured
// against task outcomes, and three sweeps' worth of harness changes have
// already shown that a mechanism can be confirmed working and still not move
// the number. What IS established is that the pin selected the rung its own
// tool documents as worse for ranking, on a config set before that measurement
// existed, and that it demonstrably cost this campaign a lesson it had already
// authored. Set TB_THINKING_MODE=think to restore the old arm for an A/B.
const THINKING_MODE = (process.env.TB_THINKING_MODE || 'chat').toLowerCase()
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

/** Classify one forwarded tools/call by what the brain actually answered. */
function noteOutcome(reqBuf, responseText) {
  let name
  // The REQUEST's `op` — the response does not echo it, and without it a
  // `brain_verify_completion` line cannot be attributed to the judge rather
  // than to ledger bookkeeping. See `noteVerifyVerdict`.
  let op
  try {
    const req = JSON.parse(reqBuf.toString('utf8'))
    if (req?.method !== 'tools/call') return
    name = req.params?.name
    const rawOp = req.params?.arguments?.op
    if (typeof rawOp === 'string') op = rawOp
  } catch {
    return
  }
  if (typeof name !== 'string') return

  const rpc = parseRpcPayload(responseText)
  if (!rpc) {
    // Belt-and-braces for the truncation case above: a body we cannot parse is
    // still readable enough to answer the only question that matters. The
    // error markers are literal strings, so look for them directly rather than
    // defaulting to "unreadable" — which reads as a failure and is what raised
    // a false alarm on a healthy call.
    if (responseText.includes('"isError":true')) {
      const gated = responseText.includes('action gated by earned autonomy')
      record({ name, verdict: gated ? 'gate-denied' : 'refused', detail: 'detected in an unparseable body' })
    } else if (responseText.includes('"result"')) {
      record({ name, verdict: 'accepted', truncated: true })
    } else {
      record({ name, verdict: 'unparseable', detail: responseText.slice(0, 120) })
    }
    return
  }
  if (rpc.error) {
    record({ name, verdict: 'refused', detail: String(rpc.error.message ?? '').slice(0, 160) })
    return
  }
  if (rpc.result?.isError) {
    const detail = String(rpc.result?.content?.[0]?.text ?? '').slice(0, 160)
    // The earned-autonomy gate has a stable prefix (action_trust.rs::
    // GATE_DENY_PREFIX). Calling it out by name is the difference between
    // "the brain said no" and "the brain said no BECAUSE it does not trust
    // this agent yet", which is the one a sweep must never ignore.
    const gated = detail.startsWith('action gated by earned autonomy')
    record({ name, verdict: gated ? 'gate-denied' : 'refused', detail })
    return
  }
  record({ name, verdict: 'accepted' })
  noteServedMemories(name, rpc)
  noteReadMemory(name, reqBuf, rpc, responseText)
  noteAuthoredMemory(name, rpc)
  noteVerifyVerdict(name, rpc, op)
}

/**
 * The serving layer's refutation markers, as they arrive on the wire.
 *
 * ⛔ COPIED FROM THE PRODUCER, WHICH IS `crates/memory/src/outcome_stamp.rs`
 * (`REFUTED_BANNER_PREFIX`, `QUARANTINE_PREFIX`). This proxy is a JS process
 * beside the bench and cannot import a Rust constant, so the coupling is stated
 * here instead of implied — and the recogniser is deliberately LOOSER than the
 * Rust write-side guard's. That guard matches prefix AND sentinel because
 * whatever it matches it DELETES from a stored row; this one only decides whether
 * a read is logged as exposure, where a false positive withholds credit (visible,
 * recoverable by a recount) and a false negative releases a quarantined body
 * (the defect OUTCOME-VISIBLE-6 exists to stop).
 *
 * `[body withheld ` is OUTCOME-VISIBLE-4's spelling of the same line, kept so a
 * log written against a server mid-upgrade classifies the same way.
 */
const REFUTED_BANNER_PREFIX = '[REFUTED '
const QUARANTINE_MARKERS = ['[body quarantined ', '[body withheld ']

/**
 * Was the entry the brain just handed over REFUTED at the moment it was served?
 *
 * ⛔ THE PREDICATE IS REFUTATION, NOT QUARANTINE, and the two are not the same
 * set. A refuted entry that carries NO update blocks is served its stored text
 * below the banner (there is no block ledger to offer instead), so such a reader
 * did see the construction. It is still classified as exposure here, because the
 * ledger fallback in `credit-trial-outcome.mjs` can only ask "is this row
 * refuted?" — and two classifiers of one fact that answer differently is the
 * defect class this directory keeps rediscovering. The widening is stated rather
 * than hidden: it can only ever WITHHOLD credit from a row the brain had already
 * told the reader not to reproduce.
 */
function servedViewWasRefuted(rpc, responseText) {
  const text = rpc?.result?.content?.[0]?.text
  if (typeof text === 'string') {
    let body = null
    try {
      const o = JSON.parse(text)
      body = typeof o?.content === 'string' ? o.content : null
    } catch {
      // Not an entry-shaped payload; fall through to the raw scan below.
    }
    if (body !== null) {
      return (
        body.startsWith(REFUTED_BANNER_PREFIX) || QUARANTINE_MARKERS.some((m) => body.includes(m))
      )
    }
    if (text.startsWith(REFUTED_BANNER_PREFIX) || QUARANTINE_MARKERS.some((m) => text.includes(m))) {
      return true
    }
  }
  // Last resort: a body too large or too odd to parse is still readable enough
  // to answer the only question being asked, exactly as the truncation path
  // above this call site does for the accepted/refused split.
  const raw = String(responseText ?? '')
  return raw.includes(REFUTED_BANNER_PREFIX) || QUARANTINE_MARKERS.some((m) => raw.includes(m))
}

/**
 * Record the id of a memory this trial actually OPENED.
 *
 * ⛔ BEING SHOWN A RESULT IS NOT USING IT, AND THE DIFFERENCE IS PAYING REAL
 * MONEY TO THE WRONG ROW.
 *
 * `brain_search` puts up to ten rows in front of an agent; `brain_get_entry`
 * is the agent choosing one and reading it. Only the second is evidence that
 * the memory entered the work. Until now the credit step had no way to tell
 * them apart, because only the `served` list was logged.
 *
 * MEASURED 2026-09-12 on memory 26809 (a MobileSAM notebook). Nineteen trials
 * touched it. Twelve were its own task — 3 passes and 9 failures, every one of
 * which AUTHORED it. The other seven were different tasks entirely
 * (caffe-cifar-10 twice, mteb-retrieve, bn-fit-modify, video-processing,
 * winning-avg-corewars, pytorch-model-cli); all seven passed, all seven merely
 * had the row appear in a search result, and all seven were credited as
 * successes. The stored ledger therefore read 9 successes / 6 failures, so the
 * next agent was told the entry was mostly working — when on its own task it is
 * 3 of 12 with four consecutive failures, i.e. REFUTED under the rule the
 * server instructions state. A segmentation notebook was being paid for a
 * CIFAR pass.
 *
 * Same class the repo has already named twice: "advertisement is not use —
 * count structured tool invocations, never name occurrences", and "an append
 * target is where the agent RECORDED, not the advice it FOLLOWED".
 *
 * THE ID COMES FROM THE REQUEST, not the response: the request is what the
 * agent asked for, it is present even when the response shape drifts, and it
 * cannot be inflated by a response that happens to mention other ids. This
 * runs only on the accepted path (see the call site), so a refused or gated
 * fetch never counts as a read.
 *
 * Logged under `read`, deliberately NOT `tool`/`name`/`served`/`authored`:
 * each of those keys is counted by a witness elsewhere, and one forwarded call
 * must keep producing exactly one of each. This adds a parallel line.
 *
 * ── OUTCOME-VISIBLE-6: A READ OF A REFUTED ENTRY IS EXPOSURE, NOT USE ────────
 *
 * ⛔ AND "USE" WAS RELEASING QUARANTINED BODIES. Since OUTCOME-VISIBLE-5 a
 * refuted entry's text is withheld from every tool surface: this very call
 * returns the `[REFUTED …]` verdict plus a graded index of the entry's own
 * update blocks, and no argument reaches the construction. The reader gets a
 * warning and a table of contents.
 *
 * MEASURED 2026-09-13. Entry 26809 was refuted with 10 consecutive graded
 * failures. Trial `redo09130830` called this tool on it, received the
 * quarantined view, authored 27007 and PASSED 9/9. `credit-trial-outcome.mjs`
 * logged `[credit] reward=1 -> success for 2 used memories: 26809, 27007`
 * because USED was `authored ∪ read`, so 26809 went to consecutive_failures 0 /
 * last_outcome success — the banner and the quarantine LIFTED, and the brain
 * served the full body again to the next reader. A success earned by somebody
 * who never saw the body released the body.
 *
 * So the row is SPLIT AT THE SOURCE, where the served view is still in hand:
 * `read_refuted` for a read of a refuted entry, `read` for an ordinary one. The
 * credit step credits the second and reports the first as
 * `exposed-while-refuted`.
 *
 * ⛔ `refuted_at_read` IS THE SCHEMA MARKER AND IT IS ON BOTH SHAPES, including
 * the `false` one where the key name already says it. Without it a plain `read`
 * row is ambiguous between "this proxy checked, and the entry was fine" and
 * "this proxy predates the check" — and the credit step's precedence rule (proxy
 * key wins; ledger fallback only for legacy rows) needs to tell those apart per
 * row. A job-wide or file-wide version stamp would not: one proxy writes rows
 * for every trial in a job, and a reader of an archived log has no other handle.
 */
function noteReadMemory(name, reqBuf, rpc, responseText) {
  if (name !== 'brain_get_entry') return
  try {
    const req = JSON.parse(reqBuf.toString('utf8'))
    const id = req?.params?.arguments?.id
    if (!Number.isInteger(id)) return
    if (servedViewWasRefuted(rpc, responseText)) {
      record({ read_refuted: [id], refuted_at_read: true })
      return
    }
    record({ read: [id], refuted_at_read: false })
  } catch {
    // Shape drift is not worth disturbing a trial over.
  }
}

/**
 * Record WHICH memories a successful `brain_search` put in front of the agent.
 *
 * ⛔ WITHOUT THIS, A FAILED TRIAL TEACHES THE BRAIN NOTHING, AND WRONG ADVICE
 * KEEPS ITS PROMOTION.
 *
 * `store.rs::confidence_buckets` ranks a memory with `success_count >= 1` and
 * `failure_count == 0` into a bucket ABOVE untested rows — its own doc cites a
 * `filter-js-from-html` redo as the reason. The only writer of those counters
 * in a bench run is `brain_observe_outcome`, whose `outcome` and
 * `used_memory_ids` come ENTIRELY FROM THE AGENT (mcp/tools.rs:4093-4107). So
 * an agent that passes tests it wrote itself credits its own sources, and the
 * grader's verdict reaches the brain through no path at all.
 *
 * MEASURED 2026-09-01: memory 26531 — whose advice ("never emit the parser's
 * serialisation") is the DIRECT CAUSE of this task's failure, since the grader
 * compares against `str(BeautifulSoup(...))` — carries success_count=2,
 * failure_count=0 after 54 consecutive graded failures. It sits in the top
 * bucket on two self-reports and is served at rank 1 to every new attempt.
 *
 * This side only OBSERVES; it writes nothing to the brain. It appends the ids
 * the agent was shown so `credit-trial-outcome.mjs` can, after the grader has
 * ruled, attribute the REAL result to them. Failure to record must never
 * disturb a trial, so every error is swallowed.
 */
function noteServedMemories(name, rpc) {
  if (name !== 'brain_search') return
  try {
    const text = rpc?.result?.content?.[0]?.text
    if (typeof text !== 'string') return
    const rows = JSON.parse(text)
    if (!Array.isArray(rows)) return
    const ids = rows.map((r) => r?.id).filter((id) => Number.isInteger(id))
    if (!ids.length) return
    // Logged as `served`, NOT `tool`/`name`: those two keys are counted by the
    // usage witnesses, and one call must keep producing exactly one of each.
    record({ served: ids })
  } catch {
    // An unparseable or differently-shaped response is not worth a word here.
  }
}

/**
 * Record the id of a memory this trial WROTE.
 *
 * ⛔ WITHOUT THIS, A FAILING ATTEMPT'S OWN LESSON ESCAPES ITS VERDICT.
 *
 * `credit-trial-outcome.mjs` debits the memories a trial was SERVED. A lesson
 * the trial AUTHORS is not in that set, so it enters the store carrying no
 * outcome at all — and is then served to the next attempt as an untested row,
 * which `confidence_buckets` ranks above rows with recorded failures.
 *
 * MEASURED 2026-09-03 on extract-elf. The trial scored 0 for exactly the
 * approach it then wrote up as good practice: omit the awkward values, "only
 * ~7% of mapped words ... coverage stays ~93% — well over a 75% floor. Free
 * removal of an entire failure mode." The grader measured 66.67%. The credit
 * step debited the four SERVED rows and never touched the new one (26654,
 * importance 8, success 0, failure 0).
 *
 * That is the "the loop rewrites the poison" pattern with its mechanism
 * visible: purging a bad row does not help while the next failing attempt can
 * mint a clean replacement.
 */
function noteAuthoredMemory(name, rpc) {
  if (name !== 'brain_ingest_lesson' && name !== 'brain_append') return
  try {
    const text = rpc?.result?.content?.[0]?.text
    if (typeof text !== 'string') return
    const o = JSON.parse(text)
    const id = o?.memory_id ?? o?.id
    if (!Number.isInteger(id)) return
    record({ authored: [id] })
  } catch {
    // Shape drift is not worth disturbing a trial over.
  }
}

/**
 * Record WHAT THE STOP GATE DECIDED, not merely that it was consulted.
 *
 * ⛔ WITHOUT THIS THE GATE IS UNFALSIFIABLE FROM THE OUTSIDE.
 *
 * `stop-hook.mjs` already names this gap in its own source: the proxy "records
 * a `brain_verify_completion` call but not its `op`", so 2,015 logged calls
 * could not be split between the LLM judge (`op:'verify'`) and ledger
 * bookkeeping (`record`/`mark_edited`/`status`). It fixed the gap on the
 * gateway side — the verdict is keyed into the verification ledger — but the
 * ledger lives in the brain's data dir, and a bench trial's evidence is its
 * job directory. Nothing in the artefacts a completed sweep leaves behind says
 * what the judge concluded.
 *
 * MEASURED 2026-09-03 by `stop-gate-audit.mjs` over 76 graded trials: 19 scored
 * 0 having never been blocked once. Those 19 are the whole target population for
 * "continue instead of giving up", and they are currently UNLABELLED — the logs
 * cannot distinguish "the judge ran and wrongly confirmed the work" from "the
 * judge was never asked". Those two have opposite fixes: the first is a judge
 * discrimination problem, the second is plumbing. Guessing between them is how
 * a rewrite of the judge's prompt ships with no way to observe whether it ever
 * ran.
 *
 * Logged under `verify`, deliberately NOT `tool`/`name`/`served`/`authored`:
 * each of those keys is counted by a witness elsewhere, and one forwarded call
 * must keep producing exactly one of each. This adds a parallel line.
 *
 * OBSERVE-ONLY. The verdict is read off a response that has already been
 * forwarded; nothing here can change what the agent sees.
 */
function noteVerifyVerdict(name, rpc, op) {
  if (name !== 'brain_verify_completion') return
  try {
    const line = buildVerifyLine(rpc?.result?.content?.[0]?.text, op)
    if (line) record(line)
  } catch {
    // Shape drift is not worth disturbing a trial over.
  }
}

function noteCall(bodyBuf) {
  try {
    const req = JSON.parse(bodyBuf.toString('utf8'))
    if (req?.method === 'tools/call' && typeof req.params?.name === 'string') {
      const entry = { tool: req.params.name, allowed: true }
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
      record(entry)
      // The judge's INPUT, next to the judge's verdict. Without it a wrong
      // verdict is observable but not reproducible: measured 2026-09-05, a
      // verified:true on a graded-0 trial could not be re-derived because
      // `actions_snapshot` survives nowhere in the trial's artefacts.
      // Parallel line, distinct key, observe-only.
      try {
        const judged = buildJudgeInputLine(req.params?.arguments)
        if (judged) record(judged)
      } catch {
        // Shape drift must never disturb a trial.
      }
    } else if (req?.method) {
      record({ method: req.method, allowed: true })
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

  let bodyBuf = Buffer.alloc(0)
  try {
    bodyBuf = await readBody(clientReq)
  } catch {
    clientRes.writeHead(400).end('bad request body')
    return
  }

  const blocked = gate(bodyBuf)
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

  noteCall(bodyBuf)

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
      let seen = 0
      let copy = ''
      upstreamRes.on('data', chunk => {
        if (seen >= OUTCOME_CAP_BYTES) return
        copy += chunk.toString('utf8')
        seen += chunk.length
      })
      upstreamRes.on('end', () => noteOutcome(bodyBuf, copy))
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
          let text = ''
          res.on('data', c => {
            if (text.length < OUTCOME_CAP_BYTES) text += c.toString('utf8')
          })
          res.on('end', () => {
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
            noteOutcome(body, text)
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
