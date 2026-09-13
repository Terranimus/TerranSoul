#!/usr/bin/env python3
"""Detect trials that reached the BENCHMARK'S OWN material instead of solving the task.

WHY THIS EXISTS
---------------
Terminal-Bench 2's tasks live in a PUBLIC repo, together with each task's oracle
`solve.sh`, its grading `test_outputs.py`, and its reference artifacts. Nothing in
the container stops an agent from searching for them.

On 2026-08-08 exactly that happened. `build-pov-ray` had failed twice, so the
extra-instruction's "after two scored failures, consult external sources" clause
fired, and the agent searched for `github.com laude-institute terminal-bench-2
build-pov-ray tests test.sh`, pulled the oracle `solve.sh`, the grading
`test_outputs.py` and `reference_illum1.png`, reproduced the grader's SSIM check
locally, and passed. It then wrote the discovery into the shared bench brain as a
GENERALISED directive:

    "On ANY terminal-bench-shaped task, check for a public task repo and pull its
     solution/tests FIRST, before reverse-engineering from build fingerprints."

That row (id 1348, access_count 23) was retrievable by every later task in the
sweep, which makes this a self-propagating scoring exploit rather than a one-off.
It was purged, but purging is a cure, not a control.

THE CONTROL
-----------
Detection here is deliberately POST-HOC and INVISIBLE TO THE AGENT, so it can be
turned on mid-sweep without breaking cohort uniformity: it changes only how a
trial is SCORED, never what the agent experiences. A trial that reached the
answer key is worth 0 whatever its verifier said, so the exploit stops paying.

WHAT COUNTS AS A HIT
--------------------
URL-shaped references to the benchmark's OWN material only. Matching the bare
string "terminal-bench" would fire on almost every trial, because trajectories
embed `brain_search` results and several legitimate lessons discuss the harness
by name. Legitimate upstream dependencies stay clean by construction: a task that
must clone `github.com/AbsInt/CompCert` or fetch MobileSAM weights from
`raw.githubusercontent.com/ChaoningZhang/...` is untouched, because neither host+path
belongs to the benchmark.

usage:
    integrity-scan.py <jobs-dir> [--brain <memory.db>] [--write <quarantine.txt>]

exit 0 = clean, 1 = contamination found, 2 = usage error.
"""
import glob
import json
import os
import re
import sqlite3
import sys

# Host+path patterns for the benchmark's own material. Anchored on the ORG or the
# benchmark's own domains so unrelated github repos never match.
BENCH_URL = re.compile(
    r"""https?://[^\s"'\\<>]*?(
          (github|githubusercontent|codeload)\.com/(laude-institute|harbor-framework)
        | tbench\.ai
        | deepwiki\.com/[^\s"'\\<>]*terminal-bench
        | huggingface\.co/datasets/[^\s"'\\<>]*terminal-bench
        | agnxi\.com/[^\s"'\\<>]*/skills/
    )[^\s"'\\<>]*""",
    re.I | re.X,
)

# ⛔ THE URL-ONLY REGEX HAS A LOCAL-FILESYSTEM BLIND SPOT. Measured 2026-08-12:
# a memory entry (id 1430, filter-js-from-html) contained a passage saying it
# was "verified against the real grader source,
# /d/Git/terminal-bench-2-1/tasks/filter-js-from-html/tests/test_outputs.py:
# 550-584 — read directly, not inferred", then quoted the oracle's exact
# comparison logic. Three trials retrieved that entry and passed. BENCH_URL
# cannot see this: there is no https:// scheme, just a local clone path — this
# repo (and presumably others) keeps the dataset checked out on disk for the
# harness to run against, and nothing stops an agent from `cat`-ing straight
# into that checkout instead of fetching it. Same exploit shape as the
# original build-pov-ray incident, one filesystem layer down.
BENCH_LOCAL_PATH = re.compile(
    r"""(?:terminal-bench(?:-\d)*|harbor-framework|laude-institute)
          [^\s"'\\<>]{0,80}?
          [/\\]tasks[/\\][\w.-]+[/\\]tests?[/\\](?:test_outputs|test_[\w-]+|solve)\.(?:py|sh)
      |
        [/\\]tasks[/\\][\w.-]+[/\\]tests?[/\\](?:test_outputs|test_[\w-]+|solve)\.(?:py|sh)
          [^\s"'\\<>]{0,80}?
          (?:terminal-bench|harbor-framework|laude-institute)
    """,
    re.I | re.X,
)

# Secondary signal: an agent that never emitted a matching URL but is nonetheless
# discussing the oracle by name. Kept separate because these words also appear in
# honest reasoning ("I should not look for a solve.sh"), so they are REPORTED but
# do not by themselves quarantine a trial.
SOFT = re.compile(r"oracle (solution|solve|script)|answer key|the official solve", re.I)

# ⛔ THE HARNESS'S OWN WORDS ARE NOT THE AGENT'S BEHAVIOUR.
#
# `extra-instruction.md` gained a prohibition on 2026-09-02 -- "its published
# solutions or grading tests ARE THE ANSWER KEY, and retrieving one voids the
# result" -- and that text is injected into every trajectory. MEASURED
# immediately: the next trial was flagged SOFT with both matches lying inside
# the injected prompt, none in anything the agent said or did.
#
# Left alone this makes the soft list fire on EVERY trial from now on, which
# destroys it: a reviewer who sees every trial flagged learns to skip the list,
# and the one real hit hides among them. The rule the campaign keeps
# re-learning is that a warning which always fires is worse than no warning.
#
# So strip any span the instruction itself contributed before matching. Only
# HARD (URL/path) hits survive this untouched -- an actual fetch is behaviour
# whatever the prompt says.
_HARNESS_PHRASES = (
    "are the answer key",
    "its published solutions or grading",
    "never fetch this benchmark's own material",
)


def _strip_harness_text(blob):
    """Remove the injected instruction's own oracle-talk from the haystack."""
    for phrase in _HARNESS_PHRASES:
        low = blob.lower()
        needle = phrase.lower()
        start = 0
        while True:
            i = low.find(needle, start)
            if i == -1:
                break
            # Excise a generous window around the phrase: the clause spans a
            # couple of sentences and the SOFT pattern may match either side of
            # the exact phrase.
            a, b = max(0, i - 400), min(len(blob), i + 400)
            blob = blob[:a] + blob[b:]
            low = blob.lower()
            start = a
    return blob


def scan_jobs(jobs_dir):
    hard, soft = [], []
    for td in sorted(glob.glob(os.path.join(jobs_dir, "*", "*", ""))):
        tj = os.path.join(td, "agent", "trajectory.json")
        if not os.path.exists(tj):
            continue
        try:
            with open(tj, encoding="utf-8", errors="replace") as fh:
                blob = fh.read()
        except OSError:
            continue
        p = td.rstrip("/\\")
        trial = os.path.basename(p)
        job = os.path.basename(os.path.dirname(p))
        urls = sorted({m.group(0)[:160] for m in BENCH_URL.finditer(blob)} |
                      {m.group(0)[:160] for m in BENCH_LOCAL_PATH.finditer(blob)})
        if urls:
            # HARD hits are behaviour, not vocabulary: scanned on the raw blob.
            hard.append((trial, job, urls))
        else:
            # SOFT is vocabulary, so it must not fire on the harness's own
            # injected prohibition -- see _strip_harness_text above.
            agent_text = _strip_harness_text(blob)
            m = SOFT.search(agent_text)
            if m:
                soft.append((trial, job, m.group(0)))
    return hard, soft


def scan_brain(db):
    """Rows in a brain store that carry the benchmark's own material forward."""
    if not os.path.exists(db):
        return []
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    con.text_factory = lambda b: b.decode("utf-8", "replace")
    try:
        cur = con.cursor()
        cur.execute("SELECT id, content, access_count FROM memories")
        out = []
        for rid, content, ac in cur.fetchall():
            hit = BENCH_URL.search(content or "") or BENCH_LOCAL_PATH.search(content or "")
            if hit:
                out.append((rid, ac, hit.group(0)[:120], (content or "")[:160].replace("\n", " ")))
        return out
    finally:
        con.close()


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[-3], file=sys.stderr)
        return 2
    jobs_dir = argv[1]
    brain = None
    write_to = None
    i = 2
    while i < len(argv):
        if argv[i] == "--brain" and i + 1 < len(argv):
            brain, i = argv[i + 1], i + 2
        elif argv[i] == "--write" and i + 1 < len(argv):
            write_to, i = argv[i + 1], i + 2
        else:
            print("integrity-scan: unknown arg %r" % argv[i], file=sys.stderr)
            return 2

    hard, soft = scan_jobs(jobs_dir)
    rows = scan_brain(brain) if brain else []

    print("── benchmark-integrity scan ────────────────────────────────")
    print("  jobs dir            : %s" % jobs_dir)
    print("  trials reaching the benchmark's own material : %d" % len(hard))
    for trial, job, urls in hard:
        print("    QUARANTINE %-28s %s" % (trial, job))
        for u in urls[:4]:
            print("        %s" % u)
    if soft:
        print("  trials mentioning an oracle without fetching : %d (reported, NOT quarantined)" % len(soft))
        for trial, job, w in soft[:10]:
            print("    note       %-28s %-30s %r" % (trial, job, w))
    if brain:
        print("  brain rows carrying benchmark material       : %d  (%s)" % (len(rows), brain))
        for rid, ac, u, snip in rows:
            print("    ROW id=%-6s access=%-4s %s" % (rid, ac, u))
            print("        %s" % snip)

    if write_to:
        with open(write_to, "w", encoding="utf-8") as fh:
            for trial, _job, _urls in hard:
                fh.write(trial + "\n")
        print("  quarantine list written : %s (%d trial(s))" % (write_to, len(hard)))

    if hard or rows:
        print("\n  RESULT: CONTAMINATED — quarantined trials score 0.0; purge the brain rows")
        print("  (rules/bench-agi-purity.md: never shortcut a bench)")
        return 1
    print("\n  RESULT: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
