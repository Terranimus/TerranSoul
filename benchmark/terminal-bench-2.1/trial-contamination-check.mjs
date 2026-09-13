#!/usr/bin/env node
// Flag trials that reached for the BENCHMARK'S OWN repository — its tasks,
// solutions, or grading tests. A trial that read the answer key is not a
// measurement of anything, and a submission containing one is invalid: the
// Terminal-Bench leaderboard judge defines harness_level_cheating as "harness
// gave privileged info the agent should not have" and names prior-run
// post-mortems and oracle access explicitly.
//
// WHY THIS EXISTS, and why a human reading the logs is not enough.
//
// MEASURED 2026-08-28, forensics over 29 trials. `mteb-retrieve` trial
// nXLVpLp (jobs-hooksweep) scored reward 1.0 and was counted as one of that
// task's two passes. Its transcript shows it probing twelve repo/branch/path
// combinations, getting 404 on every `terminal-bench-1` spelling, then:
//
//     https://raw.githubusercontent.com/harbor-framework/terminal-bench-2/
//       main/tasks/mteb-retrieve/tests/test_outputs.py   -> 200
//
// It read the grader verbatim, including `expected = "MTEB: Massive Text
// Embedding Benchmark"`, said "Confirmed by the official test file", and only
// THEN copied the matching candidate over /app/result.txt. It then re-ran the
// downloaded grader as its own "independent verification" and recorded that to
// the verification ledger. Every downstream number that counted it as a pass
// was wrong: the honest iteration-1 rate on that task is 1/18, not 2/19.
//
// Nothing in the pipeline noticed. `store-purity-check.mjs` guards the BRAIN
// STORE (do its rows name a benchmark task) and `write-purity.test.sh` guards
// what a trial WRITES BACK. Neither looks at what a trial READ from the
// network, so this whole class was unguarded.
//
// THE ROOT CAUSE IS OURS, not the model's. The Stop hook demands "ONE piece of
// evidence that does not depend on something you wrote this turn", unscoped —
// and nXLVpLp's own account names that demand as what sent it to the grader.
// This checker is the detector; scoping that demand away from the benchmark's
// own artifacts is the fix. Ship both: the fix stops causing it, the detector
// proves it stopped.
//
// WHAT COUNTS, and what deliberately does not. The test is whether a URL names
// the BENCHMARK's own org or repo. Fetching a real upstream dependency is
// normal engineering and must never be flagged — verified against the live
// sweep, where `compile-compcert` fetched
// raw.githubusercontent.com/AbsInt/CompCert/v3.13.1/VERSION and `build-pov-ray`
// made the only two structured WebFetch calls in 31 trials, both to upstream
// POV-Ray. Flagging those would train the operator to ignore this checker.
//
// Reading a file the TASK ITSELF ships in the workspace is likewise not
// contamination: `break-filter-js-from-html` reads /app/test_outputs.py because
// its own task material includes it. So a bare `test_outputs.py` mention proves
// nothing — only a benchmark-repo URL does. (Two trials matched a bare
// `test_outputs.py` grep purely because extra-instruction.md's own
// anti-contamination warning quotes the phrase.)
//
// SEVERITY IS SPLIT ON PURPOSE:
//   CONFIRMED  a benchmark-repo URL that returned content (HTTP 200). The
//              trial had the oracle in hand. Exit 1 — it must not be published.
//   ATTEMPTED  benchmark-repo URLs that only ever 404/403'd. The agent learned
//              nothing, so the trial's score stands, but the harness pushed it
//              there and that is worth seeing before it succeeds next time.
//              Warn, do not fail, unless --strict.
//
// usage:
//   node trial-contamination-check.mjs --jobs jobs-final2 [--strict] [--quiet] [--advisory]
//
// exit 0 = no CONFIRMED contamination; 1 = contamination (or, with --strict,
// any attempt); 2 = bad invocation.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const jobsDir = flag('--jobs')
const strict = argv.includes('--strict')
const quiet = argv.includes('--quiet')
// TBENCH-ADVISORY-LABEL-1: the verdict word must match what the CALLER does.
// This script printed `-> REFUSING` unconditionally, but run-dg.sh only treats a
// non-zero exit as fatal under TB_SUBMITTABLE=1; otherwise it calls this with
// `|| true` and carries on. So a normal sweep logged a LOUD refusal that refused
// nothing, once per task -- 64 times in the 2026-09-08 run. That is not cosmetic:
// run-dg.sh:604 records this exact line costing three runs of investigating
// innocent components, because it sat directly above an unrelated silent exit 2.
// The exit code is unchanged; only the wording follows the caller's intent.
const advisory = argv.includes('--advisory')

if (!jobsDir || !existsSync(jobsDir)) {
  console.error('usage: node trial-contamination-check.mjs --jobs <dir> [--strict] [--quiet] [--advisory]')
  process.exit(2)
}

// The benchmark's own homes. A URL naming any of these has no legitimate
// purpose inside a trial: everything the agent is supposed to have is already
// in its container.
const BENCH_URL = /https?:\/\/[^\s"'`)\\]*(?:harbor-framework|laude-institute|terminal[-_]bench)[^\s"'`)\\]*/gi

// Reading the repo root is bad; reading these paths is unambiguous oracle access.
const ORACLE_PATH = /(?:tests?\/|test_outputs|solution|solve\.sh|answer|expected)/i

const trials = []
for (const job of readdirSync(jobsDir)) {
  const jobPath = join(jobsDir, job)
  let st
  try { st = statSync(jobPath) } catch { continue }
  if (!st.isDirectory()) continue
  for (const t of readdirSync(jobPath)) {
    if (!t.includes('__')) continue
    const log = join(jobPath, t, 'agent', 'claude-code.txt')
    if (existsSync(log)) trials.push({ job, trial: t, log })
  }
}

if (trials.length === 0) {
  console.error(`[contamination] no trial transcripts under ${jobsDir}`)
  process.exit(2)
}

let confirmed = 0
let attempted = 0

for (const { job, trial, log } of trials) {
  let text
  try { text = readFileSync(log, 'utf8') } catch { continue }

  const hits = new Map() // url -> {oracle, got200}

  // ⛔ ONLY URLs THE AGENT ITSELF REQUESTED COUNT. Scanning the whole
  // transcript conflates a URL the agent ASKED FOR with one that merely came
  // back inside a search result, and the difference is the whole point.
  //
  // MEASURED while writing this: `build-pov-ray` (a PASS in the live sweep)
  // was flagged because a WebSearch for POV-Ray build docs returned two
  // spylab.ai pages presenting themselves as notes for the Terminal-Bench
  // `build-pov-ray` task. The agent never fetched them — it flagged them
  // itself, noting they "push a command that pipes a remote shell script into
  // bash". Reporting that as contamination would be exactly backwards, and a
  // checker with false positives is one the operator learns to skip.
  //
  // So: request position only. WebFetch's `url` argument, and URLs inside a
  // Bash command's curl/wget. A WebSearch QUERY is not a fetch — searching for
  // a topic retrieves nothing privileged; acting on a result would appear here
  // as a subsequent WebFetch or curl, which is what gets caught.
  const requested = []
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const blocks = entry?.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type !== 'tool_use') continue
      if (b.name === 'WebFetch' && typeof b.input?.url === 'string') {
        requested.push(b.input.url)
      } else if (b.name === 'Bash' && typeof b.input?.command === 'string') {
        if (/\b(?:curl|wget|git\s+clone|pip\s+download)\b/.test(b.input.command)) {
          for (const u of b.input.command.match(/https?:\/\/[^\s"'`)]+/g) || []) requested.push(u)
        }
      }
    }
  }

  for (const raw of requested) {
    BENCH_URL.lastIndex = 0
    if (!BENCH_URL.test(raw)) continue
    const url = raw.replace(/\\n.*$/, '').replace(/\\+$/, '')
    // A fetch result is rendered inline after the URL in the transcript, so a
    // status code trails it as `\n200` / `\n404` for curl-style calls.
    const at = text.indexOf(url)
    const tail = at >= 0 ? text.slice(at, at + url.length + 12) : ''
    const prev = hits.get(url) || { oracle: ORACLE_PATH.test(url), got200: false }
    // WebFetch returns content with no status line: a requested benchmark URL
    // that is not provably a 4xx/5xx is treated as FETCHED. Fail closed — an
    // under-reported CONFIRMED is a published invalid submission.
    if (/\\n2\d\d\b/.test(tail) || !/\\n[45]\d\d\b/.test(tail)) prev.got200 = true
    hits.set(url, prev)
  }
  if (hits.size === 0) continue

  const got = [...hits.entries()].filter(([, v]) => v.got200)
  const oracleGot = got.filter(([u]) => ORACLE_PATH.test(u))
  const level = oracleGot.length ? 'CONFIRMED' : got.length ? 'CONFIRMED' : 'ATTEMPTED'

  if (level === 'CONFIRMED') confirmed++
  else attempted++

  if (!quiet) {
    console.log(`[contamination] ${level}  ${job}/${trial}`)
    for (const [u, v] of hits) {
      console.log(`    ${v.got200 ? 'FETCHED ' : 'probed  '}${ORACLE_PATH.test(u) ? '[oracle] ' : ''}${u}`)
    }
  }
}

const verdict = confirmed > 0 || (strict && attempted > 0)
console.log(
  `[contamination] ${trials.length} trial(s) scanned in ${jobsDir}: ` +
    `${confirmed} CONFIRMED, ${attempted} ATTEMPTED` +
    (verdict ? (advisory ? '  -> CONTAMINATED (advisory, not blocking)' : '  -> REFUSING') : '  -> clean')
)
if (confirmed > 0) {
  console.error(
    advisory
      ? '[contamination] a CONFIRMED trial read the benchmark\'s own repo. This run is NOT blocked, but that trial must be excluded from any submission.'
      : '[contamination] a CONFIRMED trial read the benchmark\'s own repo. It must be excluded from any submission.'
  )
}
process.exit(verdict ? 1 : 0)
