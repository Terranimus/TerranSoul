/**
 * `evidence-quality.mjs` — is what the verification ledger recorded actually
 * evidence?
 *
 * ⛔ THE DEFECT THIS MEASURES. `verification.rs::classify_command` sets the
 * recorded status from the EXIT CODE alone:
 *
 *     let status = VerificationStatus::from_exit_code(exit_code);
 *
 * and when no canonical verify-command matches it accepts any command anyway,
 * "so the row is still self-describing". So `status: passed` means only "a
 * command the agent named exited 0" — not "the work was verified". `cd /app`
 * exits 0 and is filed as a passing verification.
 *
 * That matters because the stop gate reads the ledger. A trial whose only
 * recorded proof is `cd /app` has ledger state `passed`, so the gate has
 * nothing to object to and allows the stop. Enforcement defeated by junk
 * evidence, silently.
 *
 * MEASURED 2026-09-04 over 46 real recorded verifications from this campaign's
 * proxy logs: 35 `passed`, 11 unclassified, and **not one ever failed** —
 * matching what `verification.rs` already records in its own doc comment
 * ("53 records with exit_code 0 in 53 of 53 — it has never once recorded a
 * failure"). Five of the 46 are not verifications at all.
 *
 * THE RULE IS DELIBERATELY NARROW, AND IT WAS MEASURED BEFORE BEING WRITTEN
 * DOWN. `reference_measure_a_gate_precision_before_shipping` records a
 * write-blocking gate that scored precision 0 of 5 against the real corpus.
 * This one flags 5 of 46 (11%) and all five are genuinely non-assertive, with
 * no false positives on the awkward cases — notably
 * `cat X | decomp | cmp - Y`, where `cp` is a substring of `cmp` and a naive
 * match would fire.
 *
 * It answers only "could this command constitute evidence at all", never
 * "was the work correct". A compile that succeeds IS evidence; a directory
 * change never is, whatever it exits with.
 */

/**
 * Command heads that cannot, alone, establish anything about the work.
 *
 * Navigation and unconditional file manipulation change state; they assert
 * nothing. `echo`/`ls`/`cat` are here because on their own they only print —
 * `cat X | cmp - Y` is fine, because `cmp` is then also a head and DOES assert.
 */
export const NON_ASSERTIVE = new Set([
  'cd', 'pushd', 'popd',
  'mkdir', 'touch', 'rm', 'cp', 'mv', 'ln',
  'chmod', 'chown', 'export',
  'echo', 'ls', 'cat',
  // The no-op builtins. `mkdir -p x || true` is a common idiom, and `true`
  // asserts nothing by definition — without these it reads as evidence.
  'true', ':',
])

/**
 * The command name at the head of each segment, env-prefixes stripped.
 *
 * Splits on `;`, `&&`, `||` and `|` so a pipeline is judged by every stage —
 * that is what keeps `cat file | cmp - other` out of the flagged set while
 * `cat file` alone stays in it.
 */
export function segmentHeads(command) {
  return String(command ?? '')
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const tokens = s.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
      return (tokens[0] ?? '').replace(/^.*\//, '')
    })
    .filter(Boolean)
}

/**
 * True when EVERY stage of the command is non-assertive.
 *
 * `every`, not `some`: one assertive stage is enough to make the command
 * capable of being evidence, and erring toward accepting is the right
 * direction for a signal that will be used to discount a trial's proof.
 */
export function isNonAssertive(command) {
  const heads = segmentHeads(command)
  return heads.length > 0 && heads.every((h) => NON_ASSERTIVE.has(h))
}

/**
 * Recorded verifications, split by whether they could be evidence at all.
 *
 * `neverFailed` is reported because it is the strongest single indictment of
 * the ledger as an evidence source: across every trial in this campaign the
 * recorded status has been `passed` or absent, never `failed`. A ledger that
 * cannot record a failure is not measuring anything.
 */
export function auditEvidence(records) {
  const nonAssertive = records.filter((r) => isNonAssertive(r.command))
  const statuses = {}
  for (const r of records) statuses[r.status ?? 'unclassified'] = (statuses[r.status ?? 'unclassified'] ?? 0) + 1
  return {
    total: records.length,
    nonAssertive: nonAssertive.length,
    nonAssertiveCommands: nonAssertive.map((r) => r.command),
    statuses,
    neverFailed: records.length > 0 && !records.some((r) => r.status === 'failed'),
    junkRate: records.length ? nonAssertive.length / records.length : 0,
  }
}
