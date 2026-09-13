#!/usr/bin/env node
/**
 * `extract-deliverables.mjs` — recover the files an agent actually WROTE from a
 * finished trial, so a failure can be diagnosed without re-running it.
 *
 *   usage: node extract-deliverables.mjs <trial-dir> [--out <dir>]
 *
 * ⛔ THE GAP THIS CLOSES: THE DELIVERABLE IS NOT IN THE TRIAL DIRECTORY.
 *
 * A finished trial keeps `verifier/` (the grade) and `agent/` (the transcript).
 * The thing the grader actually judged — the file the agent wrote, e.g.
 * `/app/filter.py` — lived in the container and dies with it. The task's own
 * `task.toml` decides what is copied out via `artifacts = [...]`, that file
 * belongs to the benchmark rather than to us, and editing it would be tampering
 * with the task definition. So the deliverable cannot be preserved that way and
 * should not be.
 *
 * It is not lost, though: the agent adapter records every write into
 * `agent/trajectory.json`, where the content sits inside a `[metadata] {...}`
 * block attached to the tool result. This reads it back out — and, since the
 * same file also records every `Bash` call the agent made, it replays those in
 * the same order, because a file written through the tool and then patched
 * through the shell is not what the tool recorded.
 *
 * WHY IT IS WORTH A FILE. Diagnosing the 2026-09-01 `filter-js-from-html`
 * failure meant hand-walking a 400 KB trajectory to find one 15 KB string
 * before any analysis could start. The grade says a check failed; only the
 * deliverable says why. A discovery loop that must decide WHERE TO FIX cannot
 * run on the score alone, and re-running a trial to see the artefact costs
 * real money and reproduces nothing (a fresh trial writes a different file).
 *
 * READ-ONLY AND OFFLINE. It opens one JSON file and, with `--out`, writes
 * copies. It never contacts the brain, never mutates the trial, and records
 * nothing — so pointing it at a trial cannot alter a measurement.
 *
 * ⛔ THE ONE PROCESS IT SPAWNS, AND ITS LEASH. A recorded `sed -i` is replayed
 * through the REAL `sed` rather than through a reimplementation of its regex
 * dialect — but with the script passed as `-e` arguments over STDIN, never
 * through a shell, never with the agent's file arguments, and only when every
 * script is a plain substitution or deletion. Anything that can open a file
 * (`w`, `r`, `e`) or change matching (`-n`, `-E`) is refused and the record is
 * flagged instead. A diagnostic tool that can be made to write files by the
 * artefact it is diagnosing is not a diagnostic tool. Heredocs and Python
 * self-writes are NEVER executed: their bytes are unrecoverable, and the honest
 * output is `fidelity:'incomplete'`, not a confident file.
 *
 * ⛔ WHAT IT MUST NOT BECOME. This exists to diagnose OUR harness, not to mine
 * graded trials for task answers. What it recovers is the agent's own output,
 * which the agent already had; that is not answer-key material. The verifier's
 * expectations are, and this deliberately does not read `verifier/` at all
 * (`rules/bench-agi-purity.md`, and the self-seeding incident recorded in
 * `project_tbench_agent_self_seeded_answer_key`).
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, sep } from 'node:path'

const MARKER = '[metadata] '

/**
 * Every `[metadata] {...}` object embedded in a string.
 *
 * Brace-balanced rather than "parse from `{` to the end": the marker is not
 * always last in its string, and a `{` or `}` inside the file's own content
 * would break a naive scan. String state and escapes are tracked so a brace in
 * a Python dict literal or a regex cannot end the object early.
 */
export function parseMetadataBlocks(text) {
  const out = []
  const s = String(text ?? '')
  let from = 0
  for (;;) {
    const m = s.indexOf(MARKER, from)
    if (m < 0) break
    const open = s.indexOf('{', m + MARKER.length)
    if (open < 0) break
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let i = open; i < s.length; i++) {
      const c = s[i]
      if (esc) {
        esc = false
        continue
      }
      if (inStr) {
        if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end < 0) break
    try {
      out.push(JSON.parse(s.slice(open, end)))
    } catch {
      // A block we cannot parse is skipped rather than fatal: recovering three
      // of four deliverables beats refusing to recover any.
    }
    from = end
  }
  return out
}

/** Deep-walk any value, yielding every string. */
function* strings(value) {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) yield* strings(v)
  }
}

/**
 * Apply one recorded Edit to a buffer.
 *
 * @returns {{content: string, ok: boolean}} `ok:false` is a NOMATCH — recorded
 *   by the caller, never swallowed.
 *
 * `split`/`join` and an index splice rather than `String.replace`, because a
 * `$&` or `$1` in the replacement text is a substitution pattern to `replace`
 * and ordinary bytes to a deliverable. A Python regex or a shell script in the
 * newString would otherwise be silently mangled.
 */
function applyEdit(buffer, oldString, newString, replaceAll) {
  if (oldString === '') return { content: buffer, ok: false }
  const at = buffer.indexOf(oldString)
  if (at < 0) return { content: buffer, ok: false }
  if (replaceAll) return { content: buffer.split(oldString).join(newString), ok: true }
  return {
    content: buffer.slice(0, at) + newString + buffer.slice(at + oldString.length),
    ok: true,
  }
}

/** Regex-safe form of an arbitrary container path. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every spelling of a deliverable a shell command might use.
 *
 * ⛔ THE ABSOLUTE PATH ALONE MISSES THE REAL SELF-PATCHES. The metadata history
 * records `/app/convert_masks.py`; the agents that patched it wrote
 * `open('convert_masks.py','w')` and `sed -i ... convert_masks.py` from cwd
 * `/app`. MEASURED on the two worked trials: matching the absolute form only
 * counts 0 of 2 and 0 of 10 self-patches, so the tool called both stale files
 * final. The relative form under the step's recorded cwd, the `./` form, and
 * the bare basename are therefore all matched.
 *
 * The basename is the loose one and is deliberately kept: `extra.cwd` is absent
 * on some steps (every `user` step in the real trajectories), and a fidelity
 * flag that silently reverts to absolute-only is the defect being repaired. The
 * cost of the looseness is a possible flag on a same-named file in another
 * directory — a warning that the bytes may be stale, never a changed byte.
 */
export function pathSpellings(path, cwd) {
  const abs = String(path ?? '')
  if (!abs) return []
  const out = new Set([abs])
  const base = abs.split(/[/\\]+/).filter(Boolean).pop()
  if (base) {
    out.add(base)
    out.add(`./${base}`)
  }
  const dir = typeof cwd === 'string' && cwd ? cwd.replace(/\/+$/, '') : null
  if (dir && abs.startsWith(`${dir}/`)) {
    const rel = abs.slice(dir.length + 1)
    out.add(rel)
    out.add(`./${rel}`)
  }
  return [...out]
}

/**
 * Does this shell command WRITE to `path` (under any of its spellings)?
 *
 * Deliberately narrow on the VERB and deliberately broad on the NAME. A
 * fidelity warning that fires on `cat`, `ls` or prose naming the file is one
 * nobody reads, so only a redirect, a `tee`, an in-place `sed`, or a Python
 * `open(..., 'w'/'a')` / `.write(` against that name counts.
 */
export function bashWritesTo(command, path, cwd = null) {
  const cmd = String(command ?? '')
  return pathSpellings(path, cwd).some((spelling) => {
    const p = escapeRe(spelling)
    return (
      new RegExp(`(?:^|[^>\\w])>>?\\s*["']?${p}(?![\\w./-])`).test(cmd) ||
      new RegExp(`tee\\s+(?:-a\\s+)?["']?${p}(?![\\w./-])`).test(cmd) ||
      new RegExp(`sed\\s+[^\\n|;&]*-i[^\\n|;&]*(?:^|[\\s"'])${p}(?![\\w./-])`).test(cmd) ||
      new RegExp(`open\\(\\s*["']${p}["']\\s*,\\s*["'][wax]`).test(cmd) ||
      new RegExp(`open\\(\\s*["']${p}["'][^)]*\\)[\\s\\S]{0,160}\\.write\\(`).test(cmd)
    )
  })
}

/**
 * A shell word split that understands the two quote forms, so a script argument
 * containing spaces stays one token.
 *
 * Not a shell parser and does not try to be: it exists only to pull the
 * arguments of one `sed` invocation out of a command line. Anything it cannot
 * tokenise cleanly ends up NOT eligible for replay, which is the safe direction.
 */
function shellWords(segment) {
  const out = []
  let cur = ''
  let quote = null
  let started = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += c
  }
  if (started || cur) out.push(cur)
  return quote ? null : out
}

/**
 * Only substitution and deletion. Anything that can OPEN A FILE (`w`, `W`, `r`,
 * `R`) or run a command (`e`) is refused.
 *
 * ⛔ THIS IS A WHITELIST BECAUSE THE INPUT IS AGENT-AUTHORED. The replay runs a
 * real binary over text an arbitrary agent wrote; `sed -e 'w /somewhere'` writes
 * a file, and a diagnostic tool that can be made to write files by the artefact
 * it is diagnosing is not a diagnostic tool. A script outside the whitelist is
 * treated exactly like a heredoc: unreconstructable, and flagged.
 */
const SAFE_SED_SCRIPT = /^\s*(?:\d+(?:\s*,\s*(?:\d+|\$))?\s*)?(?:s(.)(?:\\.|(?!\1)[^\n])*\1(?:\\.|(?!\1)[^\n])*\1[gIipm0-9]*|d)\s*(?:;\s*)?$/

/**
 * The `-e` scripts of an in-place `sed` against `path`, or null when this
 * command is not a replayable `sed -i` on it.
 */
export function sedProgramFor(command, path, cwd = null) {
  const cmd = String(command ?? '')
  const spellings = new Set(pathSpellings(path, cwd))
  // One command line can hold several invocations; look at each segment between
  // the shell's own separators.
  for (const segment of cmd.split(/(?:&&|\|\||[;|\n])/)) {
    const words = shellWords(segment.trim())
    if (!words) continue
    const at = words.indexOf('sed')
    if (at < 0) continue
    const args = words.slice(at + 1)
    const scripts = []
    const files = []
    let inPlace = false
    let bad = false
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '-e' || a === '--expression') {
        const next = args[++i]
        if (typeof next !== 'string') bad = true
        else scripts.push(next)
      } else if (a === '-i' || a.startsWith('-i') || a.startsWith('--in-place')) {
        inPlace = true
        // `sed -i.bak` keeps a backup; the in-place edit is the same.
      } else if (a === '-n' || a === '-E' || a === '-r' || a === '--regexp-extended') {
        // A flag that changes matching, not writing. Refused rather than
        // guessed at, so the replayed bytes cannot silently differ.
        bad = true
      } else if (a.startsWith('-')) {
        bad = true
      } else if (!scripts.length) {
        scripts.push(a)
      } else {
        files.push(a)
      }
    }
    if (bad || !inPlace || !scripts.length) continue
    if (!files.some((f) => spellings.has(f))) continue
    if (!scripts.every((s) => SAFE_SED_SCRIPT.test(s))) return null
    return scripts
  }
  return null
}

/**
 * Run the recorded `sed` program over the replayed buffer, through the real
 * `sed` — never through a reimplementation of its regex dialect, and never
 * through a shell.
 *
 * @returns {{content: string, ok: boolean, why: string|null}}
 */
export function replaySed(buffer, scripts) {
  const bin = sedBinary()
  if (!bin) return { content: buffer, ok: false, why: 'no sed binary on PATH' }
  const args = []
  for (const s of scripts) args.push('-e', s)
  const r = spawnSync(bin, args, { input: buffer, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    return { content: buffer, ok: false, why: r.error?.message ?? `sed exited ${r.status}` }
  }
  return { content: r.stdout, ok: true, why: null }
}

/** `sed`, wherever this machine keeps it. */
let SED_BIN
function sedBinary() {
  if (SED_BIN !== undefined) return SED_BIN
  const candidates = [
    process.env.TB_SED,
    'sed',
    'C:/Program Files/Git/usr/bin/sed.exe',
    'C:/Program Files (x86)/Git/usr/bin/sed.exe',
  ].filter(Boolean)
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['-e', 's/a/b/'], { input: 'a', encoding: 'utf8' })
    if (!probe.error && probe.status === 0) {
      SED_BIN = bin
      return SED_BIN
    }
  }
  SED_BIN = null
  return SED_BIN
}

/** Every Bash command issued in one trajectory step, with the step's cwd. */
export function bashCommandsIn(step) {
  const cwd = typeof step?.extra?.cwd === 'string' ? step.extra.cwd : null
  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
  return calls
    .filter((c) => c?.function_name === 'Bash' && typeof c?.arguments?.command === 'string')
    .map((c) => ({ command: c.arguments.command, cwd }))
}

/**
 * The final content of every file the agent wrote, REPLAYED in step order —
 * metadata writes, metadata edits AND the shell commands between them.
 *
 * LAST WRITE WINS, which is the whole point: an agent that creates a file and
 * then edits it four times produces five blocks for one path, and only the last
 * state is what the grader saw. Returning the first — or all five — would
 * describe a file that never existed at grading time.
 *
 * ⛔ AND UNTIL 2026-09-12 THAT IS EXACTLY WHAT THIS RETURNED. The loop skipped
 * every block without a string `content` field, and Claude Code's Edit tool
 * records `{filePath, oldString, newString, replaceAll}` and NO content. So the
 * whole edit history was dropped and the FIRST DRAFT was reported as the graded
 * file, confidently and silently.
 *
 * MEASURED across 7 scripted trials: 6 were recovered as the WRONG BYTES, and
 * the only correct one was the single trial that made zero Edit calls. One stale
 * recovery flipped a PASS to a FAIL (0.478427 stale against 0.506372 true) and
 * three reported the wrong failing row. Every post-trial metric computed through
 * this tool inherited those bytes, which is why the replay is the precondition
 * for the metrics rather than a nicety.
 *
 * ⛔ THE SHELL IS PART OF THE HISTORY, AND THE ANCHOR IS THE LAST FULL WRITE.
 * A `Write` re-establishes the entire buffer, so a shell patch before it cannot
 * matter; an `Edit` only splices, so a shell patch before the LAST EDIT is still
 * missing from the replayed bytes. MEASURED on sam-cell-seg__BJKtCet (2
 * self-patches) and sam-cell-seg__ZPfVk2c (10): every one of them falls after
 * the single `Write` and before the last `Edit` — the exact window the earlier
 * "after the last metadata event" rule excluded, which is why it counted zero on
 * both. A `sed -i` in that window IS replayed (its script is fully recorded);
 * a heredoc or a Python self-write is not, and marks the record incomplete.
 *
 * A MISS IS RECORDED, NEVER SILENT. An Edit whose `oldString` is not in the
 * buffer (a malformed block, or a write this record never saw) increments
 * `nomatch` and marks the record `fidelity:'incomplete'`. Falling back to the
 * previous buffer quietly would reintroduce the exact defect being fixed: a
 * file reported as final that is not what the grader judged.
 */
export function extractDeliverables(trajectory) {
  const byPath = new Map()
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : []
  steps.forEach((step, index) => {
    const stepId = typeof step?.step_id === 'number' ? step.step_id : index + 1
    for (const s of strings(step)) {
      if (!s.includes(MARKER)) continue
      for (const meta of parseMetadataBlocks(s)) {
        const path = meta?.filePath
        if (typeof path !== 'string' || !path) continue
        const isWrite = typeof meta.content === 'string'
        const isEdit = !isWrite && typeof meta.oldString === 'string'
        // A block that is neither (an `structuredPatch`-only record, a rename,
        // a read) describes no byte of the deliverable and must not create one.
        if (!isWrite && !isEdit) continue
        const rec = record(byPath, path, stepId)
        if (isWrite) {
          rec.content = meta.content
          rec.writes += 1
          // ⛔ THE BUFFER IS KNOWN AGAIN. Everything the shell did to this path
          // before now is overwritten, so the unreconstructable count resets —
          // otherwise the flag fires on every trial that ever touched a shell.
          rec.unrecoverable = 0
          rec.lateWrites = 0
          rec.nomatch = 0
        } else {
          rec.edits += 1
          const { content, ok } = applyEdit(
            rec.content,
            meta.oldString,
            typeof meta.newString === 'string' ? meta.newString : '',
            Boolean(meta.replaceAll),
          )
          // A newString that is not a string is a malformed block, not an empty
          // replacement: applying it would DELETE bytes on the strength of a
          // shape we do not understand.
          if (ok && typeof meta.newString === 'string') rec.content = content
          else {
            rec.nomatch += 1
            rec.unrecoverable += 1
          }
        }
        if (typeof meta.type === 'string') rec.type = meta.type
        rec.step = stepId
      }
    }
    // The shell, AFTER this step's recorded tool results. A step that both wrote
    // through the tool and patched through the shell is genuinely ambiguous in
    // the record, and the conservative reading — the shell went last — is the
    // one that flags rather than the one that reassures.
    for (const { command, cwd } of bashCommandsIn(step)) {
      for (const rec of byPath.values()) {
        if (!bashWritesTo(command, rec.path, cwd)) continue
        const scripts = sedProgramFor(command, rec.path, cwd)
        if (scripts) {
          const { content, ok } = replaySed(rec.content, scripts)
          if (ok) {
            rec.content = content
            rec.sedReplays += 1
            rec.step = stepId
            continue
          }
        }
        rec.lateWrites += 1
        rec.unrecoverable += 1
        rec.step = stepId
      }
    }
  })
  return auditFidelity([...byPath.values()])
}

function record(byPath, path, stepId) {
  let rec = byPath.get(path)
  if (!rec) {
    rec = {
      path,
      content: '',
      type: 'unknown',
      step: stepId,
      writes: 0,
      edits: 0,
      nomatch: 0,
      sedReplays: 0,
      lateWrites: 0,
      unrecoverable: 0,
      fidelity: 'complete',
    }
    byPath.set(path, rec)
  }
  return rec
}

/**
 * Raw-Bash writes to each path that the metadata replay cannot reconstruct.
 *
 * Takes the PARSED TRAJECTORY — the same object `extractDeliverables` reads —
 * rather than a transcript file. The first version scanned
 * `agent/claude-code.txt` for the metadata marker, which occurs ZERO times in
 * that file on every real trial, so its "after the last metadata event" window
 * was the whole transcript and its answer was 0 anyway.
 */
export function lateBashWrites(trajectory, paths) {
  const wanted = new Set(paths ?? [])
  const files = extractDeliverables(trajectory)
  const counts = new Map([...wanted].map((p) => [p, 0]))
  for (const f of files) if (wanted.has(f.path)) counts.set(f.path, f.lateWrites)
  return counts
}

/**
 * Mark each recovered file with whether its bytes can be trusted.
 *
 * A record with `fidelity:'incomplete'` must NEVER be called final by any caller
 * — that is the contract this function exists to state, and the reason the
 * printed output says so loudly rather than in a field nobody reads.
 *
 * Idempotent: it reads the counters and sets one field, so calling it twice
 * cannot downgrade a record or double anything.
 */
export function auditFidelity(files) {
  for (const f of files) {
    const unrecoverable = f.unrecoverable ?? (f.nomatch ?? 0) + (f.lateWrites ?? 0)
    f.lateWrites = f.lateWrites ?? 0
    f.sedReplays = f.sedReplays ?? 0
    f.fidelity = unrecoverable > 0 ? 'incomplete' : 'complete'
  }
  return files
}

/**
 * A container path turned into something safe to write under `outDir`.
 *
 * `..` segments are dropped and the root stripped, so a trajectory naming
 * `/../../etc/passwd` cannot escape the output directory. Trials are inputs
 * from an agent that ran arbitrary code, so this is not a formality.
 */
export function safeRelative(path) {
  const parts = String(path)
    .split(/[/\\]+/)
    .filter((p) => p && p !== '.' && p !== '..')
  return parts.length ? parts.join(sep) : 'unnamed'
}

function main() {
  const args = process.argv.slice(2)
  const trialDir = args.find((a) => !a.startsWith('--'))
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null
  if (!trialDir) {
    console.error('usage: extract-deliverables.mjs <trial-dir> [--out <dir>]')
    process.exit(2)
  }
  const traj = join(trialDir, 'agent', 'trajectory.json')
  if (!existsSync(traj)) {
    console.error(`[deliverables] no agent/trajectory.json under ${trialDir}`)
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(traj, 'utf8'))
  } catch (e) {
    console.error(`[deliverables] unreadable trajectory: ${e?.message ?? e}`)
    process.exit(1)
  }
  const files = extractDeliverables(parsed)
  if (!files.length) {
    console.log('[deliverables] none recorded — the agent wrote no files through a tool that logs content')
    return
  }
  // Everything — the writes, the edits AND the shell commands between them —
  // comes from the trajectory the replay already read. There is no second file
  // to anchor against, which is the repair: the earlier version looked for the
  // metadata marker in `agent/claude-code.txt`, where it never appears.
  for (const f of files) {
    console.log(
      `  ${String(f.content.length).padStart(7)} bytes  ${f.path}  (${f.writes} write${f.writes === 1 ? '' : 's'}, ` +
        `${f.edits} edit${f.edits === 1 ? '' : 's'}` +
        (f.sedReplays ? `, ${f.sedReplays} sed replay${f.sedReplays === 1 ? '' : 's'}` : '') +
        `, last at step ${f.step})`,
    )
  }
  const suspect = files.filter((f) => f.fidelity === 'incomplete')
  for (const f of suspect) {
    // ⛔ LOUD, BECAUSE THE ALTERNATIVE IS A CONFIDENT WRONG FILE. Six of seven
    // scripted trials were recovered as the wrong bytes before the replay
    // landed, and one of those stale recoveries flipped a PASS to a FAIL.
    console.log(
      `  ⚠ INCOMPLETE ${f.path} — ${f.nomatch} unmatched edit(s), ${f.lateWrites} unreconstructable raw-Bash ` +
        `write(s) since the last full write. These bytes are NOT what the grader judged; do not treat this ` +
        `file as final.`,
    )
  }
  if (!outDir) {
    console.log('\n[deliverables] pass --out <dir> to write these to disk')
    return
  }
  for (const f of files) {
    const dest = join(outDir, safeRelative(f.path))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.content)
    console.log(`  wrote ${dest}`)
  }
}

if (process.argv[1]?.endsWith('extract-deliverables.mjs')) main()
