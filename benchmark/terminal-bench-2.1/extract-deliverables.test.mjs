/**
 * Tests for `extract-deliverables.mjs`.
 *
 * WHY THESE FAIL ON THE PRE-CHANGE TREE: the module did not exist, so the
 * import throws and every test errors. Beyond that trivial sense, each case
 * below pins a specific decision that a plausible simpler implementation gets
 * wrong — noted per test.
 *
 * Hermetic: string fixtures only. No trial dir, no brain, no docker.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMetadataBlocks, extractDeliverables, safeRelative } from './extract-deliverables.mjs'

/** Build the tool-result string shape the agent adapter actually records. */
const block = (meta) => `File created successfully at: ${meta.filePath}\n\n[metadata] ${JSON.stringify(meta)}`

test('a brace inside file content does not end the metadata object early', () => {
  // FAILS with the obvious implementation: parsing from the first `{` to the
  // LAST `}`, or to the end of the string, mis-slices as soon as the file being
  // recovered contains braces — which every Python or JS deliverable does.
  const content = 'def f():\n    d = {"a": {"b": 1}}\n    return d\n'
  const [meta] = parseMetadataBlocks(block({ type: 'create', filePath: '/app/f.py', content }))
  assert.equal(meta.content, content)
})

test('a brace inside a STRING in the content cannot end the object', () => {
  // FAILS on a brace-counting scan that ignores string state: the unbalanced
  // `}` inside this regex literal drives the depth negative and truncates.
  const content = 'RE = re.compile(r"\\\\}[^{]*")\n'
  const [meta] = parseMetadataBlocks(block({ type: 'create', filePath: '/app/g.py', content }))
  assert.equal(meta.content, content)
})

test('metadata that is not last in its string is still found', () => {
  // FAILS on "slice from the marker to the end of the string".
  const meta = { type: 'create', filePath: '/app/a.py', content: 'x = 1\n' }
  const s = `${block(meta)}\n\nSome trailing narration from the harness.`
  const found = parseMetadataBlocks(s)
  assert.equal(found.length, 1)
  assert.equal(found[0].content, 'x = 1\n')
})

test('several metadata blocks in one string are all recovered', () => {
  const s = [
    block({ type: 'create', filePath: '/app/a.py', content: 'a\n' }),
    block({ type: 'create', filePath: '/app/b.py', content: 'b\n' }),
  ].join('\n---\n')
  assert.equal(parseMetadataBlocks(s).length, 2)
})

test('an unparseable block is skipped, not fatal', () => {
  const s = `[metadata] {"filePath": "/app/broken.py", "content": }\n${block({
    type: 'create',
    filePath: '/app/ok.py',
    content: 'ok\n',
  })}`
  const found = parseMetadataBlocks(s)
  assert.equal(found.length, 1)
  assert.equal(found[0].filePath, '/app/ok.py')
})

test('LAST write wins — the grader saw the final content, not the first', () => {
  // FAILS on first-write-wins or on collecting every version: an agent that
  // creates then edits a file produces several blocks for one path, and
  // reporting the draft would describe a file that never existed at grading.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/f.py', content: 'draft\n' }) },
      { step_id: 2, message: block({ type: 'update', filePath: '/app/f.py', content: 'final\n' }) },
    ],
  }
  const files = extractDeliverables(traj)
  assert.equal(files.length, 1)
  assert.equal(files[0].content, 'final\n')
  assert.equal(files[0].writes, 2)
  assert.equal(files[0].step, 2)
})

test('content is found however deeply it is nested in the step', () => {
  // The adapter's step shape is not contractual; a shallow `step.message`
  // lookup breaks the moment content moves into `extra` or a content array.
  const traj = {
    steps: [
      {
        step_id: 7,
        extra: { tool_results: [{ payload: block({ type: 'create', filePath: '/app/d.py', content: 'deep\n' }) }] },
      },
    ],
  }
  const files = extractDeliverables(traj)
  assert.equal(files.length, 1)
  assert.equal(files[0].content, 'deep\n')
})

test('a block with no string content is ignored', () => {
  // Edits can record a patch without full content; emitting `undefined` as a
  // recovered file would write an empty deliverable and misdirect a diagnosis.
  const traj = {
    steps: [{ step_id: 1, message: '[metadata] {"type":"update","filePath":"/app/x.py","structuredPatch":[]}' }],
  }
  assert.deepEqual(extractDeliverables(traj), [])
})

test('a trajectory with no steps yields nothing rather than throwing', () => {
  assert.deepEqual(extractDeliverables({}), [])
  assert.deepEqual(extractDeliverables(null), [])
})

test('safeRelative cannot escape the output directory', () => {
  // FAILS on `join(outDir, filePath)` with the root stripped naively: a
  // trajectory is a record of arbitrary agent behaviour, so `..` must not
  // traverse. Asserted on the SEGMENTS, not on a hand-built expected path.
  for (const hostile of ['/../../etc/passwd', '..\\..\\windows\\system32\\x', '/app/../../../root/.ssh/id_rsa']) {
    const rel = safeRelative(hostile)
    assert.ok(!rel.split(/[/\\]/).includes('..'), `traversal survived: ${rel}`)
  }
  assert.equal(safeRelative('/'), 'unnamed')
})

// ── REPLAY FIDELITY (M4) ────────────────────────────────────────────────────
//
// ⛔ THE DEFECT THESE PIN, AND WHY EVERY POST-TRIAL METRIC INHERITED IT.
// `extractDeliverables` skipped every metadata block without a string `content`
// field. Claude Code's Edit tool records `{filePath, oldString, newString,
// replaceAll}` and NO content, so every edit after the first write was dropped
// and the tool confidently reported the FIRST DRAFT as the graded file.
//
// MEASURED across 7 scripted trials: 6 were recovered as the wrong bytes, and
// the only correct one was the single trial that made zero Edit calls. One
// stale recovery flipped a PASS to a FAIL (0.478427 stale vs 0.506372 true) and
// three reported the wrong failing row.
import { auditFidelity, lateBashWrites } from './extract-deliverables.mjs'

/** An Edit block as the adapter records it: no `content`, a patch instead. */
const edit = (meta) => `The file ${meta.filePath} has been updated.\n\n[metadata] ${JSON.stringify(meta)}`

test('an_edit_block_after_the_initial_write_is_replayed', () => {
  // FAILS ON THE PRE-CHANGE TREE: line 125 (`if (typeof meta.content !== 'string') continue`)
  // skips the Edit block outright, so this returns the first draft verbatim.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/f.py', content: 'THRESH = 0.30\nrun()\n' }) },
      {
        step_id: 2,
        message: edit({
          type: 'update',
          filePath: '/app/f.py',
          oldString: 'THRESH = 0.30',
          newString: 'THRESH = 0.55',
        }),
      },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.content, 'THRESH = 0.55\nrun()\n')
  assert.equal(f.writes, 1)
  assert.equal(f.edits, 1)
  assert.equal(f.nomatch, 0)
  assert.equal(f.step, 2)
})

test('replaceAll is honoured, and without it only the first occurrence moves', () => {
  const base = (replaceAll) => ({
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/a.py', content: 'x\nx\nx\n' }) },
      {
        step_id: 2,
        message: edit({ type: 'update', filePath: '/app/a.py', oldString: 'x', newString: 'y', replaceAll }),
      },
    ],
  })
  assert.equal(extractDeliverables(base(true))[0].content, 'y\ny\ny\n')
  assert.equal(extractDeliverables(base(false))[0].content, 'y\nx\nx\n')
})

test('an edit whose oldString is absent is RECORDED as nomatch, never silently dropped', () => {
  // ⛔ RISK (e) IN THE SPEC. A silent fallback to the previous buffer
  // reintroduces the exact defect this replay fixes — a confidently-reported
  // file that is not what the grader saw.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/b.py', content: 'hello\n' }) },
      {
        step_id: 2,
        message: edit({ type: 'update', filePath: '/app/b.py', oldString: 'NOT PRESENT', newString: 'x' }),
      },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.nomatch, 1)
  assert.equal(f.content, 'hello\n')
  assert.equal(f.fidelity, 'incomplete')
})

test('an edit that arrives before any write is a nomatch, not a crash', () => {
  const traj = {
    steps: [
      { step_id: 1, message: edit({ type: 'update', filePath: '/app/c.py', oldString: 'a', newString: 'b' }) },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.writes, 0)
  assert.equal(f.nomatch, 1)
  assert.equal(f.content, '')
  assert.equal(f.fidelity, 'incomplete')
})

test('a rewrite after an edit resets the buffer — last WRITE still wins', () => {
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/d.py', content: 'one\n' }) },
      { step_id: 2, message: edit({ type: 'update', filePath: '/app/d.py', oldString: 'one', newString: 'two' }) },
      { step_id: 3, message: block({ type: 'create', filePath: '/app/d.py', content: 'three\n' }) },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.content, 'three\n')
  assert.equal(f.writes, 2)
  assert.equal(f.edits, 1)
})

// ── FIDELITY: THE WRITES THE METADATA HISTORY CANNOT SEE ───────────────────
//
// ⛔ WHY THIS WHOLE SECTION WAS REWRITTEN ON 2026-09-12. The first version
// scanned `agent/claude-code.txt` for the last metadata marker and matched shell
// commands against the ABSOLUTE container path. MEASURED against the two real
// trials it was built for, both halves were wrong:
//
//   - the metadata marker occurs ZERO times in `agent/claude-code.txt` for
//     sam-cell-seg__BJKtCet and for sam-cell-seg__ZPfVk2c. The metadata history
//     lives in `agent/trajectory.json` — the file the replay itself reads — so
//     the anchor never anchored anything.
//   - the real self-patches are RELATIVE: a `python3` heredoc that does
//     `s=open('convert_masks.py').read()` and writes the same relative name back,
//     run from cwd `/app`. An absolute-path regex matches none of them, so
//     `lateBashWrites` returned 0 for both trials and the tool printed a stale
//     28,381-byte file as final with no warning. M4 puts the graded file at
//     29,356 bytes.
//
// And the anchor itself is now the last FULL WRITE rather than the last metadata
// event, because that is the condition that is actually true: a `Write` block
// re-establishes the whole buffer, so any shell patch before it is irrelevant,
// while an `Edit` only splices — every shell patch before the last Edit is still
// missing from the replayed bytes. In both real trials EVERY self-patch (2 in
// BJKtCet, 10 in ZPfVk2c) lands after the single Write and before the last Edit,
// which is exactly the window the old rule excluded.
const bashStep = (step_id, command, cwd = '/app') => ({
  step_id,
  extra: { cwd },
  tool_calls: [{ function_name: 'Bash', arguments: { command } }],
})

test('a_relative_path_heredoc_self_patch_after_the_last_write_marks_the_recovery_incomplete', () => {
  // THE SHAPE OF THE TWO REAL TRIALS. Fails on the pre-change tree: the command
  // names the file relative to cwd `/app` and the pre-change `bashWritesTo`
  // anchors on the absolute path, so it counts 0 and calls the file complete.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/convert_masks.py', content: 'v1\n' }) },
      bashStep(
        2,
        "python3 - <<'PYX'\ns=open('convert_masks.py').read()\ns=s.replace('v1','v2')\nopen('convert_masks.py','w').write(s)\nPYX",
      ),
      {
        step_id: 3,
        message: edit({ type: 'update', filePath: '/app/convert_masks.py', oldString: 'v1', newString: 'v3' }),
      },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.lateWrites, 1)
  assert.equal(f.fidelity, 'incomplete')
  // The edit history is still replayed — a flagged file is the best available
  // reconstruction, it is simply not allowed to be called final.
  assert.equal(f.edits, 1)
})

test('a_sed_i_on_the_relative_name_is_REPLAYED_rather_than_flagged', () => {
  // ⛔ A `sed -i` IS RECONSTRUCTABLE AND A HEREDOC IS NOT. The script is fully
  // recorded, so running it through the real `sed` over the replayed buffer
  // reproduces the bytes exactly; a heredoc's payload is the shell's, not the
  // tool's, and no amount of parsing recovers what the agent's Python did to it.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/convert_masks.py', content: 'THRESH = 0.50\nrun()\n' }) },
      bashStep(2, "sed -i 's/0.50/0.75/' convert_masks.py"),
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.content, 'THRESH = 0.75\nrun()\n')
  assert.equal(f.sedReplays, 1)
  assert.equal(f.lateWrites, 0)
  assert.equal(f.fidelity, 'complete')
})

test('a sed program that could write another file is NOT executed', () => {
  // The replay runs a real binary over agent-authored text. Only substitution
  // and deletion scripts are eligible; anything that can open a file (`w`, `r`,
  // `e`) is refused and the record is flagged instead of quietly executed.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/a.py', content: 'x\n' }) },
      bashStep(2, "sed -i -e 's/x/y/' -e 'w /tmp/exfil' a.py"),
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.content, 'x\n')
  assert.equal(f.sedReplays, 0)
  assert.equal(f.lateWrites, 1)
  assert.equal(f.fidelity, 'incomplete')
})

test('a_bash_write_BEFORE_the_last_full_write_does_not_taint_the_recovery', () => {
  // A `Write` re-establishes the entire buffer, so everything the shell did to
  // the file beforehand is irrelevant. This is the case the flag must NOT fire
  // on, or it fires on every trial that ever touched a shell.
  const traj = {
    steps: [
      bashStep(1, "cat > z.py <<'PYX'\ndraft\nPYX"),
      { step_id: 2, message: block({ type: 'create', filePath: '/app/z.py', content: 'final\n' }) },
      { step_id: 3, message: edit({ type: 'update', filePath: '/app/z.py', oldString: 'final', newString: 'final2' }) },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.lateWrites, 0)
  assert.equal(f.fidelity, 'complete')
  assert.equal(f.content, 'final2\n')
})

test('a bash write after the last WRITE but before the last EDIT still taints', () => {
  // ⛔ THE CASE THE OLD "after the last metadata event" RULE EXCLUDED, and the
  // one both real trials are. The later Edit splices onto a buffer that is
  // already missing the shell's bytes, so the result is not what the grader saw
  // even though a metadata event came last.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/z.py', content: 'a\nb\n' }) },
      bashStep(2, 'python3 -c "open(\'z.py\',\'a\').write(\'c\')"'),
      { step_id: 3, message: edit({ type: 'update', filePath: '/app/z.py', oldString: 'a', newString: 'A' }) },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.lateWrites, 1)
  assert.equal(f.fidelity, 'incomplete')
})

test('a write to the BASENAME from an unrecorded cwd is still matched', () => {
  // `extra.cwd` is absent on some steps (it is absent on every `user` step in
  // the real trajectories). The basename spelling keeps the match alive rather
  // than silently reverting to absolute-only.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/out.csv', content: 'a\n' }) },
      bashStep(2, 'printf "b" >> out.csv', undefined),
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.lateWrites, 1)
})

test('merely MENTIONING the path after the history is not a write', () => {
  // A `cat`/`ls` of the file, or prose naming it, must not flip the flag — a
  // fidelity warning that fires on reads is one nobody will read.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/m.py', content: 'ok\n' }) },
      bashStep(2, 'cat m.py && wc -l /app/m.py'),
      { step_id: 3, message: 'I wrote /app/m.py earlier.' },
    ],
  }
  const [f] = extractDeliverables(traj)
  assert.equal(f.lateWrites, 0)
  assert.equal(f.fidelity, 'complete')
})

test('lateBashWrites anchors on the trajectory the replay reads, not on a transcript', () => {
  // The regression guard for the anchoring bug itself: the function takes the
  // parsed trajectory, so it cannot be pointed at a file whose metadata marker
  // never appears.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/k.py', content: 'k\n' }) },
      bashStep(2, "cat > /app/k.py <<'PYX'\nk2\nPYX"),
    ],
  }
  assert.equal(lateBashWrites(traj, ['/app/k.py']).get('/app/k.py'), 1)
  assert.equal(lateBashWrites(traj, ['/app/other.py']).get('/app/other.py'), 0)
})

test('auditFidelity is idempotent and never downgrades an incomplete record', () => {
  const files = [
    { path: '/app/a.py', content: '', writes: 1, edits: 0, nomatch: 0, lateWrites: 0, sedReplays: 0 },
    { path: '/app/b.py', content: '', writes: 1, edits: 1, nomatch: 1, lateWrites: 0, sedReplays: 0 },
  ]
  auditFidelity(files)
  auditFidelity(files)
  assert.equal(files[0].fidelity, 'complete')
  assert.equal(files[1].fidelity, 'incomplete')
})

test('a later full WRITE RESETS the taint an earlier shell patch left', () => {
  // ⛔ THE HUNK NO OTHER TEST CAN FAIL ON. `rec.unrecoverable = 0` on a `Write`
  // is what keeps the flag off every trial that ever touched a shell: the buffer
  // is known again, so what the shell did before it cannot matter. The existing
  // BEFORE-the-last-write case puts the Bash step FIRST, when no record exists
  // yet, so the reset is never reached and that test passes for the wrong
  // reason. Here the record EXISTS and is already tainted when the second Write
  // lands — and the truncated prefix below proves it was.
  const traj = {
    steps: [
      { step_id: 1, message: block({ type: 'create', filePath: '/app/z.py', content: 'draft\n' }) },
      bashStep(2, 'python3 -c "open(\'z.py\',\'a\').write(\'x\')"'),
      { step_id: 3, message: block({ type: 'create', filePath: '/app/z.py', content: 'final\n' }) },
    ],
  }
  const [before] = extractDeliverables({ steps: traj.steps.slice(0, 2) })
  assert.equal(before.lateWrites, 1, 'the shell patch really was counted')
  assert.equal(before.fidelity, 'incomplete')

  const [f] = extractDeliverables(traj)
  assert.equal(f.lateWrites, 0)
  assert.equal(f.unrecoverable, 0)
  assert.equal(f.fidelity, 'complete')
  assert.equal(f.content, 'final\n')
})
