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
 * artefact it is diagnosing is not a diagnostic tool. Nothing here EXECUTES a
 * heredoc or a Python self-write, ever — but a `cat`/`tee` heredoc does not
 * need executing, because its body sits verbatim in the transcript text. A
 * quoted delimiter (`'EOF'`, `"EOF"`, `\EOF`) means the shell performed no
 * expansion on it, so that text IS the file, recorded `fidelity:'heredoc'`; an
 * unquoted delimiter (`<<EOF`) means a `$VAR` or `` `cmd` `` inside the body
 * may have been expanded before the write, so the same text is still copied
 * out — it is the best evidence available — but flagged
 * `fidelity:'heredoc-unquoted'` rather than trusted outright. A heredoc or
 * literal redirect feeding any command OTHER than `cat`/`tee`/`printf`/`echo`,
 * and any write a Python (or other program) self-write performs on its own,
 * stay unrecoverable and `fidelity:'incomplete'` — see `heredocWritesIn`.
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

// ── BASH HEREDOC / LITERAL-REDIRECT RECOVERY ────────────────────────────────
//
// ⛔ 35.6% OF GRADED TRIALS HAD NO RECOVERABLE DELIVERABLE FOR EXACTLY THIS
// REASON. A precision measurement over 689 graded trials found 245 with no
// `fidelity !== 'incomplete'` deliverable because the agent wrote the file with
// `cat > /app/x.py <<'EOF' … EOF`, `tee path <<EOF`, or `printf`/`echo` into a
// redirect — none of which touch the Write/Edit tool `extractDeliverables`
// already replays. 9 of 11 ground-truth failures on two tasks were in that
// blind spot. Everything below is regex-driven scanning of the recorded
// COMMAND TEXT, never execution: a heredoc's body is copied out of the
// transcript, not run through a shell.

/** Index of the char right after the last top-level clause separator before `uptoIndex`, or 0. */
function clauseStart(line, uptoIndex) {
  let quote = null
  const end = Math.min(uptoIndex, line.length)
  let last = 0
  for (let i = 0; i < end; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      last = i + 2
      i++
      continue
    }
    if (c === ';' || c === '|') last = i + 1
  }
  return last
}

/** Index of the next top-level clause separator at or after `fromIndex`, or `line.length`. */
function clauseEnd(line, fromIndex) {
  let quote = null
  for (let i = Math.max(fromIndex, 0); i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) return i
    if (c === ';' || c === '|') return i
  }
  return line.length
}

/**
 * Where a `cat`/`tee` clause containing a heredoc actually writes, or null.
 *
 * Deliberately narrow to `cat` and `tee`: a heredoc feeding any OTHER command
 * (`python - <<EOF`, `node <<EOF`, `bc <<EOF`) writes through that program's
 * own logic, which this cannot see — the honest answer is no target, not a
 * guess. This is also why a `python3 - <<'PYX'` self-patch never produces a
 * fabricated deliverable: its head word is `python3`, not `cat`/`tee`.
 */
function heredocTarget(segment) {
  const words = shellWords(segment)
  if (!words || !words.length) return null
  const head = words[0]
  if (head === 'cat') {
    const m = segment.match(/(?:^|[^<>])(>{1,2})\s*(['"]?)([^\s'"<>|;&]+)\2/)
    if (!m) return null
    return { path: m[3], append: m[1] === '>>' }
  }
  if (head === 'tee') {
    let append = false
    let path = null
    for (let i = 1; i < words.length; i++) {
      const w = words[i]
      if (w === '-a' || w === '--append') {
        append = true
        continue
      }
      if (w.startsWith('-') || w.startsWith('<<')) continue
      path = w
      break
    }
    return path ? { path, append } : null
  }
  return null
}

// Not `<<<` (a here-string, single line, no body) at either boundary.
const HEREDOC_RE = /(?<!<)<<(?!<)(-)?[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?[A-Za-z_][\w]*))/g

/**
 * Every `cat`/`tee` heredoc write recorded in a Bash command, in the order the
 * heredocs start.
 *
 * The body is copied VERBATIM out of the transcript text between the header
 * line and the terminator line (leading tabs stripped per-line for `<<-`,
 * never for plain `<<`). A quoted delimiter (`'EOF'`, `"EOF"`, `\EOF`) means
 * the shell performed no expansion on the body, so this text IS the file
 * (`kind:'heredoc'`); a bare `<<EOF` means `$VAR`/`` `cmd` `` inside the body
 * may have changed before the real write, so the text is still the best
 * evidence available but marked `kind:'heredoc-unquoted'`.
 *
 * Scanning resumes AFTER the recovered body, never from wherever the regex
 * would naturally continue: the body is agent-authored text and can itself
 * contain `<<` (a bit-shift, a redirect inside a quoted example) that must not
 * be mistaken for the start of a new heredoc.
 */
export function heredocWritesIn(command) {
  const cmd = String(command ?? '')
  const events = []
  HEREDOC_RE.lastIndex = 0
  let m
  while ((m = HEREDOC_RE.exec(cmd))) {
    const dash = Boolean(m[1])
    let delimiter
    let quoted
    if (m[2] !== undefined) {
      delimiter = m[2]
      quoted = true
    } else if (m[3] !== undefined) {
      delimiter = m[3]
      quoted = true
    } else {
      const raw = m[4] ?? ''
      quoted = raw.startsWith('\\')
      delimiter = quoted ? raw.slice(1) : raw
    }
    const matchStart = m.index
    const afterDelim = HEREDOC_RE.lastIndex
    const lineStart = cmd.lastIndexOf('\n', matchStart) + 1
    let headerLineEnd = cmd.indexOf('\n', afterDelim)
    if (headerLineEnd < 0) headerLineEnd = cmd.length
    const bodyStart = headerLineEnd + 1

    // Body lines up to the terminator line (delimiter alone, tabs stripped
    // first when `<<-`). Not found before the command ends → not a real
    // heredoc as far as this can tell; do not fabricate a body for it.
    const lines = []
    let pos = bodyStart
    let terminatorEnd = -1
    while (pos <= cmd.length) {
      const nl = cmd.indexOf('\n', pos)
      const atEnd = nl < 0
      const rawLine = atEnd ? cmd.slice(pos) : cmd.slice(pos, nl)
      const compareLine = (dash ? rawLine.replace(/^\t+/, '') : rawLine).replace(/\r$/, '')
      if (compareLine === delimiter) {
        terminatorEnd = atEnd ? cmd.length : nl + 1
        break
      }
      lines.push(dash ? rawLine.replace(/^\t+/, '') : rawLine)
      if (atEnd) break
      pos = nl + 1
    }
    if (terminatorEnd < 0) {
      HEREDOC_RE.lastIndex = cmd.length
      continue
    }

    const headerLine = cmd.slice(lineStart, headerLineEnd)
    const segStart = clauseStart(headerLine, matchStart - lineStart)
    const segEnd = clauseEnd(headerLine, afterDelim - lineStart)
    const target = heredocTarget(headerLine.slice(segStart, segEnd))
    if (target) {
      events.push({
        path: target.path,
        append: target.append,
        content: lines.length ? `${lines.join('\n')}\n` : '',
        kind: quoted ? 'heredoc' : 'heredoc-unquoted',
      })
    }
    HEREDOC_RE.lastIndex = terminatorEnd
  }
  return events
}

/**
 * Every single-quoted `printf`/`echo` literal write recorded in a Bash
 * command.
 *
 * Deliberately narrow to the exact single-quoted spelling — `echo '…' > path`,
 * `printf '%s' '…' > path` — rather than every printf/echo invocation: an
 * unquoted or double-quoted argument carries the same `$VAR`-expansion risk as
 * an unquoted heredoc, and a `-e` echo or a `%d`/`%x` printf format
 * REINTERPRETS its argument instead of emitting it verbatim. Matching those too
 * would confidently report the wrong bytes; the honest answer for them is no
 * event, same as for a heredoc feeding a non-`cat`/`tee` command.
 */
export function literalRedirectWritesIn(command) {
  const cmd = String(command ?? '')
  const events = []
  for (const segment of cmd.split(/(?:&&|\|\||[;|\n])/)) {
    const echo = segment.match(/^\s*echo\s+'([^']*)'\s*(>{1,2})\s*(['"]?)([^\s'"<>|;&]+)\3\s*$/)
    if (echo) {
      events.push({ path: echo[4], append: echo[2] === '>>', content: `${echo[1]}\n`, kind: 'heredoc' })
      continue
    }
    const pf = segment.match(/^\s*printf\s+'%s'\s+'([^']*)'\s*(>{1,2})\s*(['"]?)([^\s'"<>|;&]+)\3\s*$/)
    if (pf) events.push({ path: pf[4], append: pf[2] === '>>', content: pf[1], kind: 'heredoc' })
  }
  return events
}

/** `path`, resolved against `cwd` when it is not already absolute. */
function resolveWritePath(path, cwd) {
  if (path.startsWith('/')) return path
  if (typeof cwd === 'string' && cwd) {
    const base = cwd.replace(/\/+$/, '')
    return `${base}/${path.replace(/^\.\//, '')}`
  }
  return path
}

/** The tracked record `rawPath` (as spelled in a command) refers to, if any. */
function findRecordFor(byPath, rawPath, cwd) {
  for (const rec of byPath.values()) {
    if (pathSpellings(rec.path, cwd).includes(rawPath)) return rec
  }
  return null
}

/**
 * Apply one heredoc/literal write event to `byPath`, creating the record when
 * no existing entry — tool-written or previously heredoc-written — already
 * claims this spelling. Reuses `pathSpellings`/cwd resolution so a relative
 * `cat > z.py <<EOF` merges into the SAME record as a later absolute
 * `/app/z.py` Write, exactly as `bashWritesTo` already does for flagging.
 *
 * An OVERWRITE (`>`) resets `unrecoverable` exactly like a tool `Write` does:
 * the full buffer is known again, verbatim for a quoted delimiter, best-effort
 * for an unquoted one. An APPEND (`>>`) does not — it is only ever certain
 * about the bytes it adds, not about whatever the buffer already held.
 */
function applyLiteralWrite(byPath, event, cwd, stepId) {
  const resolved = resolveWritePath(event.path, cwd)
  const rec = findRecordFor(byPath, event.path, cwd) ?? record(byPath, resolved, stepId)
  if (event.append) {
    rec.content += event.content
  } else {
    rec.content = event.content
    rec.unrecoverable = 0
    rec.lateWrites = 0
    rec.nomatch = 0
  }
  rec.writeKind = event.kind
  rec.step = stepId
  return rec
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
 * so, as of 2026-09-14, is a `cat`/`tee` heredoc or a single-quoted
 * `printf`/`echo` redirect — see `heredocWritesIn`/`literalRedirectWritesIn`.
 * A heredoc feeding any OTHER command, or a Python self-write, is still not,
 * and still marks the record incomplete.
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
          // A tool Write outranks anything a prior heredoc/literal redirect
          // established for this same path — the origin of the FINAL bytes is
          // the tool, not the shell.
          rec.writeKind = 'tool'
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
      // Heredoc/literal writes FIRST, so a same-command `sed -i` that follows
      // them (below) replays against the content they just established rather
      // than against stale or empty content. KNOWN LIMITATION: if the shell
      // order is reversed — a `sed -i` textually BEFORE a heredoc write to the
      // same path, in the same recorded command — this still applies the
      // heredoc's full overwrite last, so the final BYTES come out right, but
      // the sed is not counted as a taint on the intermediate state. Not
      // observed in any real trial scanned for this change; every real
      // heredoc write precedes its later edits, never follows them.
      const handled = new Set()
      for (const event of [...heredocWritesIn(command), ...literalRedirectWritesIn(command)]) {
        handled.add(applyLiteralWrite(byPath, event, cwd, stepId))
      }
      for (const rec of byPath.values()) {
        // A `sed -i` is checked FIRST and independently of the "already
        // handled by heredoc" guard below: it is its own targeted match
        // (command + this exact path), so a heredoc write followed by a sed
        // in the SAME recorded command (write the script, then patch it) is
        // still replayed correctly rather than skipped as "already handled".
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
        // Already accounted for by the heredoc/literal replay above — do not
        // ALSO run the GENERIC bashWritesTo check, which would see the same
        // `> path` text and double-flag a write this pass just reconstructed.
        if (handled.has(rec)) continue
        if (!bashWritesTo(command, rec.path, cwd)) continue
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
      // 'tool' (Write/Edit), 'heredoc' (quoted cat/tee/printf/echo) or
      // 'heredoc-unquoted' (unquoted delimiter) — see `auditFidelity`.
      writeKind: 'tool',
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
 * Four values. `complete` — Write/Edit only, as before this file recovered
 * heredocs. `heredoc` — the last write establishing/appending to the buffer
 * was a QUOTED `cat`/`tee`/`printf`/`echo` redirect, byte-exact. `heredoc-
 * unquoted` — same, but the delimiter was bare, so shell expansion may have
 * changed the real bytes. `incomplete` — as before: some write since the last
 * FULL write is unrecoverable, and this record must NEVER be treated as final.
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
    if (unrecoverable > 0) f.fidelity = 'incomplete'
    else if (f.writeKind === 'heredoc' || f.writeKind === 'heredoc-unquoted') f.fidelity = f.writeKind
    else f.fidelity = 'complete'
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
        `, last at step ${f.step}, fidelity ${f.fidelity})`,
    )
  }
  const unquoted = files.filter((f) => f.fidelity === 'heredoc-unquoted')
  for (const f of unquoted) {
    console.log(
      `  ~ UNQUOTED HEREDOC ${f.path} — recovered from an unquoted <<DELIM, so a $VAR or backtick ` +
        'command substitution inside the body may have been expanded before the real write. Best-effort, not exact.',
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
