/**
 * The purity gate must catch an ANSWER FINGERPRINT that names no task.
 *
 * WHY THIS FAILS ON THE PRE-CHANGE TREE: `store-purity-check.mjs` scanned for
 * task DIRECTORY NAMES only, so a lesson carrying a task's solution constants
 * without naming the task certified the store CLEAN.
 *
 * MEASURED 2026-09-01 on the live bench store. Memory 26496 held
 *   "the image sits at 0x400000 and EVERY key is off by that"
 *   "Skip disassembly and section-by-section work entirely"
 *   "drop words >= 0x80000000 ... cost ~7%"
 * and named no task directory. Across all 34 extract-elf trials in the repo:
 * that lesson present in the trajectory -> 0/15 passes; absent -> 14/19
 * (73.7%). A stored answer that is WRONG is worse than no memory at all.
 *
 * WHY THE SIGNAL IS TAGS AND NOT CONTENT: scanning content for long hex flags
 * 33 of 2192 rows, nearly all benign (CSS colour tokens from the app's own
 * design work, a Windows error code from a session note). Scanning TAGS flags
 * exactly one — the real contaminant. A gate that cries wolf gets waved through.
 *
 * Hermetic: builds its own SQLite store and task tree in a temp dir. No brain,
 * no network, and it NEVER touches the real bench store.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHECK = new URL('./store-purity-check.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** Build a throwaway store + task tree; returns {dataDir, tasksDir}. */
function fixture(rows, prompts = { 'sample-task': 'Write /app/out.txt with the parsed values.' }) {
  const base = mkdtempSync(join(tmpdir(), 'purity-fp-'))
  const dataDir = join(base, 'data')
  const tasksDir = join(base, 'tasks')
  mkdirSync(dataDir, { recursive: true })
  for (const [name, text] of Object.entries(prompts)) {
    mkdirSync(join(tasksDir, name), { recursive: true })
    writeFileSync(join(tasksDir, name, 'instruction.md'), text)
  }
  const db = new DatabaseSync(join(dataDir, 'memory.db'))
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, tags TEXT)')
  for (const r of rows) {
    db.prepare('INSERT INTO memories (id, content, tags) VALUES (?, ?, ?)').run(r.id, r.content, r.tags)
  }
  db.close()
  return { dataDir, tasksDir }
}

function run({ dataDir, tasksDir }) {
  try {
    const stdout = execFileSync(process.execPath, [CHECK, '--data-dir', dataDir, '--tasks', tasksDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

test('a magic constant used as a TAG is refused even when no task is named', () => {
  const res = run(
    fixture([
      {
        id: 26496,
        content: 'the image sits at 0x400000 and EVERY key is off by that. Skip disassembly entirely.',
        tags: 'elf,binary-parsing,pie,load-base,0x400000,angr',
      },
    ]),
  )
  assert.equal(res.code, 3, `must refuse; got exit ${res.code}\n${res.out}`)
  assert.match(res.out, /0x400000/)
  assert.match(res.out, /SOLVED for/)
})

test('a constant the task prompt itself states is NOT an answer fingerprint', () => {
  // Provenance is the whole doctrine: a value the agent could legitimately READ
  // is not a value it solved for. Without this the gate would refuse stores
  // whose lessons quote the prompt.
  const res = run(
    fixture(
      [{ id: 1, content: 'The prompt gives the load base directly.', tags: 'notes,0xdeadbeef' }],
      { 'sample-task': 'The image is loaded at 0xdeadbeef; parse from there.' },
    ),
  )
  assert.equal(res.code, 0, `a prompt-stated constant must pass; got exit ${res.code}\n${res.out}`)
})

test('benign hex in CONTENT does not trip the gate', () => {
  // The measured false-positive set: 33 of 2192 rows carry long hex in content,
  // nearly all CSS colours and error codes. Scanning content would flag them all.
  const res = run(
    fixture([
      { id: 2, content: 'Design tokens: --ts-fg 0x9aa3ad, --ts-bg 0xf9fafb. Windows exit 0xc0000142.', tags: 'design,css' },
    ]),
  )
  assert.equal(res.code, 0, `benign content hex must pass; got exit ${res.code}\n${res.out}`)
})

test('the name-based check still fires — the new check does not replace it', () => {
  const res = run(fixture([{ id: 3, content: 'notes about sample-task and its layout', tags: 'notes' }]))
  assert.equal(res.code, 3, `a task-naming row must still be refused; got ${res.code}\n${res.out}`)
  assert.match(res.out, /name a benchmark task/)
})
