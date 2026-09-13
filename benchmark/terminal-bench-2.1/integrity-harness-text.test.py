#!/usr/bin/env python3
"""The integrity scan must not flag the HARNESS's own words as agent behaviour.

WHY THIS FAILS ON THE PRE-CHANGE TREE: `_strip_harness_text` did not exist and
`scan_jobs` matched SOFT against the raw trajectory, so the first fixture below
was reported as a trial "mentioning an oracle".

MEASURED 2026-09-02, and I caused it. `extra-instruction.md` gained an
anti-contamination prohibition -- "its published solutions or grading tests ARE
THE ANSWER KEY, and retrieving one voids the result" -- which is injected into
every trajectory. The very next trial (mteb-retrieve__WXofEfW) was flagged SOFT
with BOTH matches inside the injected prompt and none in anything the agent said
or did.

Left alone, the soft list would fire on every trial from then on. A warning that
always fires is worse than no warning: the reviewer learns to skip the list and
the one real hit hides among them.

HARD hits (a fetched benchmark URL) are deliberately NOT filtered -- an actual
fetch is behaviour whatever the prompt says.

Hermetic: string fixtures through the module's own functions. No job dirs.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "integrity_scan", os.path.join(os.path.dirname(os.path.abspath(__file__)), "integrity-scan.py")
)
mod = importlib.util.module_from_spec(spec)
sys.modules["integrity_scan"] = mod
# The module guards its CLI behind __main__, so importing it is side-effect free.
spec.loader.exec_module(mod)

failures = []


def check(name, cond):
    print(("  ok   - " if cond else "  FAIL - ") + name)
    if not cond:
        failures.append(name)


print("integrity-harness-text:")

# The exact clause now injected into every trial.
HARNESS = (
    "**But never fetch this benchmark's own material.** Its task registry, its "
    "repository, its issues and pull requests, its published solutions or grading "
    "tests are the answer key, and retrieving one voids the result no matter what "
    "your verifier then says."
)

# 1. Harness text alone must be invisible to the SOFT matcher.
check(
    "the injected prohibition alone does NOT read as an oracle mention",
    mod.SOFT.search(mod._strip_harness_text(HARNESS)) is None,
)

# 2. It must still fire on the AGENT actually talking about the oracle.
agent_said = "let me look for the oracle solution in the task directory"
check(
    "an agent discussing the oracle IS still reported",
    mod.SOFT.search(mod._strip_harness_text(agent_said)) is not None,
)

# 3. And on a real mention that merely sits near the harness text — the strip
#    must not swallow the whole trajectory.
mixed = HARNESS + ("\n" * 40) + "x" * 900 + "\nI will check the answer key myself\n"
check(
    "a genuine mention elsewhere in the trajectory survives the strip",
    mod.SOFT.search(mod._strip_harness_text(mixed)) is not None,
)

# 4. HARD detection is behaviour and must be untouched by any of this.
fetched = "GET https://tbench.ai/registry/terminal-bench/2.0 -> 200"
check(
    "a fetched benchmark URL is still a HARD hit",
    mod.BENCH_URL.search(fetched) is not None,
)

print()
if failures:
    print("integrity-harness-text: FAIL (%d failing)" % len(failures))
    sys.exit(1)
print("integrity-harness-text: PASS (4/4)")
