#!/usr/bin/env python3
# rate-limit-evidence.py -- is a failed trial a SPENT ACCOUNT, or only wearing that label?
#
#   python rate-limit-evidence.py quota            <job-dir>
#   python rate-limit-evidence.py killed-with-work <job-dir>
#   python rate-limit-evidence.py reset-epoch      <job-dir> [<job-dir> ...]
#
# Exit 0 = yes (one TAB-separated line on stdout), 1 = no, 2 = usage, 3 = this
# script itself broke. 3 is deliberately NOT 1: Python's own uncaught-exception
# exit code is 1, so a crash on an unexpected shape would otherwise read as
# "not a quota" and the caller would bank a spent session as a task result.
# Callers treat anything but 0/1 as UNKNOWN and fall back to the old,
# conservative label check.
#
# ONE FILE, TWO CALLERS, ON PURPOSE. run-two-workers.sh asks "is this a quota"
# and sweep-until-done.sh asks "when does it reset". If the two answered from
# separate parsers, the halt could fire on a window the scheduler does not
# consider spent, and the resume would be timed against a different window than
# the one that stopped the sweep. Both read `_spent_windows` below.
#
# ⛔ MEASURED 2026-09-15 18:45:47 (sweep ts09151819). Two redo trials were
# SIGKILLed within the same second -- pytorch-model-cli__2EgAX5d (16,125 output
# tokens, 40 model turns, its own contract check printing "CONTRACT FAILURES:
# NONE" as the last line) and winning-avg-corewars__KgGxXVD (11,402 tokens).
# Both result.json files say `ApiRateLimitError: Command failed (exit 137)`.
# run-two-workers.sh's job_hit_quota returned true on that LABEL alone, so both
# workers printed "QUOTA EXHAUSTED", halted, and sweep-until-done.sh -- finding
# no reset string, because there was no quota -- slept a blind 3600 s.
#
# WHY THE LABEL LIES (read from harbor, not guessed): harbor's
# BaseInstalledAgent.ERROR_PATTERNS starts with
#     ErrorPattern(r"rate.?limit", ApiRateLimitError)
# applied case-insensitively to the agent command's WHOLE stdout, last match
# wins. Claude Code's stream-json transcript emits routine records like
#     {"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning",...
# so ANY failed agent command whose transcript carries one of those records is
# labelled ApiRateLimitError -- exit 137 from a SIGKILL, an owner-pause halt
# kill (the same mislabel fired earlier that day), an OOM kill. The label is a
# needle match on the word "rate_limit", not a statement about the account.
#
# And the account said so in the same file. The killed trials' LAST
# rate_limit_event reads
#     "status":"allowed_warning","unifiedWindows":{"five_hour":{"utilization":0.22,...},
#                                                 "seven_day":{"utilization":0.67,...}}
# -- 22 % of the five-hour window used. A REAL quota looks nothing like it:
#     2026-09-04 polyglot-rust-c   exit 1, ZERO tokens, result record
#         "api_error_status":429,"result":"You've hit your session limit - resets 4:50am (UTC)"
#         last event "status":"rejected", five_hour utilization 1.04
#     2026-09-15 crack-7z-hash     exit 1, 673 output tokens (NOT zero),
#         "api_error_status":429, "resets 4:50pm (UTC)",
#         last event "status":"rejected", five_hour utilization 1, resetsAt 1789404600
#
# HOW TO APPLY: a quota needs POSITIVE evidence -- any one of
#   (a) api_error_status 429 in the exception message or the transcript tail;
#   (b) the CLI's own limit wording ("hit your ... limit", "session limit",
#       "usage limit", "rate limit reached", "limit reached ... resets") --
#       generic CLI phrases, never a task name or task text;
#   (c) the LAST rate_limit_event in agent/claude-code.txt has a status other
#       than allowed / allowed_warning, or some window's utilization >= 1.0.
# The harbor label, a token count and an exit code are NOT evidence either way.
#
# ⛔ (a) AND (b) ARE MATCHED ONLY IN TEXT THE CLI WROTE. The transcript also holds
# every tool result and every command the model typed, and a task about HTTP
# services can print "rate limit reached" all day. So a line counts only when it
# is a `result` / non-init `system` record, a synthetic API-error assistant
# message, or a plain non-record line (stderr the CLI printed directly) -- never
# a `user` (tool result) record or a fragment carrying tool markers. harbor's
# exception message embeds a head+tail copy of the same stdout, split by
# " ... [N chars truncated] ... ", so each side of that marker is judged on its
# own.
import glob
import json
import os
import re
import sys

ALLOWED_STATUSES = {"allowed", "allowed_warning"}
TRANSCRIPTS = (
    os.path.join("agent", "claude-code.txt"),
    # The host-side capture of the same stdout (terransoul_hook.py), written
    # even when `docker cp` could not run. Used only when the first is absent.
    os.path.join("agent", "claude-code.host-capture.txt"),
)
# The text evidence (a) and (b) lives in the CLI's final `result` record, which
# is the LAST line a quota-stopped CLI writes. 256 KiB of tail holds it with a
# wide margin and never reads a multi-megabyte transcript whole.
TAIL_BYTES = 256 * 1024
# The last rate_limit_event can sit near the START of a long transcript (the
# CLI emits one when a threshold is crossed, not per request: the killed
# pytorch trial's last one is line 88 of ~150). So it is found by reading
# BACKWARDS in fixed chunks until the first hit, bounded so a pathological file
# cannot turn a halt decision into a full scan of hundreds of megabytes.
EVENT_SCAN_BUDGET = 64 * 1024 * 1024
CHUNK = 1024 * 1024
EVENT_NEEDLE = b'"rate_limit_event"'

HTTP_429 = re.compile(r"api_error_status\W{0,4}429(?!\d)")
LIMIT_PHRASE = re.compile(
    r"hit your [\w-]*\s*limit"
    r"|session limit"
    r"|usage limit"
    r"|rate limit reached"
    r"|limit reached\W{1,8}resets",
    re.IGNORECASE,
)
TRUNCATION = re.compile(r"\s*\.\.\. \[\d+ chars truncated\] \.\.\.\s*")
STREAM_LABEL = re.compile(r"^(stdout|stderr):\s*")
TOOL_MARKERS = ('"tool_use_id"', '"tool_result"', '"tool_use_result"',
                '"type":"user"', '"type":"tool_use"')
KILLED_HEADER = re.compile(r"^Command failed \(exit 137\)")


# ── reading ─────────────────────────────────────────────────────────────────
def _load_json(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _transcript(trial_dir):
    for rel in TRANSCRIPTS:
        p = os.path.join(trial_dir, rel)
        if os.path.isfile(p):
            return p
    return None


def _read_tail(path, limit=TAIL_BYTES):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            start = max(0, size - limit)
            fh.seek(start)
            data = fh.read()
    except OSError:
        return ""
    if start > 0:
        cut = data.find(b"\n")
        data = data[cut + 1:] if cut >= 0 else b""
    return data.decode("utf-8", errors="replace")


def _lines_backward(path, needle, budget=EVENT_SCAN_BUDGET, chunk=CHUNK):
    """Yield complete lines containing `needle`, LAST first, reading fixed
    chunks from the end. Memory is one chunk plus one line, whatever the file
    size. A line that straddles a chunk boundary is carried into the next read
    so it is only ever yielded whole."""
    try:
        fh = open(path, "rb")
    except OSError:
        return
    with fh:
        fh.seek(0, os.SEEK_END)
        pos = fh.tell()
        carry = b""
        scanned = 0
        while pos > 0 and scanned < budget:
            n = min(chunk, pos)
            pos -= n
            fh.seek(pos)
            buf = fh.read(n) + carry
            scanned += n
            if pos > 0:
                cut = buf.find(b"\n")
                if cut < 0:
                    carry = buf
                    continue
                carry, body = buf[:cut], buf[cut + 1:]
            else:
                carry, body = b"", buf
            for line in reversed(body.split(b"\n")):
                if needle in line:
                    yield line


def _event_info(raw):
    try:
        rec = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(rec, dict) or rec.get("type") != "rate_limit_event":
        return None
    info = rec.get("rate_limit_info")
    return info if isinstance(info, dict) else None


def last_rate_limit_event(trial_dir, message=""):
    """The LAST rate_limit_event this trial recorded, or None."""
    path = _transcript(trial_dir)
    if path:
        for raw in _lines_backward(path, EVENT_NEEDLE):
            info = _event_info(raw)
            if info is not None:
                return info
    # No transcript on disk: harbor's exception message carries a head+tail
    # copy of the same stdout, so the record may still be there.
    for line in reversed((message or "").splitlines()):
        for part in reversed(TRUNCATION.split(STREAM_LABEL.sub("", line.strip()))):
            if '"rate_limit_event"' in part:
                info = _event_info(part)
                if info is not None:
                    return info
    return None


# ── judging ─────────────────────────────────────────────────────────────────
def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _epoch(value):
    v = _num(value)
    if v is None or v <= 0:
        return None
    if v > 1e12:          # milliseconds, defensively; the observed field is seconds
        v /= 1000.0
    return int(v)


def _spent_windows(info):
    """[(window name, reset epoch or None, why)] for every window this event
    says is exhausted. Empty means the account was still serving requests."""
    spent = []
    windows = info.get("unifiedWindows")
    if isinstance(windows, dict):
        for name, w in windows.items():
            if not isinstance(w, dict):
                continue
            u = _num(w.get("utilization"))
            if u is not None and u >= 1.0:
                spent.append((name, _epoch(w.get("resetsAt")), f"{name} window at utilization {u:g}"))
    status = info.get("status")
    top_u = _num(info.get("utilization"))
    rejected = status is not None and status not in ALLOWED_STATUSES
    if rejected or (top_u is not None and top_u >= 1.0):
        name = info.get("rateLimitType") or "top-level"
        why = f"rate_limit_event status {status!r}" if rejected else f"{name} utilization {top_u:g}"
        spent.append((name, _epoch(info.get("resetsAt")), why))
    return spent


def _cli_authored(part):
    """Did the Claude Code CLI write this text, rather than the model or a tool?"""
    try:
        rec = json.loads(part)
    except ValueError:
        rec = None
    if isinstance(rec, dict):
        kind = rec.get("type")
        if kind == "result":
            return True
        if kind == "system":
            return rec.get("subtype") != "init"
        if kind == "assistant":
            msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
            return bool(rec.get("isApiErrorMessage") or rec.get("error")
                        or msg.get("model") == "<synthetic>")
        return False
    if isinstance(rec, (list, str, int, float)) or rec is True or rec is False:
        return False
    # Not a whole record: a plain line the CLI printed, or a fragment of a
    # record cut by harbor's truncation. Fragments of tool traffic are refused.
    if any(m in part for m in TOOL_MARKERS):
        return False
    if '"type":"assistant"' in part:
        return "<synthetic>" in part or "ApiErrorMessage" in part
    return True


def _text_evidence(text):
    for line in (text or "").splitlines():
        line = STREAM_LABEL.sub("", line.strip())
        if not line:
            continue
        for part in TRUNCATION.split(line):
            m429 = HTTP_429.search(part)
            mphrase = None if m429 else ("limit" in part.lower() and LIMIT_PHRASE.search(part))
            if not (m429 or mphrase):
                continue
            if not _cli_authored(part.strip()):
                continue
            if m429:
                return "api_error_status 429"
            return f"CLI limit text {mphrase.group(0)!r}"
    return None


def quota_evidence(trial_dir, result):
    """Positive evidence that the ACCOUNT stopped this trial, or None."""
    info = result.get("exception_info") or {}
    if not isinstance(info, dict) or not (info.get("exception_type") or info.get("exception_message")):
        return None     # a trial without an exception is a result, never a halt
    message = info.get("exception_message") or ""
    ev = _text_evidence(message)
    if ev:
        return f"{ev} in exception_message"
    path = _transcript(trial_dir)
    if path:
        ev = _text_evidence(_read_tail(path))
        if ev:
            return f"{ev} in {os.path.basename(path)} tail"
    event = last_rate_limit_event(trial_dir, message)
    if event is not None:
        spent = _spent_windows(event)
        if spent:
            return f"last rate_limit_event: {spent[0][2]}"
    return None


def _was_killed(trial_dir, message):
    if KILLED_HEADER.search(message or ""):
        return True
    rows = _load_json(os.path.join(trial_dir, "agent", ".terransoul-exec-failure.json"))
    if isinstance(rows, list):
        return any(isinstance(r, dict) and r.get("return_code") == 137 for r in rows)
    return False


def work_evidence(trial_dir, result):
    """Same three sources, same order, as merge-sweep.sh's
    trial_agent_produced_work -- so the sweep never calls a trial "worked" that
    the merge would call a non-run, or the reverse."""
    tokens = (result.get("agent_result") or {}).get("n_output_tokens") or 0
    if isinstance(tokens, (int, float)) and tokens > 0:
        return f"{int(tokens)} output tokens"
    rows = _load_json(os.path.join(trial_dir, "agent", ".terransoul-exec-failure.json"))
    if isinstance(rows, list):
        turns = max((int(r.get("assistant_turns") or 0) for r in rows if isinstance(r, dict)), default=0)
        if turns > 0:
            return f"{turns} model turn(s) in the host-side capture"
    traj = _load_json(os.path.join(trial_dir, "agent", "trajectory.json"))
    if isinstance(traj, dict):
        steps = sum(1 for s in (traj.get("steps") or []) if isinstance(s, dict) and s.get("source") == "agent")
        if steps:
            return f"{steps} agent step(s) in trajectory.json"
    return None


# ── commands ────────────────────────────────────────────────────────────────
def _trials(job_dir):
    for rj in sorted(glob.glob(os.path.join(job_dir, "*", "result.json"))):
        result = _load_json(rj)
        if isinstance(result, dict):
            yield os.path.dirname(rj), result


def cmd_quota(job_dir):
    for trial_dir, result in _trials(job_dir):
        ev = quota_evidence(trial_dir, result)
        if ev:
            print(f"{os.path.basename(trial_dir)}\t{ev}")
            return 0
    return 1


def cmd_killed_with_work(job_dir):
    for trial_dir, result in _trials(job_dir):
        info = result.get("exception_info") or {}
        if not isinstance(info, dict) or info.get("exception_type") != "ApiRateLimitError":
            continue
        if not _was_killed(trial_dir, info.get("exception_message") or ""):
            continue
        if quota_evidence(trial_dir, result):
            continue
        work = work_evidence(trial_dir, result)
        if work:
            print(f"{os.path.basename(trial_dir)}\t{work}")
            return 0
    return 1


def cmd_reset_epoch(job_dirs):
    """The reset of the window that stopped the NEWEST tripping trial. Job dirs
    are judged in the order given (the caller passes newest first); within the
    exhausted windows of one event the LATEST reset wins, because the account
    serves nothing until every spent window has cleared."""
    for job_dir in job_dirs:
        for trial_dir, result in _trials(job_dir):
            if not quota_evidence(trial_dir, result):
                continue
            info = result.get("exception_info") or {}
            event = last_rate_limit_event(trial_dir, info.get("exception_message") or "")
            if event is None:
                continue
            dated = [(epoch, name) for name, epoch, _why in _spent_windows(event) if epoch]
            if dated:
                epoch, name = max(dated)
                print(f"{epoch}\t{os.path.basename(trial_dir)}\t{name}")
                return 0
    return 1


def main(argv):
    if len(argv) < 3 or argv[1] not in ("quota", "killed-with-work", "reset-epoch"):
        sys.stderr.write("usage: rate-limit-evidence.py {quota|killed-with-work} <job-dir> | reset-epoch <job-dir>...\n")
        return 2
    if argv[1] == "quota":
        return cmd_quota(argv[2])
    if argv[1] == "killed-with-work":
        return cmd_killed_with_work(argv[2])
    return cmd_reset_epoch(argv[2:])


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 -- see the exit-code note at the top
        sys.stderr.write(f"rate-limit-evidence.py: internal error: {exc!r}\n")
        sys.exit(3)
