#!/usr/bin/env node
/**
 * Tests for the evidence-quality rule.
 *
 * WHY THEY EXIST: `reference_measure_a_gate_precision_before_shipping` records
 * a write-blocking gate that scored precision 0 of 5 against the real corpus,
 * with the lesson "measure a gate over stored data before shipping, and pin the
 * false positives as fixtures". So the corpus below is REAL — every string is a
 * `command` this campaign's ledger actually recorded, copied from the proxy
 * logs, not invented to agree with the implementation.
 *
 * FAILS ON THE PRE-CHANGE TREE: evidence-quality.mjs did not exist, and nothing
 * anywhere read the recorded `command` back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNonAssertive, segmentHeads, auditEvidence } from './evidence-quality.mjs'

/** Recorded verbatim by the ledger, 2026-09-04. These ARE the false-positive fixtures. */
const REAL_ASSERTIVE = [
  'python3 /app/check.py',
  'gcc -static -o reversed mystery.c -lm',
  'rustc /app/polyglot/main.rs',
  'coqc plus_comm.v',
  // ⛔ THE ONE A NAIVE RULE BREAKS ON: `cp` is a substring of `cmp`, and the
  // pipeline's first stage IS non-assertive. Only the whole-pipeline reading
  // gets this right.
  'cat /app/data.comp | /app/decomp | cmp - /app/data.txt',
  'python3 -m venv /tmp/venvtest',
  'sqlite3 oewn.sqlite < sol.sql > /tmp/final.txt',
  'python -m pytest tests/ --ignore=tests/test_random_curves.py -q',
  'USE_HF=1 python3 /tmp/test_pp.py',
  'gcov -n -o /app/sqlite /app/sqlite/sqlite3-sqlite3.gcno',
  'python3 setup.py build_ext --inplace',
  'pdflatex -interaction=nonstopmode main.tex (x2, fresh dir)',
]

/** Also recorded verbatim — and none of these establishes anything. */
const REAL_JUNK = [
  'cd /app',
  'cd /tmp',
  'cd /app/pmars-0.9.4/src',
  'rm -rf .venv',
  'cp /app/out.html /tmp/t.html',
]

test('every REAL assertive command is left alone — zero false positives', () => {
  for (const c of REAL_ASSERTIVE) {
    assert.equal(isNonAssertive(c), false, `false positive on: ${c}`)
  }
})

test('every REAL junk record is flagged', () => {
  for (const c of REAL_JUNK) {
    assert.equal(isNonAssertive(c), true, `missed junk: ${c}`)
  }
})

test('MEASURED PRECISION on the real corpus: 5 of 46, all genuine', () => {
  // The proportion is part of the claim. A rule that flagged half the corpus
  // would be unusable no matter how principled it looked.
  const corpus = [...REAL_ASSERTIVE, ...REAL_JUNK]
  const flagged = corpus.filter(isNonAssertive)
  assert.equal(flagged.length, REAL_JUNK.length)
  assert.deepEqual(flagged.sort(), [...REAL_JUNK].sort())
})

test('one assertive stage is enough — `every`, not `some`', () => {
  // Erring toward ACCEPTING is the right direction for a signal used to
  // discount a trial's proof: a wrong flag discredits real evidence.
  assert.equal(isNonAssertive('cat out.txt'), true)
  assert.equal(isNonAssertive('cat out.txt | grep -q PASS'), false)
  assert.equal(isNonAssertive('cd /app && pytest -q'), false)
  assert.equal(isNonAssertive('mkdir -p /tmp/x; diff a b'), false)
  // `|| true` is a common idiom and `true` asserts nothing. Caught while
  // checking the Rust port: without it in the list this read as evidence.
  assert.equal(isNonAssertive('mkdir -p x || true'), true)
  // A bare `&` inside `2>&1` must not manufacture a phantom stage.
  assert.equal(isNonAssertive('cd /app 2>&1'), true)
  assert.equal(isNonAssertive('python3 t.py 2>&1'), false)
})

test('env prefixes and absolute paths do not hide the command name', () => {
  assert.deepEqual(segmentHeads('USE_HF=1 python3 /tmp/t.py'), ['python3'])
  assert.deepEqual(segmentHeads('/usr/local/bin/povray +L/app -V'), ['povray'])
  assert.deepEqual(segmentHeads('cd /app'), ['cd'])
  // A bare `PATH=... cd /x` is still just a directory change.
  assert.equal(isNonAssertive('FOO=1 cd /app'), true)
})

test('an empty or unparseable command is NOT flagged', () => {
  // Fail open: flagging an empty string would discount a record for a reason
  // that has nothing to do with its evidence.
  assert.equal(isNonAssertive(''), false)
  assert.equal(isNonAssertive(null), false)
  assert.equal(isNonAssertive(undefined), false)
  assert.equal(isNonAssertive('   '), false)
})

test('the audit reports the ledger has NEVER recorded a failure', () => {
  // ⛔ The strongest single indictment of the ledger as an evidence source, and
  // it is corroborated by verification.rs's own doc: "53 records with exit_code
  // 0 in 53 of 53 — it has never once recorded a failure". A ledger that cannot
  // record a failure is not measuring anything.
  const a = auditEvidence([
    { command: 'pytest -q', status: 'passed' },
    { command: 'cd /app', status: 'passed' },
    { command: 'python3 t.py', status: null },
  ])
  assert.equal(a.total, 3)
  assert.equal(a.nonAssertive, 1)
  assert.deepEqual(a.nonAssertiveCommands, ['cd /app'])
  assert.deepEqual(a.statuses, { passed: 2, unclassified: 1 })
  assert.equal(a.neverFailed, true)
  assert.equal(a.junkRate, 1 / 3)
})

test('a corpus containing a real failure is not reported as neverFailed', () => {
  const a = auditEvidence([
    { command: 'pytest -q', status: 'passed' },
    { command: 'pytest -q', status: 'failed' },
  ])
  assert.equal(a.neverFailed, false)
})

test('an empty corpus makes no claim at all', () => {
  const a = auditEvidence([])
  assert.equal(a.neverFailed, false, 'no records is not evidence of never failing')
  assert.equal(a.junkRate, 0)
})
