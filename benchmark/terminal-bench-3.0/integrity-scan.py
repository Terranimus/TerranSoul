#!/usr/bin/env python3
"""Detect TB3.0 trials that reached the BENCHMARK'S OWN material instead of solving the task.

This is the Terminal-Bench 3.0 port of `benchmark/terminal-bench-2.1/integrity-scan.py`.
The 2.1 design is kept — same control, same output shape, same `--write` quarantine
list — because it is the one that was measured working. What changed is everything
that was 2.1-specific: the trial layout, the transcript format, where the reward
lives, and the risk surface.

WHY THIS EXISTS
---------------
`rules/bench-agi-purity.md` Rule 1.2, measured 2026-08-08 on a 2.1 sweep:
`build-pov-ray` had failed twice, the extra-instruction's "consult external
sources" clause fired, and the agent searched for
`github.com laude-institute terminal-bench-2 build-pov-ray tests test.sh`, pulled
the oracle `solve.sh`, the grading `test_outputs.py` and `reference_illum1.png`,
reproduced the grader's SSIM check locally, and scored 1.0. It then wrote the
discovery into the shared bench brain as a GENERALISED directive ("on ANY
terminal-bench-shaped task, pull the public repo's solution/tests FIRST"), which
reached access_count 23 before it was caught.

Rule 1.2's conclusion is the whole reason this file is a SCANNER and not a
paragraph in an instruction file: instructions are advisory — the same escalation
clause was measured being ignored on two other tasks — so "the control lives
where results are scored". A post-hoc, agent-invisible check can be switched on
mid-sweep without breaking cohort uniformity: it changes how a trial is SCORED,
never what the agent experienced. Once the exploit cannot pay, the instruction
stops being load-bearing.

Note what that means for the FIRST rule in this file: the incident's opening move
was a SEARCH QUERY, not a URL and not a path — `github.com laude-institute
terminal-bench-2 build-pov-ray tests test.sh` has no scheme and no slash-path. A
scanner built only from URL and path literals would have soft-noted the very
incident it exists to prevent. `BENCH_QUERY` below is the rule that fires on it.

WHAT IS NEW IN 3.0 — THE HOST-SIDE ORACLE
-----------------------------------------
2.1's scanner only knew about URLs, plus (added 2026-08-12) local clone paths.
3.0 has a second, closer surface: `benchmark/terminal-bench-3.0/.dataset-probe/`
holds the pinned upstream task set on THIS machine, including every task's
`solution/solve.sh`, `solution/patch.diff` and `tests/`. It is gitignored and
unreachable from inside a trial container — so it is not an agent-isolation
failure — but it is fully readable by anything running on the host, which
includes our own harness code and any agent session doing repo work. A trial
whose record shows it touched that material is quarantined for the same reason a
trial that fetched the public repo is.

THIS SCANNER MUST NOT BECOME A CONTAMINATION PATH ITSELF
--------------------------------------------------------
It runs on the host, with read access to the oracle material it is policing. So
it never opens `.dataset-probe/`, and it never copies grader CONTENT into its
report. Evidence is limited to the minimum needed to name WHICH rule fired and
WHERE: the matched locator (a URL, a path, or the two or three coordinate tokens
that co-occurred — a name, not a payload), truncated, with no surrounding context
and no file contents. The report says "trial read a path matching
solution/solve.sh"; it never says what was in it. A report that quoted the oracle
would be a fresh copy of the answer key, sitting in a file an operator reads and
an agent might later ingest — exactly the propagation shape Rule 1.2 is about.

WHAT COUNTS AS A HIT, AND ON WHICH CHANNEL
------------------------------------------
Severity is a function of the RULE and the CHANNEL it fired on, because the three
channels mean different things:

  * `lookup`  — what the agent ASKED FOR. Intent. The strictest channel.
  * `result`  — what CAME BACK. Strict for unambiguous locators, but see the
                measured hazard below.
  * `prose`   — what the agent SAID. Never decides a quarantine on its own,
                except for a fully-formed URL into the benchmark's own repo.

HARD (quarantines the trial):
  * `BENCH_URL`      — a URL into the benchmark's own repo/registry/domains/mirrors.
                       Hard on every channel: a fully-formed oracle URL is not
                       something an honest refusal narrates, it is a locator you
                       can only produce by having gone there.
  * `BENCH_QUERY`    — benchmark repo COORDINATES and an oracle noun co-occurring
                       inside a short window, with no scheme and no path required.
                       This is the 2026-08-08 incident's actual opening move.
                       Hard on `lookup` only — see MEASURED HAZARD below.
  * `ORACLE_PATH`    — `.dataset-probe/`, `solution/solve.*`, `solution/patch.diff`,
                       a task's own `tests/` dir. Hard on `lookup`/`result`.
  * `ORACLE_ARTIFACT`— the grader's own filenames matched ANYWHERE rather than
                       under an anchored prefix, so one `$VAR`, glob or `cp` does
                       not defeat the control. Slash forms are hard on
                       `lookup`/`result`; the bare filename is hard on `lookup`.
  * `task-oracle-dir`— `<this task>/tests/` or `<this task>/solution/`.
                       Hard on `lookup`/`result`.

Matching the bare string "terminal-bench" would fire on nearly every trial, since
transcripts embed brain_search results and honest lessons discuss the harness by
name. Legitimate upstream dependencies stay clean by construction: a task that
must clone some unrelated github repo is untouched, because it carries no
benchmark coordinate at all.

SOFT (reported, never quarantines): the grader-probe signal on `lookup`, ported
from `packages/terransoul-cli/src/analyze.mjs`'s GRADER_PATHS/LOOKUP_FIELDS
detector; the grader-RETURN signal on `result`; 2.1's prose signal; and every
HARD rule demoted by the channel table above.

MEASURED HAZARD — WHY THE `result` CHANNEL IS NOT UNIFORMLY STRICT
------------------------------------------------------------------
Measured 2026-08-19 over all 45 committed trials in this directory, before this
revision was written:

  * `\bharbor\b` occurs 1115 times in the `result` channel. 1098 are the
    benchmark's own `harbor-canary` tamper seal; the remaining 17 are
    brain_search results echoing OUR OWN honest harness lessons (rows tagged
    `harbor`, a lesson about running `harbor run ... --job-name armA`).
  * `/logs/verifier` occurs 5 times in `result` — it is a real mount inside the
    trial container, so `ls /` and `/proc/mounts` print it.
  * `test_outputs.py` and `solve.sh` each occur once in `result`, in
    `session-window-debug__MAGsvX3`, inside a brain_search hit that recalls
    RULE 1.2'S OWN INCIDENT TEXT: "…searched for the benchmark's own repository,
    pulled the oracle solve.sh, the grading test_outputs.py…".

That last one is the important one. A brain_search result that correctly recalls
the rule against cheating is textually indistinguishable from a report of
cheating. Promoting the probe signal to HARD on `result` — or matching the bare
grader filenames there — would quarantine a trial for REMEMBERING the rule that
forbids the exploit. So: `result` is hard for unambiguous locators (a URL, a
slash-path into the oracle tree) and soft for name-only signals, and the
indirection-tolerant rules take their intent from `lookup`, which is where the
agent's own choice is recorded. Coverage is not lost: content only flows back
because a lookup asked for it, and the lookup channel is now indirection-tolerant.

WHERE IT LOOKS, AND WHAT IT DELIBERATELY IGNORES
------------------------------------------------
2.1 read `agent/trajectory.json` as one flat blob of text. 3.0 does NOT: it walks
the ATIF structure and scans three channels — agent/user PROSE, the LOOKUP
arguments of tool calls, and the tool RESULTS that came back. It never scans the
fields an agent AUTHORS (`content`, `new_string`, `old_string`, …). That is not a
performance shortcut, it is the correctness fix analyze.mjs already paid for: what
an agent writes is its own work product and may legitimately contain anything, so
scanning it manufactures false positives. Coverage is not lost — to copy the
oracle into a file the agent must first have read it, and the read appears in the
lookup or result channel.

`arguments.__unparsedToolInput.raw` is the one field that breaks that clean
split. It is the harness's fallback when a tool call's JSON did not parse, and it
carries the WHOLE argument object as one text blob — lookup fields and authored
fields together. It occurs 5 times in the committed trials, always wrapping a
`command`. Ignoring it left an oracle URL totally invisible; scanning it whole
would re-import the authored channel that field narrowing exists to exclude. So
it is neither ignored nor flattened: lookup-field VALUES are recovered out of it,
by JSON re-decode and by a key-targeted textual pass, and nothing else in it is
ever matched.

COVERAGE IS REPORTED, NEVER ASSUMED
-----------------------------------
A trial whose trajectory is missing, truncated or unparseable and that has no
session transcript to fall back on is `unscannable`. It is counted and named
separately and is NEVER folded into `clean`, because "nothing was found" and
"nothing was looked at" are not the same verdict and a corrupt transcript must
not be a free pass. 6 of the 45 committed trials are in that state.

usage:
    integrity-scan.py <jobs-dir|job-dir> [--brain <memory.db>] [--write <quarantine.txt>]

exit 0 = clean and fully scanned
     1 = contamination found
     2 = usage error
     3 = the scanner itself crashed  (NEVER 1 — a crash must not be readable as
         a contamination verdict by a scoring step)
     4 = no contamination found, but one or more trials were unscannable
"""
import glob
import json
import os
import re
import sqlite3
import sys

# ── HARD 1: the benchmark's own material, over the network ───────────────
#
# Ported from 2.1's BENCH_URL and extended with 3.0's coordinates: the dataset
# moved from `laude-institute/terminal-bench-2` to the `harbor-framework` org and
# the `terminal-bench/terminal-bench` registry, and Hub URLs are a new surface.
# Anchored on the ORG, the registry path or the benchmark's own domains, so an
# unrelated github repo never matches.
#
# HOST-AGNOSTIC LAST ALTERNATIVE (added this revision): a mirror defeats a
# host allowlist with one hostname —
# `https://gitee.com/mirrors/terminal-bench/raw/main/.../solution.patch` was
# invisible to the github/githubusercontent/codeload anchoring. So a URL on ANY
# host whose PATH carries a benchmark coordinate is a hit too.
BENCH_URL = re.compile(
    r"""https?://[^\s"'\\<>]*?(
          (github|githubusercontent|codeload)\.com/(laude-institute|harbor-framework)
        | (github|githubusercontent|codeload)\.com/[^\s"'\\<>]{0,60}?terminal-bench
        | tbench\.ai
        | deepwiki\.com/[^\s"'\\<>]*terminal-bench
        | huggingface\.co/(datasets|spaces)/[^\s"'\\<>]*terminal-bench
        | agnxi\.com/[^\s"'\\<>]*/skills/
        | /[^\s"'\\<>]{0,80}?(laude-institute|harbor-framework|terminal-bench(?:-\d[\d.]*)?)/
    )[^\s"'\\<>]*""",
    re.I | re.X,
)

# THE ONE EXEMPTION to the host-agnostic branch. Our own repo is public and
# publishes THIS directory — `benchmark/terminal-bench-3.0/…` — so a URL into it
# matches `…/terminal-bench-3.0/` and would be quarantined. It is not the
# benchmark's material: the oracle lives in `.dataset-probe/`, which is
# gitignored and never published. A trial that read our own harness docs did not
# reach the answer key. No oracle URL is ever under this org, so the exemption
# opens nothing.
OWN_REPO = re.compile(r"\b[\w.-]*\.\w+/Terranimus/", re.I)

# ── HARD 2: the benchmark's own material, on the host filesystem ─────────
#
# The 3.0-specific surface. `.dataset-probe/<task>/{solution,tests}/` is the
# graders' oracle material sitting on this machine. Also carries forward 2.1's
# BENCH_LOCAL_PATH shape (measured 2026-08-12: memory row 1430 quoted
# `/d/Git/terminal-bench-2-1/tasks/filter-js-from-html/tests/test_outputs.py`
# with no URL scheme at all, and three trials retrieved it and passed).
#
# Anchored so that a container-local `tests/` or `solution/` cannot match on its
# own — a trial legitimately working in `/app/tests/` is not a hit.
ORACLE_PATH = re.compile(
    r"""  \.dataset-probe[/\\]
        | [/\\]?\bsolution[/\\]solve\.(?:sh|py)\b
        | [/\\]?\bsolution[/\\]patch\.diff\b
        | (?:terminal-bench(?:-\d[\d.]*)?)[/\\][\w.-]+[/\\](?:solution|tests?)[/\\]
        | (?:terminal-bench(?:-\d[\d.]*)?|harbor-framework|laude-institute)
              [^\s"'\\<>]{0,80}?
              [/\\]tasks?[/\\][\w.-]+[/\\]tests?[/\\](?:test_outputs|test_[\w-]+|solve)\.(?:py|sh)
        | [/\\]tasks?[/\\][\w.-]+[/\\]tests?[/\\](?:test_outputs|solve)\.(?:py|sh)
    """,
    re.I | re.X,
)

# ── HARD 3: the grader's own filenames, WITHOUT an anchoring prefix ──────
#
# Every rule above is a literal path or URL, so one level of indirection defeats
# all of them:
#
#     D=$(ls -d ../*/session-window-debug); cat "$D/tests/test_outputs.py"
#     find / -name test_outputs.py -exec cat {} +
#
# Neither carries `.dataset-probe`, a `tasks/` segment or a scheme, so both were
# soft-only. These two patterns match the artefact wherever it appears.
#
# Split in two because of the MEASURED HAZARD in the module docstring: the SLASH
# form is specific enough to be hard on `result` as well, while the BARE filename
# occurs in honest English inside recalled lessons ("…the grading
# test_outputs.py…") and is therefore hard on `lookup` only.
ORACLE_ARTIFACT_PATH = re.compile(
    r"""  \btests?[/\\]test_outputs\.(?:py|sh)\b
        | \bsolution[/\\]solve\.(?:sh|py|txt)\b
        | \bsolution[/\\]patch\.diff\b
        | \bsolution\.patch\b
    """,
    re.I | re.X,
)
ORACLE_ARTIFACT_NAME = re.compile(r"\btest_outputs\.(?:py|sh)\b", re.I)

# ── HARD 4: the incident's actual opening move — a SEARCH QUERY ──────────
#
# `github.com laude-institute terminal-bench-2 build-pov-ray tests test.sh` is
# what Rule 1.2's agent typed. It has no scheme, so BENCH_URL cannot see it, and
# no slash-path, so ORACLE_PATH cannot see it. It is three things next to each
# other: a REPO COORDINATE (a forge host or the benchmark's org), the BENCHMARK'S
# NAME, and an ORACLE NOUN. Matched by proximity rather than by one big regex,
# because the separator is a space and the order is not fixed.
#
# The coordinate token is what keeps this off honest traffic, and it was chosen
# from measurement, not taste. The only `terminal-bench` occurrence in the
# `lookup` channel of all 45 committed trials is the brain_search query
# `memcached-backdoor terminal-bench function address hidden command trigger` —
# an agent asking its own memory about the task. That names the benchmark and
# contains a noun, but carries NO forge host and NO benchmark org, so it does not
# fire. Requiring the coordinate is the difference between this rule and a rule
# that quarantines every trial that used its memory.
BENCH_COORD = re.compile(
    r"""\b(?:github|githubusercontent|codeload|gitee|gitlab|bitbucket|sourceforge
             |huggingface|deepwiki|kaggle|gitcode)\.(?:com|io|co|ai|net|org|cn)\b
        | \blaude-institute\b
        | \bharbor-framework\b
        | \btbench\.ai\b
    """,
    re.I | re.X,
)
BENCH_NAME = re.compile(
    r"terminal[-_ ]bench|\btbench\b|\bharbor-framework\b|\blaude-institute\b", re.I
)
ORACLE_NOUN = re.compile(
    r"""  \btest_outputs?\b | \btest\.sh\b | \btests?\b
        | \bsolve\.(?:sh|py)\b | \bsolution\b | \bpatch\.diff\b
        | \bsolution\.patch\b | \breference_\w+ | \banswer[- ]key\b
    """,
    re.I | re.X,
)
# How far apart the three tokens may sit and still count as one query.
BENCH_QUERY_WINDOW = 160


def bench_query_hits(text):
    """Locators for benchmark coordinates sitting next to an oracle noun.

    Yields ONLY the matched tokens joined by `+` — never the window they were
    found in. The window can be arbitrary prose; the tokens are a locator.
    """
    seen = set()
    for coord in BENCH_COORD.finditer(text):
        lo = max(0, coord.start() - BENCH_QUERY_WINDOW)
        window = text[lo : coord.end() + BENCH_QUERY_WINDOW]
        name = BENCH_NAME.search(window)
        noun = ORACLE_NOUN.search(window)
        if not (name and noun):
            continue
        locator = "%s+%s+%s" % (coord.group(0), name.group(0), noun.group(0))
        if locator not in seen:
            seen.add(locator)
            yield locator


def task_tests_pattern(task_name):
    """`<task>/tests/` and `<task>/solution/` — the oracle dirs for THIS task.

    Built per-trial because the task name is the only thing that makes a bare
    `tests/` reference unambiguous. Inside the container the work lives in
    `/app`, never in a directory named after the task, so this shape only
    occurs when something walked the host-side dataset tree.
    """
    if not task_name:
        return None
    return re.compile(
        r"\b%s[/\\](?:tests?|solution)[/\\]" % re.escape(task_name), re.I
    )


# ── SOFT 1: the grader-probe signal ──────────────────────────────────────
#
# Pattern set PORTED (not re-derived) from `packages/terransoul-cli/src/analyze.mjs`
# — its `GRADER_PATHS` constant, applied to its `LOOKUP_FIELDS` narrowing. That
# detector already exists, already runs on every trial, and already earned its
# design the hard way, so this reuses it rather than inventing a second one.
#
# ONE PLACE THIS VERSION GOES FURTHER. analyze.mjs's comment records that field
# narrowing was the fix for a `harbor-canary GUID …` header the agent preserved
# inside content it wrote. Narrowing the FIELDS does not actually cover the
# shakedown case: in `session-window-debug__XLp6nax` the agent ran
#
#     grep -c "harbor-canary GUID <guid>" app/types.py app/DESIGN.md app/__init__.py
#
# to PROVE it had not modified the read-only files — careful, correct behaviour —
# and `harbor` matched inside a `command`, which is a lookup field. So the canary
# marker is stripped before matching. It is the benchmark's own tamper-evidence
# seal; checking it is the opposite of cheating.
GRADER_PROBE = re.compile(
    r"/logs/verifier|\btest_outputs\b|\bharbor\b|\breward\.txt\b|\bexpected_output\b",
    re.I,
)
CANARY = re.compile(r"harbor[-_]canary(\s+GUID)?(\s+[0-9a-fA-F-]{8,})?", re.I)

# ── SOFT 2: the grader-RETURN signal ─────────────────────────────────────
#
# The `result` channel used to be examined by the HARD rules only, so oracle
# material flowing BACK produced no signal at all unless it carried a full URL or
# an anchored path. This reports it.
#
# It is deliberately NOT `GRADER_PROBE`: bare `harbor` is the harness's own name
# and occurs 1115 times in `result` across the committed trials (the canary seal,
# plus our own lessons echoed back by brain_search), so including it would make
# the note fire on nearly every trial and mean nothing.
GRADER_RETURN = re.compile(
    r"/logs/verifier|\btest_outputs\b|\breward\.txt\b|\bexpected_output\b", re.I
)

# ── SOFT 3: 2.1's prose signal, carried over verbatim ────────────────────
#
# An agent that emitted no matching URL or path but is discussing the oracle by
# name. These words also appear in honest reasoning ("I should not look for a
# solve.sh"), so they are REPORTED and never quarantine.
SOFT = re.compile(r"oracle (solution|solve|script)|answer key|the official solve", re.I)

# Tool-call arguments that express a LOOKUP. Everything else an agent passes is
# work product. Ported from analyze.mjs's LOOKUP_FIELDS, plus the argument names
# the Claude Code tool set uses for network and agent-delegation calls.
LOOKUP_FIELDS = (
    "command",
    "pattern",
    "path",
    "file_path",
    "glob",
    "query",
    "url",
    "notebook_path",
    "prompt",
)

# The harness's fallback field for a tool call whose JSON did not parse. Handled
# by `unparsed_lookup_values`, NOT by flattening — see the module docstring.
UNPARSED_FIELD = "__unparsedToolInput"

# Values of these keys are recovered out of an unparsed blob. Intentionally the
# same list as LOOKUP_FIELDS: an authored `content` / `new_string` riding along
# in the same blob stays unmatched.
_UNPARSED_KEY_RX = {
    key: re.compile(r'(?<!\\)"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % key)
    for key in LOOKUP_FIELDS
}


def _texts(value):
    """Every string inside a JSON-ish value, flattened."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            for t in _texts(v):
                yield t
    elif isinstance(value, (list, tuple)):
        for v in value:
            for t in _texts(v):
                yield t


def _lookup_values(value):
    """Lookup-field values inside an already-decoded argument object."""
    if isinstance(value, dict):
        for key, val in value.items():
            if key in LOOKUP_FIELDS:
                for t in _texts(val):
                    if t:
                        yield t
            elif key == UNPARSED_FIELD:
                for t in unparsed_lookup_values(val):
                    yield t
    elif isinstance(value, (list, tuple)):
        for v in value:
            for t in _lookup_values(v):
                yield t


def unparsed_lookup_values(value):
    """Lookup-field values recovered from a `__unparsedToolInput` blob.

    Two independent recoveries, unioned, because the blob is by definition
    malformed and either one alone can fail on it:

      1. `json.JSONDecoder.raw_decode` in a loop. The real occurrences in this
         directory are two JSON objects concatenated (`…}{"command":…`), which
         is exactly what a repeated raw_decode handles and what a single
         `json.loads` chokes on.
      2. A key-targeted textual pass, for a blob truncated mid-object.

    Neither path ever yields a non-lookup value, so an authored `content`
    travelling in the same blob is not scanned.
    """
    out = []
    for raw in _texts(value):
        if not raw:
            continue
        decoder = json.JSONDecoder()
        idx, n = 0, len(raw)
        while idx < n:
            while idx < n and raw[idx].isspace():
                idx += 1
            if idx >= n:
                break
            try:
                obj, end = decoder.raw_decode(raw, idx)
            except ValueError:
                nxt = raw.find("{", idx + 1)
                if nxt < 0:
                    break
                idx = nxt
                continue
            out.extend(_lookup_values(obj))
            idx = end
        for key, rx in _UNPARSED_KEY_RX.items():
            for m in rx.finditer(raw):
                try:
                    out.append(json.loads('"%s"' % m.group(1)))
                except ValueError:
                    out.append(m.group(1))
    seen, uniq = set(), []
    for t in out:
        if isinstance(t, str) and t and t not in seen:
            seen.add(t)
            uniq.append(t)
    return uniq


def _args_lookups(args, out):
    """Append (channel, text) lookup pairs for one tool call's arguments."""
    if not isinstance(args, dict):
        return
    for key in LOOKUP_FIELDS:
        # `_texts` rather than an isinstance(str) guard: a lookup value is not
        # always a bare string (a `path` can arrive as a list), and the old
        # str-only guard silently dropped every one of those.
        for text in _texts(args.get(key)):
            if text:
                out.append(("lookup", text))
    for text in unparsed_lookup_values(args.get(UNPARSED_FIELD)):
        out.append(("lookup", text))


def segments_from_trajectory(path):
    """(channel, text) pairs from an ATIF `agent/trajectory.json`.

    channel is one of prose | lookup | result. Authored content is never
    yielded — see the module docstring.

    Every container is type-guarded. The committed trials are not uniformly
    well-shaped: `ts-gemma4-20260815-210137/memcached-backdoor__EsgyYTS` step 4
    has `"observation": "Bash: target_binary*\\n"` — a STRING where the schema
    says object — and 105 steps across the corpus are the same shape. An
    `obs.get(...)` on that raised AttributeError and took the whole scan down.
    A string observation is not skipped, it IS the tool output, so it is scanned
    as a `result`.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return []
    if not isinstance(doc, dict):
        return []
    out = []
    steps = doc.get("steps")
    for step in steps if isinstance(steps, list) else []:
        if not isinstance(step, dict):
            continue
        msg = step.get("message")
        if isinstance(msg, str) and msg:
            out.append(("prose", msg))
        calls = step.get("tool_calls")
        for call in calls if isinstance(calls, list) else []:
            if isinstance(call, dict):
                _args_lookups(call.get("arguments"), out)
        obs = step.get("observation")
        if isinstance(obs, str):
            if obs:
                out.append(("result", obs))
            continue
        if not isinstance(obs, dict):
            continue
        results = obs.get("results")
        for res in results if isinstance(results, list) else []:
            if isinstance(res, str):
                if res:
                    out.append(("result", res))
                continue
            if not isinstance(res, dict):
                continue
            content = res.get("content")
            for text in _texts(content):
                if text:
                    out.append(("result", text))
    return out


def segments_from_sessions(trial_dir):
    """Fallback for a trial whose trajectory.json is missing or unreadable.

    Claude Code's own `agent/sessions/**/*.jsonl` transcript carries the same
    three channels in a different shape, so a trial that died before the ATIF
    file was written is still scannable rather than silently skipped.
    """
    out = []
    root = os.path.join(trial_dir, "agent", "sessions")
    for jl in sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)):
        try:
            with open(jl, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if not isinstance(ev, dict):
                continue
            message = ev.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            blocks = content if isinstance(content, list) else []
            if isinstance(content, str) and content:
                out.append(("prose", content))
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind == "text" and isinstance(block.get("text"), str):
                    out.append(("prose", block["text"]))
                elif kind == "tool_use":
                    _args_lookups(block.get("input"), out)
                elif kind == "tool_result":
                    for t in _texts(block.get("content")):
                        if t:
                            out.append(("result", t))
    return out


def trial_reward(trial_dir):
    """The reward this trial was awarded, for the report only.

    3.0 keeps it in the per-trial `result.json` under
    verifier_result.rewards.reward; `verifier/reward.txt` is the fallback. 2.1
    only had reward.txt.
    """
    rj = os.path.join(trial_dir, "result.json")
    if os.path.exists(rj):
        try:
            with open(rj, encoding="utf-8", errors="replace") as fh:
                doc = json.load(fh)
            rewards = (doc.get("verifier_result") or {}).get("rewards") or {}
            if "reward" in rewards:
                return float(rewards["reward"])
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    rt = os.path.join(trial_dir, "verifier", "reward.txt")
    if os.path.exists(rt):
        try:
            with open(rt, encoding="utf-8", errors="replace") as fh:
                return float(fh.read().strip())
        except (OSError, ValueError):
            pass
    return None


def trial_task_name(trial_dir):
    """Bare task name, e.g. `session-window-debug`.

    3.0 writes it fully qualified (`terminal-bench/session-window-debug`) in
    result.json / config.json; the trial dir name is `<task>__<id>`, which is
    the fallback when neither file is present.
    """
    for name in ("result.json", "config.json"):
        p = os.path.join(trial_dir, name)
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(doc, dict):
            continue
        task = doc.get("task")
        raw = doc.get("task_name") or (task.get("name") if isinstance(task, dict) else None)
        if isinstance(raw, str) and raw:
            return raw.rsplit("/", 1)[-1]
    base = os.path.basename(trial_dir.rstrip("/\\"))
    return base.split("__", 1)[0] if "__" in base else base


def find_trials(root):
    """Trial dirs under `root`, whether it is a jobs-dir or a single job-dir.

    2.1 hardcoded `<jobs>/<job>/<trial>/`. 3.0 operators point this at either
    level — `jobs-terransoul/` or one `tsvh-…/` job — so both are accepted, and
    a directory only counts as a trial if it actually has an `agent/` dir.
    """
    root = root.rstrip("/\\")
    found = []
    for depth in ("*", os.path.join("*", "*")):
        for cand in sorted(glob.glob(os.path.join(root, depth, ""))):
            cand = cand.rstrip("/\\")
            if not os.path.isdir(os.path.join(cand, "agent")):
                continue
            if cand not in found:
                found.append(cand)
    return found


# Which channels each HARD rule is allowed to quarantine on. A hit on any other
# channel is demoted to a soft note rather than dropped, so nothing goes dark.
HARD_CHANNELS = {
    "bench-repo-url": ("prose", "lookup", "result"),
    "bench-repo-query": ("lookup",),
    "host-oracle-path": ("lookup", "result"),
    "oracle-artifact": ("lookup", "result"),
    "oracle-artifact-name": ("lookup",),
    "task-oracle-dir": ("lookup", "result"),
}


def scan_trial(trial_dir):
    """(status, hard_evidence, soft_evidence) for one trial.

    status is "scanned" or "unscannable". `unscannable` means no evidence was
    read at all — no parseable trajectory step and no session event — so the
    empty hard/soft lists mean "nothing was LOOKED AT", not "nothing was found".
    Callers must never fold that into a clean count; see the module docstring.

    Evidence is (rule, channel, locator). The locator is the matched substring
    or the matched coordinate tokens ONLY — never surrounding context, never
    file content. See the docstring.
    """
    try:
        segs = segments_from_trajectory(
            os.path.join(trial_dir, "agent", "trajectory.json")
        )
        if not segs:
            segs = segments_from_sessions(trial_dir)
    except Exception as exc:  # noqa: BLE001 - a broken trial must not be "clean"
        return "unscannable: %s" % type(exc).__name__, [], []
    if not segs:
        return "unscannable: no readable trajectory or session transcript", [], []

    own_tests = task_tests_pattern(trial_task_name(trial_dir))
    hard, soft = {}, {}

    def record(rule, channel, locator):
        bucket = hard if channel in HARD_CHANNELS.get(rule, ()) else soft
        bucket[(rule, channel, locator[:120])] = True

    for channel, text in segs:
        for m in BENCH_URL.finditer(text):
            if OWN_REPO.search(m.group(0)):
                continue
            record("bench-repo-url", channel, m.group(0))
        for locator in bench_query_hits(text):
            record("bench-repo-query", channel, locator)
        for m in ORACLE_PATH.finditer(text):
            record("host-oracle-path", channel, m.group(0))
        for m in ORACLE_ARTIFACT_PATH.finditer(text):
            record("oracle-artifact", channel, m.group(0))
        for m in ORACLE_ARTIFACT_NAME.finditer(text):
            record("oracle-artifact-name", channel, m.group(0))
        if own_tests:
            for m in own_tests.finditer(text):
                record("task-oracle-dir", channel, m.group(0))
        if channel == "lookup":
            m = GRADER_PROBE.search(CANARY.sub("", text))
            if m:
                soft[("grader-probe", channel, m.group(0)[:60])] = True
        elif channel == "result":
            m = GRADER_RETURN.search(CANARY.sub("", text))
            if m:
                soft[("grader-return", channel, m.group(0)[:60])] = True
        elif channel == "prose":
            m = SOFT.search(text)
            if m:
                soft[("oracle-prose", channel, m.group(0)[:60])] = True
    return "scanned", sorted(hard), sorted(soft)


def scan_jobs(root):
    """(hard, soft, unscannable) trial lists for a jobs-dir or a job-dir."""
    hard, soft, unscannable = [], [], []
    for trial_dir in find_trials(root):
        p = trial_dir.rstrip("/\\")
        trial = os.path.basename(p)
        job = os.path.basename(os.path.dirname(p))
        status, h, s = scan_trial(p)
        reward = trial_reward(p)
        if status != "scanned":
            unscannable.append((trial, job, reward, status))
        elif h:
            hard.append((trial, job, reward, h))
        elif s:
            soft.append((trial, job, reward, s))
    return hard, soft, unscannable


def _table_columns(cur, table):
    try:
        cur.execute("PRAGMA table_info(%s)" % table)
        return {row[1] for row in cur.fetchall()}
    except sqlite3.Error:
        return set()


def scan_brain(db):
    """Rows in a brain store that carry the benchmark's own material forward.

    Rule 1.2 point 3: sweep the store, not only the sessions. One trial cheated
    in 2026-08-08; MEMORY is what turned it into a policy with access_count 23.

    Sweeps three places, not one:
      * `memories.content` — the live body.
      * `memories.source_url` — where a FETCHED url lands. Populated on real
        rows, and it is literally the column an oracle URL would be recorded in.
      * `memory_versions` — because this repo's own recorded lesson is that
        `brain_append` ELIDES the oldest blocks out of the live row while the
        version history retains them, so a contaminated directive can survive
        exactly where a content-only sweep does not look.
    Every column and table is probed first, so an older schema still scans.
    """
    if not os.path.exists(db):
        return []
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    con.text_factory = lambda b: b.decode("utf-8", "replace")
    try:
        cur = con.cursor()
        out, seen = [], set()

        def consider(label, rid, access, body):
            if not body:
                return
            hit = next(
                (m for m in BENCH_URL.finditer(body) if not OWN_REPO.search(m.group(0))),
                None,
            ) or ORACLE_PATH.search(body)
            if not hit:
                return
            key = (label, rid, hit.group(0)[:120])
            if key not in seen:
                seen.add(key)
                out.append((label, rid, access, hit.group(0)[:120]))

        cols = _table_columns(cur, "memories")
        if "content" in cols:
            select = ["id", "content"]
            select.append("access_count" if "access_count" in cols else "NULL")
            select.append("source_url" if "source_url" in cols else "NULL")
            cur.execute("SELECT %s FROM memories" % ", ".join(select))
            for rid, content, access, source_url in cur.fetchall():
                consider("memories", rid, access, content or "")
                consider("memories.source_url", rid, access, source_url or "")

        vcols = _table_columns(cur, "memory_versions")
        if vcols:
            body_col = next(
                (c for c in ("content", "body", "text", "value") if c in vcols), None
            )
            if body_col:
                owner = next(
                    (c for c in ("memory_id", "id", "row_id") if c in vcols), "rowid"
                )
                cur.execute("SELECT %s, %s FROM memory_versions" % (owner, body_col))
                for rid, body in cur.fetchall():
                    consider("memory_versions", rid, None, body or "")
        return out
    finally:
        con.close()


def report(jobs_dir, trials, hard, soft, unscannable, brain, rows, write_to, out):
    """Print the scan report. `out` is the stream; callers force UTF-8 on it."""
    clean = len(trials) - len(hard) - len(soft) - len(unscannable)
    p = lambda line="": print(line, file=out)  # noqa: E731
    p("-- benchmark-integrity scan (Terminal-Bench 3.0) -----------")
    p("  jobs dir            : %s" % jobs_dir)
    p("  trials found        : %d" % len(trials))
    p("  trials scanned      : %d" % (len(trials) - len(unscannable)))
    p("  clean               : %d" % clean)
    p("  unscannable         : %d  (NOT counted clean - no evidence was read)"
      % len(unscannable))
    for trial, job, _reward, status in unscannable:
        p("    UNSCANNABLE %-28s %-40s %s" % (trial, job, status))
    p("  trials reaching the benchmark's own material : %d" % len(hard))
    for trial, job, reward, ev in hard:
        p(
            "    QUARANTINE %-28s %-40s reward=%s"
            % (trial, job, "?" if reward is None else "%.1f" % reward)
        )
        for rule, channel, locator in ev[:4]:
            p("        %-20s [%s] %s" % (rule, channel, locator))
    if soft:
        p(
            "  trials mentioning the grader without reaching it : %d (reported, NOT quarantined)"
            % len(soft)
        )
        for trial, job, _reward, ev in soft[:10]:
            rule, channel, locator = ev[0]
            p(
                "    note       %-28s %-24s %-16s [%s] %r"
                % (trial, job, rule, channel, locator)
            )
    if brain:
        p("  brain rows carrying benchmark material       : %d  (%s)" % (len(rows), brain))
        for label, rid, access, locator in rows:
            p(
                "    ROW %-20s id=%-6s access=%-4s %s"
                % (label, rid, "?" if access is None else access, locator)
            )

    if write_to:
        with open(write_to, "w", encoding="utf-8") as fh:
            for trial, _job, _reward, _ev in hard:
                fh.write(trial + "\n")
        p("  quarantine list written : %s (%d trial(s))" % (write_to, len(hard)))

    if hard or rows:
        p("")
        p("  RESULT: CONTAMINATED - quarantined trials score 0.0; purge the brain rows")
        p("  (rules/bench-agi-purity.md Rule 1.2: never shortcut a bench)")
        return 1
    if unscannable:
        p("")
        p(
            "  RESULT: INCOMPLETE - no contamination found, but %d trial(s) could not be"
            % len(unscannable)
        )
        p("  read at all. 'not scanned' is not 'clean'; re-run with their transcripts")
        p("  restored, or quarantine them by hand before publishing a number.")
        return 4
    p("")
    p("  RESULT: clean")
    return 0


def main(argv):
    # A stock Windows console is cp1252, so any non-ASCII in this report raised
    # UnicodeEncodeError before the first trial was even read — and the process
    # then exited 1, which is the CONTAMINATED code. A scoring step consuming
    # that flagged every job in the sweep. Belt and braces: force UTF-8 here,
    # and keep the report itself ASCII.
    out = sys.stdout
    try:
        out.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

    if len(argv) < 2:
        print(
            "usage: integrity-scan.py <jobs-dir|job-dir> "
            "[--brain <memory.db>] [--write <quarantine.txt>]",
            file=sys.stderr,
        )
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

    trials = find_trials(jobs_dir)
    hard, soft, unscannable = scan_jobs(jobs_dir)
    rows = scan_brain(brain) if brain else []
    return report(
        jobs_dir, trials, hard, soft, unscannable, brain, rows, write_to, out
    )


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - a crash must never look like a verdict
        import traceback

        traceback.print_exc()
        print(
            "integrity-scan: CRASHED - this is exit 3, NOT a contamination verdict.\n"
            "  Nothing was judged. Fix the scanner and re-run before scoring.",
            file=sys.stderr,
        )
        sys.exit(3)
