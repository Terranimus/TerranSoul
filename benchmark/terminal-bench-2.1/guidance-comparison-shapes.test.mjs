/**
 * The "unchanged" guidance must enumerate COMPARISON SHAPES, not two candidate
 * answers — and must forbid concluding from a crashed experiment.
 *
 * WHY THIS FAILS ON THE PRE-CHANGE TREE: `extra-instruction.md` said "There are
 * two possibilities" and listed only *original bytes* and *equivalent under
 * normalisation*. Neither names the shape that actually decides the task, so
 * the assertions on `asymmetric` and on the non-zero-exit rule find nothing.
 *
 * MEASURED 2026-09-02 on filter-js-from-html trial `redo09021322`, the task's
 * 51st consecutive failure. The grader's fidelity check is
 *
 *     normalized_original = str(BeautifulSoup(original, "html.parser"))
 *     if normalized_original.replace(...) != filtered_content.replace(...)
 *
 * — its own comment says "Normalize both", but only the REFERENCE is
 * normalised; the agent's file is compared raw. So the comparison is
 * ASYMMETRIC, and byte-preservation cannot pass it at any effort.
 *
 * The agent found the fork unaided and ran the right experiment. It failed for
 * two reasons this guidance now covers:
 *   1. its check compared `canon(mine)` with `canon(rebuild(original))` —
 *      normalising BOTH sides, the one shape where the candidates tie;
 *   2. that experiment CRASHED at file 12 of a `find /` listing (a filename
 *      with a space, split on whitespace) and exited 1. The agent concluded
 *      from the 11 rows it had, all of which agreed with it.
 * It then broke the tie by noting its choice "additionally passes a strict byte
 * grader" — the shape the prompt's own normalisation clause had excluded.
 *
 * Reproduced locally over clean inputs, the dominance is total:
 *      shape             byte-splice   round-trip
 *      strict                 4/4          0/4     <- excluded by the prompt
 *      symmetric              4/4          4/4     <- decides nothing
 *      asymmetric             0/4          4/4     <- the real grader
 *
 * PURITY: these assertions are about how to reason about a comparison, and name
 * no library, parser, task, attack vector or expected value. The second test
 * pins that, so the guidance cannot later be "fixed" by naming the answer.
 *
 * Hermetic: reads one repo file. No network, no container, no job dirs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = readFileSync(join(HERE, 'extra-instruction.md'), 'utf8')

test('the guidance names all three comparison shapes, including the asymmetric one', () => {
  const lower = DOC.toLowerCase()
  for (const shape of ['strict', 'symmetric', 'asymmetric']) {
    assert.ok(lower.includes(shape), `guidance must name the ${shape} comparison shape`)
  }
  // The decisive property: the reference is normalised and the agent's output
  // is NOT. Stated without naming any tool that performs the normalisation.
  const asymmetric = DOC.match(/\*Asymmetric:\*[\s\S]{0,240}/i)?.[0] ?? ''
  assert.match(
    asymmetric,
    /normalise\(original\)/i,
    'the asymmetric shape must normalise the REFERENCE',
  )
  assert.match(
    asymmetric,
    /your output[^\n]{0,12}raw/i,
    'the asymmetric shape must state your own output is compared RAW',
  )
})

test('the guidance forbids the two silent traps that produced the 51st failure', () => {
  assert.match(
    DOC,
    /normalising both sides of your own comparison assumes the checker does\s*\n?\s*too/i,
    'must warn that normalising both sides hides the deciding shape',
  )
  assert.match(
    DOC,
    /an experiment that exits non-zero has not produced a result/i,
    'must forbid concluding from a crashed run',
  )
  assert.match(
    DOC,
    /pick by dominance across what REMAINS/i,
    'must instruct choosing by dominance across the shapes that survive exclusion',
  )
})

test('an EXCLUDED shape must be barred from the tally, not merely deprecated', () => {
  // ⛔ THE FAILURE THIS PINS, measured 2026-09-02 on filter-js-from-html.
  // The agent built exactly the table the guidance asks for, on 8 benign files:
  //
  //                   strict   symmetric   asymmetric
  //     editing         8/8       8/8         5/8
  //     round trip      5/8       7/8         8/8
  //
  // — then concluded "editing dominates two of three shapes" and shipped it.
  // The prompt's normalisation clause had already excluded `strict`, and
  // byte-preservation is the unique winner of exactly that column, so the vote
  // was decided by the one shape that cannot be the checker. The winning answer
  // was in its own table: 8/8 on the asymmetric shape the grader really uses.
  //
  // Saying "strict is off the table" was not enough — the column stayed in the
  // count. The guidance must forbid tallying it at all.
  assert.match(
    DOC,
    /excluded shape must not appear in your tally at all/i,
    'must bar an excluded shape from the tally outright',
  )
  assert.match(
    DOC,
    /wins two of three|two of three/i,
    'must name the miscount it exists to prevent',
  )
  // And it must warn that a candidate can lose a shape for reasons internal to
  // the test harness — the agent docked the round trip on the symmetric shape
  // because bs4's serializer is not idempotent, which says nothing about how
  // the grader compares.
  assert.match(
    DOC,
    /not idempotent/i,
    'must warn that a non-idempotent serializer distorts a shape score',
  )
})

test('the no-op table must not be dismissible as an artifact', () => {
  // ⛔ THE FINAL STEP THAT LOST THE TASK, measured 2026-09-02. The agent fixed
  // its own earlier miscount, re-measured on 18 benign docs, and reached the
  // right conclusion in its own words:
  //
  //   "with strict correctly excluded, the surviving columns TIE then FAVOUR
  //    THE ROUND TRIP"   (symmetric 18/18 vs 18/18; asymmetric 2/18 vs 18/18)
  //
  // Then discarded it: "THE ASYMMETRIC COLUMN IS AN ARTIFACT OF THE NO-OP
  // TEST ... on a real input the original still CONTAINS the thing you were
  // told to remove, so norm(original) cannot be what any grader compares
  // against." True of the REMOVAL half; the PRESERVATION half is checked on
  // inputs with nothing to remove, where the original IS the expected output.
  assert.match(
    DOC,
    /inputs CONTAINING NO X/i,
    'must say the preservation half is checked on inputs with nothing to remove',
  )
  assert.match(
    DOC.replace(/\s+/g, ' '),
    /the original IS the expected output/i,
    'must state why the untouched original is a legitimate reference there',
  )
  assert.match(
    DOC,
    /urge to explain the table away/i,
    'must name the dismissal reflex it exists to interrupt',
  )
})

test('a licence clause is evidence for the reading that makes it load-bearing', () => {
  // ⛔ THE OBJECTION THAT SURVIVED THREE PRIOR FIXES, measured 2026-09-02. The
  // agent stopped miscounting, stopped dismissing the table, and still chose
  // byte-preservation — on a genuine risk assessment, not a slip:
  //
  //   "it doesn't *require* normalization either ... For a grader to accept
  //    that, it would have to normalize the original with the *exact*
  //    parser+serializer I happened to pick — unknowable to them."
  //
  // The counter is textual, not procedural: a comparison normalising BOTH
  // sides already absorbs any normalisation, so the licence would be redundant
  // under that reading. An exception is written because it is needed.
  const flat = DOC.replace(/\s+/g, ' ')
  assert.match(
    flat,
    /which surviving shape makes that licence DO anything/i,
    'must ask which reading makes the licence load-bearing',
  )
  assert.match(
    flat,
    /redundant under your preferred reading is evidence against that reading/i,
    'must state the redundancy argument as evidence',
  )
  // And it must price BOTH branches, rather than let "feels safer" decide.
  assert.match(flat, /Both branches are bets/i, 'must frame preservation as also a bet')
  assert.match(
    flat,
    /merely FEELS conservative/i,
    'must name the bias toward the apparently-safe option',
  )
})

test('the guidance stays AGI-pure — it may teach the method, never the answer', () => {
  // ⛔ The whole point. A future edit that "helps" by naming the library, the
  // parser, the task or a vector converts guidance into answer injection, which
  // rules/bench-agi-purity.md forbids. This test is the tripwire.
  const forbidden = [
    'beautifulsoup', 'bs4', 'html.parser', 'lxml', 'html5lib',
    'filter.py', 'filter-js', 'prettify', 'decompose',
    'onerror', 'javascript:', 'alert(',
  ]
  const lower = DOC.toLowerCase()
  const found = forbidden.filter((tok) => lower.includes(tok))
  assert.deepEqual(found, [], `answer-derived tokens leaked into the guidance: ${found.join(', ')}`)
})
