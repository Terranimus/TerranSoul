# -*- coding: utf-8 -*-
"""Terminal-Bench 2.1 agent identity `terransoul`, plus the verify-before-stop hook.

WHY THIS EXISTS, measured rather than assumed.

Across 60 trials of a clean 2.1 sweep the harness had no channel that was both
TIMELY and WIDELY REACHED, which is why four successive attempts at
stop-discipline converted nothing:

  * the stop gate (`brain_verify_completion op:"status"`) is timely, but agents
    invoked it in 12% of trials, and 2.1 wired no Stop hook at all — so
    `build_stop_decision` was essentially never consulted at stop time;
  * the MCP server instructions reach 100% of agents, but arrive once at
    `initialize` inside a ~15k-character block, before any work exists to judge;
  * the `record` response reaches 88% of trials, but agents make a MEDIAN OF ONE
    tool call after their first `record` (33 of 35 make two or fewer) — they
    record as their closing act, so a prompt there lands after everything is
    already decided.

A Stop hook is the missing shape: the HOOK calls `status` on every stop attempt,
so the timely channel goes from 12% to ~100% without asking the agent to
volunteer anything.

WHAT THIS CHANGES, AND WHAT IT DOES NOT. The agent loop, prompts, tools and
model remain Claude Code's, unmodified. This subclass adds exactly one thing:
`@terransoul/{core,cli}` installed in the container so Claude Code's own Stop
hook can invoke `terransoul stop-hook`. The hook's decision logic lives in
`packages/terransoul-cli/src/stop-hook.mjs` and is generic — it reads this
workspace's verification ledger and, for unverified/stale/failed states, asks
for fresh proof. It carries no task knowledge (rules/bench-agi-purity.md).

NAME. Deliberately distinct from the plain `terransoul` identity used by
`terransoul.py`, because a run with a stop gate wired is not the same system as
one without it and a result row must not be able to be misread as the other.
The 91.0% figure on record belongs to `terransoul`, not to this.

INSTALL IS VERIFIED, NOT ASSUMED. A silently-missing hook does not error — it
simply never fires, which reads exactly like "the agent declined the
instruction". That failure mode already cost this campaign one mechanism (a
discovery protocol that was never delivered to a single agent), so the install
below ends by confirming the binary Claude Code will invoke is on PATH inside
the container.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment

_AGENT_CACHE_ENV = "TB_AGENT_CACHE_ID"

# ⛔ STDERR FROM THIS ADAPTER LANDS NOWHERE, MEASURED 2026-09-05.
# `_install_stock_with_retry` promises in its own docstring: "LOUD, because a
# submission has to be able to disclose it: every re-attempt prints to stderr
# and lands in the trial's own log." It does not. Grepping a completed trial
# directory AND the run log for "terransoul-hook" finds only harbor's own
# rendering of the agent NAME -- zero adapter output. So every install retry
# this campaign has performed has been invisible, and the disclosure that
# docstring promises could never have been made.
#
# It cost a diagnosis directly: the agent cache silently failed to capture and
# there was no way to tell whether it had errored, skipped, or never run.
#
# This adapter runs HOST-SIDE, so it can write where the evidence lives.
# Best-effort and never raising: a note channel that can break a trial would be
# worse than no notes at all.
_HOOK_NOTES = Path(__file__).resolve().parents[2] / "mcp-data" / ".tb-hook-notes.jsonl"


def _hook_note(message: str, **fields) -> None:
    """Record an adapter event to stderr AND to a file that outlives the run."""
    print(f"[terransoul-hook] {message}", file=sys.stderr)
    try:
        _HOOK_NOTES.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "sweep": os.environ.get(_AGENT_CACHE_ENV, ""),
            "task": os.environ.get("TB_TASKS", ""),
            "message": message,
        }
        row.update(fields)
        with _HOOK_NOTES.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + chr(10))
    except Exception:  # noqa: BLE001 - notes must never break a trial
        pass


_CORE_PACKAGE_DIR = Path(__file__).resolve().parents[2] / "packages" / "terransoul-core"
_CLI_PACKAGE_DIR = Path(__file__).resolve().parents[2] / "packages" / "terransoul-cli"

# How many times to re-attempt the STOCK agent install, and how long to wait
# between attempts. Env-overridable so a run can disclose or disable it.
_INSTALL_ATTEMPTS = max(1, int(os.environ.get("TB_STOCK_INSTALL_ATTEMPTS", "3")))
_INSTALL_BACKOFF_S = max(0.0, float(os.environ.get("TB_STOCK_INSTALL_BACKOFF_S", "10")))

# ── TBENCH-HOST-SPAWN-RETRY-1: the HOST failed to start `docker`, so the
#    command never ran — and a trial died for it ───────────────────────────────
#
# ⛔ MEASURED 2026-09-08 over the campaign's 347 errored trial directories: 14
# died with return code 3221225794 on a `docker compose` invocation. That is
# `0xC0000142` = `STATUS_DLL_INIT_FAILED`, which Windows returns from the
# LOADER — the process image was created and then failed to initialise, before
# `main`. They arrive in PAIRS AT THE SAME MINUTE (2026-08-27 20:53/20:54,
# 09-04 11:44/11:45, 09-08 00:10, 12:02/12:09, 14:00/14:03), i.e. both workers
# at once, which is the signature of a host-level resource event and not of
# anything either task did.
#
# WHAT IT COSTS. Four of the fourteen surfaced as `AddTestsDirError`: the agent
# had ALREADY FINISHED — `caffe-cifar-10__dFov8SP` ran 11:38→12:09 and wrote a
# 465 KB transcript and a 388 KB trajectory — and the trial was discarded
# because the verifier could not copy its `tests/` directory in to grade the
# work. The leaderboard counts an errored trial as reward 0 and never excludes
# it (leaderboard/SUBMIT.md), so each one subtracts from the headline directly.
# A single loss caps a k=1 sweep of 89 at 98.9%.
#
# ⛔ WHY RETRYING THIS IS A FIRST ATTEMPT, NOT A SECOND — the integrity
# argument, which is the whole reason this is legal where `--retry-include` is
# not. Two independent proofs that the command never executed:
#
#   1. A Linux exit status is 8 BITS. Docker reports an in-container exit code
#      in 0..255, so 3221225794 CANNOT have originated inside the container
#      under any circumstances — it can only be the exit code of the host
#      `docker` process itself. This holds for `exec` too, which is the one
#      subcommand where a naive retry could otherwise re-run agent work.
#   2. All 14 recorded `Stdout: None. Stderr: None.` — zero bytes on both
#      streams. A process that reached `main` and failed would have said
#      something.
#
# Both are required below. A rerun of a process that provably never started is
# the first execution of that command, exactly as `_install_stock_with_retry`
# argues for the pre-agent install, and unlike `--retry-include`, which matches
# on an exception NAME and would hand the task a genuine second attempt.
#
# ⛔ THIS IS NOT A TIMEOUT OR BUDGET CHANGE. The agent, its prompt, its model
# and its wall clock are untouched. What changes is whether a completed trial
# gets GRADED, i.e. whether the number is measured at all.
#
# LOUD: every re-attempt goes through `_hook_note`, which writes to stderr AND
# to `mcp-data/.tb-hook-notes.jsonl`, so a sweep can disclose exactly how many
# fired and on which command.
_HOST_SPAWN_FAILURE_RC = 3221225794  # 0xC0000142 STATUS_DLL_INIT_FAILED
_COMPOSE_ATTEMPTS = max(1, int(os.environ.get("TB_COMPOSE_SPAWN_ATTEMPTS", "4")))
_COMPOSE_BACKOFF_S = max(0.0, float(os.environ.get("TB_COMPOSE_SPAWN_BACKOFF_S", "15")))

# ── TBENCH-HOST-SPAWN-WAIT-1: bridge the OUTAGE, not a fixed number of tries ──
#
# ⛔ MEASURED 2026-09-09 on `sam-cell-seg__c9CHYJ2`. The agent had finished —
# the Stop hook's judge answered `verified: true` at 23:11 — and from 23:20:09
# to at least 23:25:11 EVERY `docker compose` spawn on the host returned
# 0xC0000142 with both streams empty: cp, the tar fallback, exec, down, inspect
# and up, one success in ~20 tries. Four attempts at 15 s cover 45 s; the outage
# lasted five minutes or more, so the retry above fired on every command and
# saved none of them. The trial errored (`AddTestsDirError`), harbor retried it
# from scratch, and that attempt died at `up` inside the same outage.
#
# THE FACT THAT MAKES WAITING CORRECT: the container was untouched. `down` had
# failed too, so `sam-cell-seg__c9chyj2__env-main-1` stayed up with the agent's
# finished work inside it for THIRTY-FIVE HOURS, until Docker Desktop was
# restarted. Nothing about the measurement was lost except the harness's
# willingness to wait for the host. A host spawn failure is by the predicate
# above a command that NEVER RAN, so re-attempting it after ten minutes is
# exactly as legal as re-attempting it after fifteen seconds — and the
# verifier's own `timeout_sec` (harbor wraps `verify()` in `wait_for`) still
# bounds the whole phase, so this cannot hang a sweep.
#
# SHAPE: an OUTAGE CLOCK shared by every compose command in this process. The
# first spawn failure starts it; any spawn success clears it. A command keeps
# re-attempting while EITHER it is still inside the attempt floor above OR the
# outage is younger than TB_HOST_SPAWN_WAIT_S. A host that stays dead therefore
# costs one full wait, after which every later command fails fast at the floor
# instead of each waiting fifteen minutes of its own.
#
# OBSERVABILITY-FIRST (rules/observability-first.md): the cause of the outage
# is NOT known. Nine such events since 2026-08-27 were cross-referenced against
# the Windows event log and matched a GPU live kernel dump (`LiveKernelEvent`
# 193) exactly once and power-session transitions never; "memory pressure from
# leaked containers" cannot explain a single-worker run on a clean host. So
# rather than guess, `_host_snapshot()` records the host's memory, commit
# charge, process count, handle/GDI/USER object totals and the busiest
# processes at the START of an outage and at RECOVERY — read via Win32 calls
# from this process, because spawning a diagnostic tool is the very thing that
# is failing. The recovery note also carries the outage's measured LENGTH,
# which no previous event recorded.
_SPAWN_WAIT_S = max(0.0, float(os.environ.get("TB_HOST_SPAWN_WAIT_S", "900")))
_OUTAGE_STARTED_AT: float | None = None  # monotonic seconds; None = no outage
_OUTAGE_ATTEMPTS = 0  # spawn failures since the outage began, across commands


def _now_monotonic() -> float:
    """Clock the outage is measured on. A module function so tests can fake it."""
    return time.monotonic()


async def _spawn_backoff() -> None:
    """The pause between spawn re-attempts. A module function so tests can fake it."""
    if _COMPOSE_BACKOFF_S:
        await asyncio.sleep(_COMPOSE_BACKOFF_S)


def _outage_mark(label: str, attempt: int) -> tuple[float, bool]:
    """Record one spawn failure. Returns (seconds into the outage, first?)."""
    global _OUTAGE_STARTED_AT, _OUTAGE_ATTEMPTS
    now = _now_monotonic()
    first = _OUTAGE_STARTED_AT is None
    if first:
        _OUTAGE_STARTED_AT = now
        _OUTAGE_ATTEMPTS = 0
    _OUTAGE_ATTEMPTS += 1
    elapsed = now - _OUTAGE_STARTED_AT
    if first:
        _hook_note(
            f"host spawn OUTAGE began on `docker compose {label}` "
            f"(0x{_HOST_SPAWN_FAILURE_RC:X}, both streams empty — the command "
            f"never ran); will re-attempt for up to {_SPAWN_WAIT_S:.0f}s",
            command=label,
            host=_host_snapshot(),
        )
    return elapsed, first


def _outage_may_reattempt(attempt: int, elapsed: float) -> bool:
    """Inside the attempt floor, or the outage is younger than the wait budget."""
    return attempt < _COMPOSE_ATTEMPTS or elapsed < _SPAWN_WAIT_S


def _outage_clear(label: str, attempt: int) -> None:
    """A spawn succeeded: the outage is over. Records its measured length."""
    global _OUTAGE_STARTED_AT, _OUTAGE_ATTEMPTS
    if _OUTAGE_STARTED_AT is None:
        return
    elapsed = _now_monotonic() - _OUTAGE_STARTED_AT
    failures = _OUTAGE_ATTEMPTS
    _OUTAGE_STARTED_AT = None
    _OUTAGE_ATTEMPTS = 0
    _hook_note(
        f"host spawn outage OVER: `docker compose {label}` started on attempt "
        f"{attempt} after {elapsed:.0f}s and {failures} failed spawn(s)",
        command=label,
        attempt=attempt,
        outage_s=round(elapsed, 1),
        outage_failures=failures,
        host=_host_snapshot(),
    )


def _host_snapshot() -> dict:
    """What the HOST looks like right now, without starting a process.

    Windows only; `{}` elsewhere and on any error. Everything here is read
    through Win32 from this process because the condition being diagnosed is
    "the host cannot start a process" — `tasklist`, `nvidia-smi` or `docker
    stats` would fail for the same reason the command under test did.

    The fields are the candidates the campaign has not been able to rule in or
    out: commit charge and physical memory (the WSL-pressure hypothesis), the
    process count and per-process handle / GDI / USER object totals (the
    desktop-heap and handle-exhaustion hypotheses), and the busiest processes
    by handle count, so the next outage names a suspect instead of a pattern.
    """
    if sys.platform != "win32":
        return {}
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.windll.kernel32
        u32 = ctypes.windll.user32
        psapi = ctypes.windll.psapi

        class _MemStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD),
                ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        mem = _MemStatus()
        mem.dwLength = ctypes.sizeof(_MemStatus)
        snap: dict = {}
        if k32.GlobalMemoryStatusEx(ctypes.byref(mem)):
            mb = 1024 * 1024
            snap.update(
                memory_load_pct=int(mem.dwMemoryLoad),
                phys_total_mb=int(mem.ullTotalPhys // mb),
                phys_avail_mb=int(mem.ullAvailPhys // mb),
                commit_limit_mb=int(mem.ullTotalPageFile // mb),
                commit_avail_mb=int(mem.ullAvailPageFile // mb),
            )

        pids = (wintypes.DWORD * 4096)()
        needed = wintypes.DWORD(0)
        if not psapi.EnumProcesses(ctypes.byref(pids), ctypes.sizeof(pids), ctypes.byref(needed)):
            return snap
        count = min(needed.value // ctypes.sizeof(wintypes.DWORD), 4096)
        snap["process_count"] = count

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handles_total = gdi_total = user_total = 0
        by_name: dict[str, int] = {}
        busiest: list[tuple[int, str, int]] = []
        buf = ctypes.create_unicode_buffer(1024)
        for i in range(count):
            pid = pids[i]
            if not pid:
                continue
            h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                continue
            try:
                size = wintypes.DWORD(1024)
                name = "?"
                if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    name = os.path.basename(buf.value).lower()
                hc = wintypes.DWORD(0)
                if k32.GetProcessHandleCount(h, ctypes.byref(hc)):
                    handles_total += hc.value
                gdi = int(u32.GetGuiResources(h, 0))
                usr = int(u32.GetGuiResources(h, 1))
                gdi_total += gdi
                user_total += usr
                by_name[name] = by_name.get(name, 0) + 1
                busiest.append((int(hc.value), name, int(pid)))
            finally:
                k32.CloseHandle(h)
        busiest.sort(reverse=True)
        snap.update(
            handles_total=handles_total,
            gdi_objects_total=gdi_total,
            user_objects_total=user_total,
            busiest_by_handles=[f"{n}:{p}={c}" for c, n, p in busiest[:5]],
        )
        for watched in ("conhost.exe", "docker.exe", "docker-compose.exe", "node.exe",
                        "python.exe", "vmmem", "vmmemwsl", "com.docker.backend.exe"):
            if watched in by_name:
                snap[f"n_{watched.replace('.', '_')}"] = by_name[watched]
        return snap
    except Exception as exc:  # noqa: BLE001 - a diagnostic must never raise
        return {"snapshot_error": type(exc).__name__}


def _is_host_spawn_failure(return_code, stdout, stderr) -> bool:
    """Did the HOST fail to start the process, so the command never ran?

    Both conditions are load-bearing; see the integrity argument above. The
    return code alone is unambiguous, and the empty streams are the
    independent corroboration that nothing reached `main`.
    """
    if return_code != _HOST_SPAWN_FAILURE_RC:
        return False
    return not (stdout or "").strip() and not (stderr or "").strip()


def _message_is_host_spawn_failure(text: str) -> bool:
    """The same verdict read off harbor's `check=True` RuntimeError message.

    `_run_docker_compose_command` raises with the return code and both streams
    interpolated, so the verdict survives the exception boundary without
    re-deriving it from a second source that could drift.
    """
    return (
        f"Return code: {_HOST_SPAWN_FAILURE_RC}." in text
        and "Stdout: None." in text
        and "Stderr: None." in text
    )




# ── TBENCH-TEARDOWN-REAP-1: a trial that dies in teardown LEAKS its container ─
#
# ⛔ MEASURED 2026-09-08. harbor's `stop()` wraps every teardown in
#     try: await self._run_docker_compose_command(["down", ...])
#     except Exception as e: self.logger.warning(f"Docker compose down failed: {e}")
# so when `down` fails the container simply STAYS, and nothing else reaps it.
# `docker ps -a` on this machine found `caffe-cifar-10__vziewm8__env-main-1`
# from that morning plus `mvcc-lsm-compaction__ch8ddwr__verifier__trial-main-1`
# and `memcached-backdoor__kydunhd__env-main-1` still present TWO WEEKS after
# their runs. It is not new; it has simply never been costly enough to notice.
#
# WHY IT IS COSTLY NOW — this closes a FEEDBACK LOOP with the block above.
# Docker's WSL budget is shared by the task containers, the bench brain and
# Ollama (.wslconfig documents the arithmetic). A leaked container holds its
# slice of that budget, host memory pressure rises, and the next process the
# host tries to start fails to initialise — which is TBENCH-HOST-SPAWN-RETRY-1's
# `0xC0000142` exactly. That spawn failure then breaks the NEXT trial's
# teardown, leaking another container. Retrying the spawn treats the symptom;
# reaping here removes the fuel.
#
# ⛔ SCOPE, BECAUSE `docker rm -f` HAS ALREADY GONE WRONG HERE ONCE. On
# 2026-09-07 a blunt `docker rm -f` of three containers killed two LIVE trials,
# because "orphan" had been inferred rather than evidenced. This reaper cannot
# repeat that: it removes ONLY containers labelled
# `com.docker.compose.project=<this environment's own project name>`, computed
# from harbor's own `session_id` via harbor's own sanitiser, and ONLY after
# THIS environment's own teardown has already failed. A container matching that
# label belongs to the trial that is at this moment tearing itself down, so
# there is no state of the world in which it is someone else's live work.
#
# BEST-EFFORT AND SILENT ON FAILURE. If the host cannot start `docker` at all
# — the very condition that produced the leak — the reaper cannot run either.
# It must never turn a logged teardown warning into a raised exception.
_REAP_TEARDOWN = os.environ.get("TB_REAP_LEAKED_CONTAINERS", "1") != "0"


async def _reap_compose_project(project: str, label: str) -> None:
    """Force-remove containers belonging to one compose project. Never raises."""
    try:
        listing = await asyncio.create_subprocess_exec(
            "docker", "ps", "-aq",
            "--filter", f"label=com.docker.compose.project={project}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await listing.communicate()
        ids = [line.strip() for line in (out or b"").decode("utf-8", "replace").splitlines() if line.strip()]
        if not ids:
            return
        remover = await asyncio.create_subprocess_exec(
            "docker", "rm", "-f", *ids,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await remover.wait()
        _hook_note(
            f"reaped {len(ids)} leaked container(s) after `docker compose {label}` "
            f"failed (project {project})",
            project=project,
            containers=len(ids),
        )
    except Exception as exc:  # noqa: BLE001 - a reaper must not break teardown
        _hook_note(
            f"could not reap containers for project {project} "
            f"({type(exc).__name__}); they remain for manual cleanup",
        )


def _compose_project_name(env) -> str | None:
    """This environment's compose project name, via harbor's own sanitiser.

    Re-deriving the name with a local copy of the rules would drift from the
    one harbor actually passes to `--project-name`, and a reaper aimed at the
    wrong label is worse than none: it would report success having removed
    nothing.
    """
    try:
        from harbor.environments.docker.docker import (
            _sanitize_docker_compose_project_name as _sanitize,
        )

        session_id = getattr(env, "session_id", None)
        if not session_id:
            return None
        return _sanitize(str(session_id))
    except Exception:  # noqa: BLE001
        return None


async def _reap_after_failed_teardown(env, label: str) -> None:
    """Teardown failed for this environment — remove ITS containers, only.

    Resolving the project name is the safety interlock: with no name there is
    no label to filter on, and the reaper declines rather than widening its
    scope. A reaper that falls back to "all exited containers" is the
    2026-09-07 mistake with extra steps.
    """
    project = _compose_project_name(env)
    if not project:
        _hook_note(
            f"`docker compose {label}` failed but this environment's compose "
            "project name could not be resolved; declining to reap rather than "
            "removing containers this trial does not own",
        )
        return
    await _reap_compose_project(project, label)


# ── TBENCH-CONTAINER-DEATH-1: record WHY the container went away ─────────────
#
# ⛔ MEASURED 2026-09-08. Five trials since 08-28 died with
# `Agent install failed: 'service "main" is not running'`. The trial log shows
# the sequence but never the cause:
#
#     Skipping image OS validation ...: docker inspect returned 1
#     Running command: ... apt-get ...            -> Command failed
#     Running command: command -v apk             -> Command failed
#     Trial ... failed: Agent install failed: 'service "main" is not running'
#
# Every command after a point fails, then the service is simply gone. The
# container DIED mid-install. Whether that was an OOM kill, a daemon restart or
# the image exiting on its own is exactly what a post-mortem needs and exactly
# what is absent.
#
# THE DIAGNOSIS IS CURRENTLY AN INFERENCE, AND THAT IS THE DEFECT. Two of the
# five are `torch-tensor-parallelism` ONE MINUTE APART (05:42/05:43, i.e. both
# workers), and a third sits inside the 00:10 cluster that also produced a
# `0xC0000142`. That pattern makes host memory pressure the obvious candidate --
# a large torch image running apt-get inside a shared WSL budget -- but
# "obvious" is not measured, and this campaign has repeatedly paid for reading a
# plausible mechanism as a demonstrated one.
#
# `docker inspect` answers it outright: `State.OOMKilled` is a boolean, and
# `State.ExitCode` 137 is SIGKILL. One command at the moment of death turns the
# inference into evidence. Attempting it later is useless -- harbor tears the
# project down, so the container is gone by the time anyone reads the log.
#
# BEST-EFFORT AND NEVER RAISING. This runs on a path that is ALREADY failing;
# a diagnostic that could add an exception of its own would replace a legible
# error with a confusing one.
_DEATH_MARKERS = ('is not running', 'No such container', 'not running')


def _looks_like_container_death(text: str) -> bool:
    """Did this failure happen because the container went away?

    Deliberately narrow. `is not running` is compose's own wording for a
    service that has exited; it is NOT a generic failure string, so this does
    not fire on ordinary non-zero exits from a healthy container.
    """
    return 'is not running' in text or 'No such container' in text


async def _record_container_death(env, label: str) -> None:
    """Note the dead container's exit code and OOM flag. Never raises."""
    project = _compose_project_name(env)
    if not project:
        _hook_note(
            f"`docker compose {label}` reports the service is gone, but this "
            "environment's compose project name could not be resolved, so its "
            "exit state cannot be read",
        )
        return
    try:
        listing = await asyncio.create_subprocess_exec(
            "docker", "ps", "-aq",
            "--filter", f"label=com.docker.compose.project={project}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await listing.communicate()
        ids = [x.strip() for x in (out or b"").decode("utf-8", "replace").split() if x.strip()]
        if not ids:
            _hook_note(
                f"container for project {project} is already REMOVED, so its "
                "exit state is unrecoverable",
                project=project,
            )
            return
        fmt = "{{.Name}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} status={{.State.Status}} err={{.State.Error}}"
        insp = await asyncio.create_subprocess_exec(
            "docker", "inspect", "--format", fmt, *ids,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out2, _ = await insp.communicate()
        for line in (out2 or b"").decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line:
                continue
            # exit=137 is SIGKILL; oom=true is the kernel OOM killer. Either
            # one turns "the container died" into a cause.
            _hook_note(
                f"container death after `docker compose {label}`: {line}",
                project=project,
                container_state=line,
            )
    except Exception as exc:  # noqa: BLE001 - diagnostics must not break a failing path
        _hook_note(
            f"could not read the exit state for project {project} "
            f"({type(exc).__name__})",
        )


def _install_compose_spawn_retry() -> None:
    """Wrap `DockerEnvironment._run_docker_compose_command` with the retry.

    A MONKEYPATCH, DELIBERATELY. harbor is installed as a uv tool, so an edit
    to its `site-packages` is invisible to this repo, unreviewable in a diff
    and erased by the next `uv tool upgrade`. This module is already imported
    into the trial process by import path (`TB_AGENT=terransoul_hook:...`,
    with `$HERE` on PYTHONPATH — see run-dg.sh), and every compose call in the
    trial goes through this one method, so patching it here covers `up`, `cp`,
    `exec` and `down` from a single reviewed place.

    IDEMPOTENT: re-importing the module must not stack wrappers, which would
    multiply the attempt budget instead of applying it.
    """
    try:
        from harbor.environments.docker import docker as _docker_mod
    except Exception as exc:  # noqa: BLE001 - never break import over this
        _hook_note(
            f"could not install the host-spawn retry ({type(exc).__name__}); "
            "compose failures will error the trial as before",
        )
        return

    target = getattr(_docker_mod, "DockerEnvironment", None)
    if target is None:
        _hook_note("harbor exposes no DockerEnvironment; host-spawn retry NOT installed")
        return

    original = getattr(target, "_run_docker_compose_command", None)
    if original is None:
        _hook_note("harbor exposes no _run_docker_compose_command; retry NOT installed")
        return
    if getattr(original, "_terransoul_spawn_retry", False):
        return

    async def _with_spawn_retry(self, command, *args, **kwargs):
        label = " ".join(str(c) for c in command[:2]) if command else "?"
        # `down` / `stop` are the ONLY commands whose failure leaks a container,
        # and the only ones the reaper is allowed to follow.
        is_teardown = _REAP_TEARDOWN and bool(command) and str(command[0]) in ("down", "stop")
        attempt = 0
        elapsed = 0.0
        while True:
            attempt += 1
            try:
                result = await original(self, command, *args, **kwargs)
            except RuntimeError as exc:
                spawn_failure = _message_is_host_spawn_failure(str(exc))
                if spawn_failure:
                    elapsed, _ = _outage_mark(label, attempt)
                if not spawn_failure or not _outage_may_reattempt(attempt, elapsed):
                    if _looks_like_container_death(str(exc)):
                        await _record_container_death(self, label)
                    if is_teardown:
                        await _reap_after_failed_teardown(self, label)
                    raise
            else:
                spawn_failure = _is_host_spawn_failure(
                    getattr(result, "return_code", None),
                    getattr(result, "stdout", None),
                    getattr(result, "stderr", None),
                )
                if spawn_failure:
                    elapsed, _ = _outage_mark(label, attempt)
                if not spawn_failure or not _outage_may_reattempt(attempt, elapsed):
                    if not spawn_failure:
                        _outage_clear(label, attempt)
                    if is_teardown and getattr(result, "return_code", 0) != 0:
                        await _reap_after_failed_teardown(self, label)
                    return result
            # A spawn failure we are going to re-attempt (TBENCH-HOST-SPAWN-WAIT-1).
            # Every attempt inside the floor is noted; past it, one note a minute
            # keeps the evidence channel legible across a long wait.
            if attempt <= _COMPOSE_ATTEMPTS or attempt % 4 == 0:
                _hook_note(
                    f"host could not start `docker compose {label}` "
                    f"(0x{_HOST_SPAWN_FAILURE_RC:X}, both streams empty — the command "
                    f"never ran); attempt {attempt} (floor {_COMPOSE_ATTEMPTS}), "
                    f"{elapsed:.0f}s into the outage of {_SPAWN_WAIT_S:.0f}s allowed, "
                    f"re-attempting in {_COMPOSE_BACKOFF_S:.0f}s",
                    command=label,
                    attempt=attempt,
                    outage_s=round(elapsed, 1),
                )
            await _spawn_backoff()

    _with_spawn_retry._terransoul_spawn_retry = True  # type: ignore[attr-defined]
    target._run_docker_compose_command = _with_spawn_retry
    _hook_note(
        f"host-spawn retry installed ({_COMPOSE_ATTEMPTS} attempts, "
        f"{_COMPOSE_BACKOFF_S:.0f}s backoff)",
    )


_install_compose_spawn_retry()


# ── TBENCH-LATE-API-RETRY-1: a retry matched by NAME must not re-run an attempt
#    that already did the work ─────────────────────────────────────────────────
#
# ⛔ MEASURED 2026-09-09 on `sam-cell-seg__c9CHYJ2`. run-dg.sh passes
# `--retry-include UnknownApiError` (and ApiRateLimitError, ApiInternalServerError)
# on the argument that "a 529/429 is returned BEFORE the model produces a turn,
# so a retry re-attempts THE API CALL, not the task". That is true of the first
# call and false of every later one. harbor's `_run_agent` catches the
# exception, records it, and STILL runs the verifier — by design, it grades
# what is there — and then `TrialQueue._execute_trial_with_retries` matches the
# exception NAME, `shutil.rmtree`s the trial directory, and runs the task again
# with a fresh agent. In that trial the Stop hook's judge had answered
# `verified: true` at 23:11; the note that rides the block forced one more
# turn; THAT call failed (`API Error`); and 45 minutes of finished, gradeable
# work was deleted and re-attempted from scratch. A second attempt at the task
# — the thing the driver's own comment calls cheating — and the loss of the
# only transcript that could have said which API error it was.
#
# THE RULE: a by-name match is NECESSARY, not sufficient. Before re-running,
# ask whether the failed attempt produced agent work. Evidence, in order:
#   1. `agent_result.n_output_tokens` — harbor's own parse of the transcript,
#      populated even on a failed exit (`_sync_agent_output` runs in `finally`);
#   2. the host-side capture `.terransoul-exec-failure.json` written by
#      `TerranSoulHook._classify_exec_error` from the RAW stdout of the failed
#      command — independent of `docker cp`, which is exactly what could not
#      run on 2026-09-09, so (1) would have read None that day;
#   3. an `agent` step in `trajectory.json`.
# Any of them and the result stands as graded, exception preserved as
# provenance (the official number scores an errored trial 0 — merge-sweep.sh —
# so nothing is inflated; what is prevented is the second attempt). None of
# them and the retry proceeds as before, because a trial with no turn is a run
# that never happened (`reference_run_that_never_happened_is_not_a_failure`).
#
# EVIDENCE IS MOVED, NOT DELETED. The failed attempt's directory goes to
# `retried-attempts/<job>/<trial>__attempt<n>/`, OUTSIDE every `jobs*` root the
# audit scripts enumerate (task-regression-audit, served-memory-audit,
# campaign-report all filter on `jobs*` or on `<jobs-dir>/<job>/<trial>`), so
# it can be read after the fact and cannot be counted.
#
# A MONKEYPATCH ON A FINGERPRINT. The replacement is a faithful copy of
# harbor 0.21.0's loop with two changes, and it installs ONLY if the installed
# harbor's method source hashes to the value pinned below. A harbor upgrade
# therefore fails loudly here (and in late-api-retry.test.py, which checks the
# real venv) instead of running a stale copy of a loop that has moved.
_RETRY_LOOP_SOURCE_SHA256 = "92f3dd4fc52e2e1326e52a1ca5015a2008e93fabd61675033e398c1057235fb6"
_RETRIED_ATTEMPTS_DIR = Path(__file__).resolve().parent / "retried-attempts"
_EXEC_FAILURE_SIDECAR = ".terransoul-exec-failure.json"
_HOST_CAPTURE_NAME = "claude-code.host-capture.txt"


def _source_sha256(fn) -> str:
    """Hash of a function's source, line endings normalised."""
    src = inspect.getsource(fn).replace("\r\n", "\n")
    return hashlib.sha256(src.encode("utf-8")).hexdigest()


def _count_assistant_turns(stdout: str | None) -> int:
    """Model turns in a Claude Code `--output-format=stream-json` stream."""
    if not stdout:
        return 0
    turns = 0
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "assistant":
            turns += 1
    return turns


def _capture_failed_exec_on_host(logs_dir, command: str, result) -> None:
    """Keep the evidence of a failed agent command ON THE HOST, at failure time.

    Written before harbor raises, from the raw `ExecResult` — so it exists
    even when the container-side `claude-code.txt` can never be downloaded
    (2026-09-09: every `docker cp` failed for five minutes, and the retry then
    deleted the directory). The sidecar is the work-evidence the retry reads;
    the full-stream copy is the transcript the forensics needed and did not
    have. Never raises.
    """
    try:
        logs_dir = Path(str(logs_dir))
        logs_dir.mkdir(parents=True, exist_ok=True)
        stdout = getattr(result, "stdout", None) or ""
        stderr = getattr(result, "stderr", None) or ""
        turns = _count_assistant_turns(stdout)
        tail = (stdout + "\n" + stderr)[-600:]
        row = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "command": command[:160],
            "return_code": getattr(result, "return_code", None),
            "assistant_turns": turns,
            "stdout_chars": len(stdout),
            "stderr_chars": len(stderr),
            "tail": tail,
        }
        sidecar = logs_dir / _EXEC_FAILURE_SIDECAR
        rows = []
        if sidecar.exists():
            try:
                rows = json.loads(sidecar.read_text(encoding="utf-8"))
                if not isinstance(rows, list):
                    rows = []
            except ValueError:
                rows = []
        rows.append(row)
        sidecar.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        if turns > 0 or "--output-format=stream-json" in command:
            (logs_dir / _HOST_CAPTURE_NAME).write_text(stdout, encoding="utf-8")
        _hook_note(
            f"agent command failed (exit {row['return_code']}) after "
            f"{turns} model turn(s); raw stream kept on the host",
            assistant_turns=turns,
            return_code=row["return_code"],
        )
    except Exception as exc:  # noqa: BLE001 - evidence capture must not break the raise
        _hook_note(f"could not capture the failed command on the host ({type(exc).__name__})")


def _agent_produced_work(result, trial_dir) -> tuple[bool, str]:
    """Did this attempt produce agent work? (verdict, the evidence it rests on)."""
    agent_result = getattr(result, "agent_result", None)
    tokens = getattr(agent_result, "n_output_tokens", None)
    if tokens:
        return True, f"{tokens} output tokens in agent_result"
    trial_dir = Path(str(trial_dir))
    try:
        sidecar = trial_dir / "agent" / _EXEC_FAILURE_SIDECAR
        if sidecar.exists():
            rows = json.loads(sidecar.read_text(encoding="utf-8"))
            turns = max((int(r.get("assistant_turns") or 0) for r in rows), default=0)
            if turns > 0:
                return True, f"{turns} model turn(s) in the host-side capture"
    except Exception:  # noqa: BLE001 - absent or unreadable evidence is not evidence
        pass
    try:
        trajectory = trial_dir / "agent" / "trajectory.json"
        if trajectory.exists():
            steps = (json.loads(trajectory.read_text(encoding="utf-8")) or {}).get("steps") or []
            agent_steps = sum(1 for s in steps if isinstance(s, dict) and s.get("source") == "agent")
            if agent_steps:
                return True, f"{agent_steps} agent step(s) in trajectory.json"
    except Exception:  # noqa: BLE001
        pass
    return False, "no output tokens, no model turn in the host capture, no agent step in the trajectory"


def _preserve_retried_attempt(trial_dir, attempt: int):
    """Move a failed attempt's directory out of the job, keeping it readable."""
    try:
        trial_dir = Path(str(trial_dir))
        if not trial_dir.exists():
            return None
        dest = _RETRIED_ATTEMPTS_DIR / trial_dir.parent.name / f"{trial_dir.name}__attempt{attempt}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        shutil.move(str(trial_dir), str(dest))
        return dest
    except Exception as exc:  # noqa: BLE001 - preservation is best-effort
        _hook_note(f"could not preserve the retried attempt ({type(exc).__name__}); harbor will delete it")
        return None


def _install_work_aware_retry() -> None:
    """Replace `TrialQueue._execute_trial_with_retries` with the work-aware copy."""
    try:
        from harbor.trial.queue import TrialQueue
    except Exception as exc:  # noqa: BLE001 - never break import over this
        _hook_note(
            f"could not install the work-aware retry ({type(exc).__name__}); "
            "by-name retries can re-run a finished attempt as before",
        )
        return
    original = getattr(TrialQueue, "_execute_trial_with_retries", None)
    if original is None:
        _hook_note("harbor exposes no _execute_trial_with_retries; work-aware retry NOT installed")
        return
    if getattr(original, "_terransoul_work_aware", False):
        return
    try:
        actual = _source_sha256(original)
    except (OSError, TypeError) as exc:
        _hook_note(f"could not read harbor's retry loop source ({type(exc).__name__}); work-aware retry NOT installed")
        return
    if actual != _RETRY_LOOP_SOURCE_SHA256:
        _hook_note(
            "harbor's retry loop source has CHANGED "
            f"(sha256 {actual[:12]}…, pinned {_RETRY_LOOP_SOURCE_SHA256[:12]}…); "
            "work-aware retry NOT installed — a by-name retry can again hand a "
            "finished task a second attempt. Re-read TrialQueue._execute_trial_with_retries "
            "and re-pin.",
        )
        return

    async def _execute_trial_with_retries(self, trial_config):
        """harbor 0.21.0's loop, verbatim except the two marked blocks."""
        from harbor.trial.trial import Trial

        for attempt in range(self._retry_config.max_retries + 1):
            trial = await Trial.create(trial_config)
            self._setup_hooks(trial)
            result = await trial.run()

            if result.exception_info is None:
                return result

            if not self._should_retry_exception(result.exception_info.exception_type):
                self._logger.debug(
                    "Not retrying trial because the exception is not in "
                    "include_exceptions or the maximum number of retries has been "
                    "reached"
                )
                return result
            if attempt == self._retry_config.max_retries:
                self._logger.debug(
                    "Not retrying trial because the maximum number of retries has been "
                    "reached"
                )
                return result

            # ── TerranSoul (1): the by-name match is necessary, not sufficient ──
            exc_type = result.exception_info.exception_type
            worked, evidence = _agent_produced_work(result, trial.paths.trial_dir)
            if worked:
                _hook_note(
                    f"{exc_type} AFTER the agent produced work ({evidence}); NOT "
                    "re-running the task — that would be a second attempt. The "
                    "graded result stands and the exception is preserved as provenance",
                    trial=trial_config.trial_name,
                    exception=exc_type,
                    evidence=evidence,
                )
                return result

            # ── TerranSoul (2): keep the failed attempt, do not delete it ──
            kept = _preserve_retried_attempt(trial.paths.trial_dir, attempt + 1)
            _hook_note(
                f"{exc_type} before any agent work ({evidence}); re-attempting as a "
                f"first attempt ({attempt + 2} of {self._retry_config.max_retries + 1})"
                + (f"; the failed attempt is kept at {kept}" if kept else ""),
                trial=trial_config.trial_name,
                exception=exc_type,
            )
            if kept is None:
                shutil.rmtree(trial.paths.trial_dir, ignore_errors=True)

            delay_sec = self._calculate_backoff_delay_sec(attempt)

            self._logger.debug(
                f"Trial {trial_config.trial_name} failed with exception "
                f"{result.exception_info.exception_type}. Retrying in "
                f"{delay_sec:.2f} seconds..."
            )

            await asyncio.sleep(delay_sec)

        raise RuntimeError(
            f"Trial {trial_config.trial_name} produced no result. This should never "
            "happen."
        )

    _execute_trial_with_retries._terransoul_work_aware = True  # type: ignore[attr-defined]
    TrialQueue._execute_trial_with_retries = _execute_trial_with_retries
    _hook_note("work-aware retry installed (by-name retries refused once the agent has produced work)")


_install_work_aware_retry()


# ── TBENCH-LATE-API-RETRY-2: the guard above is installed BY the trial it was
#    meant to guard, so it had never once fired ──────────────────────────────
#
# ⛔ MEASURED 2026-09-13 on `sam-cell-seg__EXhTsdQ`
# (job redo09130729-20260913-073414). The container credential died mid-trial
# at ~08:16 -- "Failed to authenticate. API Error: 401 OAuth access token has
# expired" -- after the agent had produced 98 model turns and a 430-line
# transcript. harbor then retried BY NAME twice (job.log lines 40 and 80:
# `Trial sam-cell-seg__EXhTsdQ failed with exception UnknownApiError. Retrying
# in 1.00 seconds...`, which is harbor/trial/queue.py:227) and
# `agent/claude-code.txt` came back 5 lines long. Precisely the loss
# TBENCH-LATE-API-RETRY-1 exists to prevent, in the first job that reached a
# by-name retry after it shipped.
#
# IT WAS NOT THE FINGERPRINT, AND NOT A DEAD NOTE CHANNEL. The installed
# harbor's loop still hashes to the pinned 92f3dd4f… (re-verified against the
# venv), and `work-aware retry installed` printed at 07:34:20. `_hook_note`
# rows from 08:22:51, 08:25:44 and 08:28:32 sit in
# mcp-data/.tb-hook-notes.jsonl on either side of the retry, while NEITHER of
# the replacement loop's two decision notes appears anywhere -- and both are
# unconditional on every path that reaches the "Retrying in" line. The
# replacement loop simply did not run.
#
# THE CAUSE IS A LOAD-ORDER INVERSION. harbor imports this module from
#   Trial.__init__ -> Trial._init_agent -> AgentFactory.create_agent_from_config
#   -> import_class("terransoul_hook:TerranSoulHook")
# (harbor/trial/trial.py:123 and :843, harbor/utils/import_path.py:18), and
# `trial = await Trial.create(trial_config)` is the FIRST STATEMENT INSIDE the
# loop body (harbor/trial/queue.py:199). So the import that installs the patch
# runs while `TrialQueue._execute_trial_with_retries` IS ALREADY EXECUTING.
# Python resolved `self._execute_trial_with_retries` back at `_run_trial`
# (harbor/trial/queue.py:242), before this module existed, and rebinding a
# class attribute cannot redirect a coroutine that is already in flight. The
# replacement loop therefore takes effect from the NEXT call onward: never for
# the first trial of a job, and never at all for a single-task redo
# (`-k 1 -n 1`), which is the shape every forensic re-run uses. The ledger
# agrees -- 17 `work-aware retry installed` rows, ZERO decision rows.
#
# THE FIX IS TO DECIDE WHERE THE RUNNING LOOP STILL ASKS. Both copies of the
# loop call `self._should_retry_exception(...)` once per iteration, and a method
# call is resolved at call time, so a wrapper on that method reaches the stock
# frame that is already mid-flight. Answering False makes the stock loop take
# its own `return result` path: the graded result stands, the exception is
# preserved as provenance, and nothing is deleted or re-attempted. The evidence
# the decision needs comes from the CALLER'S FRAME (`trial`, `result`,
# `attempt`), whose names are fixed by the very fingerprint the loop copy is
# already pinned to; if a harbor upgrade renames them this fails OPEN and LOUD
# (the note below) instead of silently.
#
# ⛔ AND A 401 MUST NEVER BE RETRIED BY NAME AT ALL. Both re-attempts above died
# at their first API call with the same dead credential -- 1 model turn,
# `"api_error_status":401`, `OAuth access token has been revoked` -- because the
# token is fixed for the life of a harbor process: a fresh environment cannot
# get a fresh credential. harbor's own taxonomy already says this, it just never
# reaches this shape. `AgentAuthenticationError` is in the DEFAULT
# `exclude_exceptions` (harbor/models/job/config.py:298, and exclude beats
# include), but its only pattern is `Not logged in`
# (harbor/agents/installed/base.py:476), so a 401 falls through to the
# `API Error` catch-all (base.py:507), becomes `UnknownApiError`, and matches
# `--retry-include UnknownApiError` by name. `_reclassify_auth_failure` below
# returns harbor's OWN excluded class instead -- a correction of the
# classification, not a new retry policy -- and the gate refuses it a second
# time in case anything reaches it unclassified.
_AUTH_TERMINAL_PATTERNS = (
    # PRECISION FIRST (a gate's precision is measured before it ships). Every
    # needle is either a string MEASURED in a failed trial's own stream or a
    # STRUCTURAL key from the provider's error body. A bare "401" is
    # deliberately absent: a task's own output can print one, and a false
    # positive here suppresses every later by-name retry in the process.
    r"OAuth access token has (?:expired|been revoked)",   # measured, both variants
    r'"api_error_status"\s*:\s*401',                      # Claude Code's result JSON
    r"Failed to authenticate\.?\s*API Error",             # measured phrase, 2026-09-13
    r"API Error:?\s*401\b",                               # a 401 named as an API error
    r'"type"\s*:\s*"authentication_error"',               # Anthropic's error body
)
_AUTH_TERMINAL_RE = re.compile("|".join(_AUTH_TERMINAL_PATTERNS), re.IGNORECASE)

# The needle of the first credential failure seen in this process, if any. The
# credential arrives in the environment at launch and cannot be replaced while
# the process lives, so once it has failed, every later by-name retry can only
# burn a trial.
_AUTH_TERMINAL_SEEN: str | None = None


def _auth_failure_signature(*texts) -> str | None:
    """The needle proving a failure is an expired/revoked credential, or None."""
    for text in texts:
        if not text:
            continue
        match = _AUTH_TERMINAL_RE.search(str(text))
        if match:
            return match.group(0)[:80]
    return None


def _attempt_error_text(result, trial_dir) -> str:
    """Everything this attempt recorded about WHY it failed.

    `exception_message` is harbor's own `detail` string, which keeps the HEAD
    AND THE TAIL of the agent's stream around a middle elision (verified in the
    2026-09-13 trial's `exception.txt`: the 401 line survives at the tail). The
    host-side sidecar is read as well, because it exists even when the
    container-side copy could never be downloaded.
    """
    parts = []
    info = getattr(result, "exception_info", None)
    for attr in ("exception_type", "exception_message"):
        value = getattr(info, attr, None)
        if value:
            parts.append(str(value))
    try:
        sidecar = Path(str(trial_dir)) / "agent" / _EXEC_FAILURE_SIDECAR
        if sidecar.exists():
            rows = json.loads(sidecar.read_text(encoding="utf-8"))
            for row in rows if isinstance(rows, list) else []:
                if isinstance(row, dict) and row.get("tail"):
                    parts.append(str(row["tail"]))
    except Exception:  # noqa: BLE001 - absent or unreadable evidence is not evidence
        pass
    return "\n".join(parts)


def _deciding_attempt():
    """`(trial, result, attempt, loop_is_ours)` for the attempt being decided.

    Read out of the CALLER'S frame, because that caller IS the retry loop and is
    the only thing holding them. Walks a few frames rather than trusting a fixed
    depth, and returns None when the names are absent so the caller can behave
    exactly as harbor would. `sys._getframe` is CPython-only, which is what
    harbor runs on.
    """
    try:
        frame = sys._getframe(2)
    except Exception:  # noqa: BLE001 - introspection must never break a trial
        return None
    for _ in range(4):
        if frame is None:
            return None
        local = frame.f_locals
        if "trial" in local and "result" in local:
            ours = Path(frame.f_code.co_filename).name == Path(__file__).name
            return local.get("trial"), local.get("result"), local.get("attempt"), ours
        frame = frame.f_back
    return None


def _install_retry_decision_gate() -> None:
    """Make `TrialQueue._should_retry_exception` work-aware and auth-terminal.

    Wrapping this method instead of the loop is what makes the guard reach the
    FIRST trial of a job: see TBENCH-LATE-API-RETRY-2 above. It only ever
    REMOVES retries -- harbor's own answer is computed first, and a False is
    returned unchanged.
    """
    try:
        from harbor.trial.queue import TrialQueue
    except Exception as exc:  # noqa: BLE001 - never break import over this
        _hook_note(
            f"could not install the retry decision gate ({type(exc).__name__}); "
            "a by-name retry can re-run a finished first trial as before",
        )
        return
    original = getattr(TrialQueue, "_should_retry_exception", None)
    if original is None:
        _hook_note("harbor exposes no _should_retry_exception; retry decision gate NOT installed")
        return
    if getattr(original, "_terransoul_retry_gate", False):
        return

    def _should_retry_exception(self, exception_type: str) -> bool:
        global _AUTH_TERMINAL_SEEN
        allowed = original(self, exception_type)
        if not allowed:
            return False

        decided = _deciding_attempt()
        if decided is None:
            _hook_note(
                f"{exception_type} matched --retry-include, but the deciding frame "
                "exposed no `trial`/`result`, so the attempt's work could not be "
                "checked; ALLOWING the retry exactly as harbor would. Re-read "
                "TrialQueue._execute_trial_with_retries and re-pin.",
                exception=exception_type,
            )
            return True
        trial, result, attempt, loop_is_ours = decided
        trial_dir = getattr(getattr(trial, "paths", None), "trial_dir", None)
        trial_name = getattr(getattr(trial, "config", None), "trial_name", None)
        max_retries = getattr(getattr(self, "_retry_config", None), "max_retries", None)

        # On the LAST attempt the loop returns the result on its very next line
        # whatever this answers, so deciding here would only file a note about a
        # retry that was never going to happen.
        if isinstance(attempt, int) and isinstance(max_retries, int) and attempt >= max_retries:
            return allowed

        needle = _auth_failure_signature(_attempt_error_text(result, trial_dir))
        if needle and _AUTH_TERMINAL_SEEN is None:
            _AUTH_TERMINAL_SEEN = needle
        if _AUTH_TERMINAL_SEEN is not None:
            _hook_note(
                f"STOPPING by-name retries: {exception_type} carries an expired or "
                f"revoked credential ({_AUTH_TERMINAL_SEEN!r}). The token is fixed for "
                "the life of this harbor process, so a fresh environment gets the same "
                "401 at its first call -- measured twice on 2026-09-13, one model turn "
                "each. Refusing this retry and every later one; refresh the credential "
                "and relaunch (token-refresh.sh now derives its headroom gate from the "
                "task ceiling).",
                trial=trial_name,
                exception=exception_type,
                signature=_AUTH_TERMINAL_SEEN,
            )
            return False

        worked, evidence = _agent_produced_work(result, trial_dir)
        if worked:
            _hook_note(
                f"{exception_type} AFTER the agent produced work ({evidence}); NOT "
                "re-running the task — that would be a second attempt. The "
                "graded result stands and the exception is preserved as provenance",
                trial=trial_name,
                exception=exception_type,
                evidence=evidence,
            )
            return False

        # No work: this attempt is a run that never happened and IS re-run. The
        # stock loop is about to `shutil.rmtree` its directory two lines from
        # here, so the evidence is moved out first -- unless the loop in flight
        # is our own copy, which preserves it itself.
        if not loop_is_ours and trial_dir is not None and isinstance(attempt, int):
            kept = _preserve_retried_attempt(trial_dir, attempt + 1)
            _hook_note(
                f"{exception_type} before any agent work ({evidence}); re-attempting "
                "as a first attempt"
                + (f"; the failed attempt is kept at {kept}" if kept else ""),
                trial=trial_name,
                exception=exception_type,
            )
        return True

    _should_retry_exception._terransoul_retry_gate = True  # type: ignore[attr-defined]
    TrialQueue._should_retry_exception = _should_retry_exception
    _hook_note(
        "retry decision gate installed (reaches the FIRST trial, which the loop copy cannot)"
    )


def _reclassify_auth_failure(exc, result):
    """An expired or revoked credential is harbor's `AgentAuthenticationError`.

    Not a new policy: harbor already refuses to retry that class by default
    (harbor/models/job/config.py:298) and its own docstring calls it "no login".
    What it lacks is the pattern -- `Not logged in` only (base.py:476) -- so the
    401 measured on 2026-09-13 fell through to the `API Error` catch-all, became
    `UnknownApiError`, and was retried twice by name. Returning harbor's class
    puts the failure back where harbor's own taxonomy already put it.
    """
    try:
        from harbor.agents.installed.base import AgentAuthenticationError
    except Exception:  # noqa: BLE001 - a harbor without the class keeps harbor's answer
        return exc
    if isinstance(exc, AgentAuthenticationError):
        return exc
    needle = _auth_failure_signature(
        getattr(result, "stdout", None), getattr(result, "stderr", None)
    )
    if not needle:
        return exc
    _hook_note(
        f"re-classified {type(exc).__name__} as AgentAuthenticationError ({needle!r}): "
        "the credential is expired or revoked, so no re-attempt of this command can "
        "succeed. harbor excludes AgentAuthenticationError from retries by default.",
        signature=needle,
    )
    return AgentAuthenticationError(str(exc))


_install_retry_decision_gate()


def _cache_is_populated(path) -> bool:
    """Does this directory hold a real captured agent tree?

    `lexists`, NOT `exists`: `bin/claude` is a SYMLINK into
    `share/claude/versions/<v>`, and `exists()` FOLLOWS it. On a Windows host
    that target may not resolve, so `exists()` answers False for a tree that is
    actually complete -- the same trap that made capture discard a perfectly
    good copy twice (measured 2026-09-05).

    Swallows everything: a cache probe that raises is not an optimisation.
    """
    try:
        return os.path.lexists(os.path.join(str(path), "bin", "claude"))
    except Exception:  # noqa: BLE001 - see _agent_cache_root's containment note
        return False


# ⛔ AN END-OF-LIFE DISTRO POISONS ITS OWN BAKED apt INDEX. MEASURED 2026-09-08.
# qemu-alpine-ssh and qemu-startup failed setup 8 and 9 times across days, always
# before the agent started, and the diagnosis that was carried for two of those
# days was WRONG: `apt-get update` SUCCEEDS in the trial log (Hit:1 Hit:2 Hit:3).
#
# The real sequence, reproduced in ~40 s on the task image itself:
#   1. the image bakes /var/lib/apt/lists at build time (Oct 2025);
#   2. Debian 11 LTS ended 2026-08-31, so the frozen bullseye-security InRelease
#      still matches the mirror byte-for-byte -- apt prints `Hit` and USES it;
#   3. that index names libcurl4 ...deb11u16 and friends, which the post-EOL
#      security POOL has pruned => 404, exit 100, and harbor's
#      ensure_system_dependencies raises NonZeroAgentExitCodeError.
#
# Three obvious repairs were measured and are recorded because they FAIL:
#   A  Acquire::Check-Valid-Until=false  -> update 0, install 100. Accepting the
#      expired index changes nothing; the POOL is what was pruned.
#   B  retire the -security suite        -> update 0, install 100. libssl-dev
#      needs libssl1.1 (= ...deb11u1); main/updates offers ...deb11u8.
#   C  repoint at archive.debian.org     -> update 100. archive drops
#      bullseye-updates, so one configured suite has no index at all.
#
# What is actually required is not a reachable mirror but an index and a pool
# that are CONSISTENT WITH EACH OTHER, and Debian ships exactly that -- the
# image's own sources.list already carries commented snapshot.debian.org lines
# pinned to a timestamp contemporaneous with the image. This swaps to them.
#
# GENERIC BY CONSTRUCTION: no distro, suite, or timestamp is named here. The pin
# is read out of whatever the image itself shipped, and the whole block is
# reached ONLY after the ordinary install has already failed to produce the
# dependencies -- so it can never make a working image worse. If the swapped
# index does not fetch, the backup is restored and the stock path resumes.
#
# It also leaves the box BETTER than it found it: snapshot Release files are
# expired by design, so the apt.conf drop-in is what keeps a later bare
# `apt-get update` -- which 80 of 89 graders run after the agent stops -- exiting
# 0 instead of 100, which is what it does today.
_APT_EOL_SNAPSHOT_REPAIR = r"""
set -u
sl=/etc/apt/sources.list
[ -f "$sl" ] || { echo REPAIR_UNAVAILABLE; exit 0; }
grep -q '^#[[:space:]]*deb[[:space:]].*snapshot\.debian\.org' "$sl" || { echo REPAIR_UNAVAILABLE; exit 0; }
cp "$sl" "$sl.ts-bak"
sed -i -e 's|^deb[[:space:]]|#ts-eol-live deb |' "$sl"
sed -i -e 's|^#[[:space:]]*\(deb[[:space:]].*snapshot[.]debian[.]org.*\)$|\1|' "$sl"
grep -q '^deb[[:space:]]' "$sl" || { mv -f "$sl.ts-bak" "$sl"; echo REPAIR_UNAVAILABLE; exit 0; }
echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99ts-eol-snapshot
rm -rf /var/lib/apt/lists/*
O="-o Acquire::Retries=8 -o Acquire::Queue-Mode=access -o Acquire::http::Pipeline-Depth=0 -o Acquire::http::Timeout=30"
if ! apt-get $O update >/dev/null 2>&1; then
  mv -f "$sl.ts-bak" "$sl"
  rm -f /etc/apt/apt.conf.d/99ts-eol-snapshot
  rm -rf /var/lib/apt/lists/*
  apt-get update >/dev/null 2>&1
  echo REPAIR_REVERTED
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
for i in 1 2 3 4; do
  apt-get $O install -y --fix-missing curl bash nodejs npm procps >/dev/null 2>&1 && break
  sleep 3
done
if command -v curl >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v pgrep >/dev/null 2>&1; then
  echo REPAIR_OK
else
  echo REPAIR_INCOMPLETE
fi
"""

class TerranSoulHook(ClaudeCode):
    """Claude Code's loop under the TerranSoul identity, with the Stop hook wired."""

    @staticmethod
    @override
    def name() -> str:
        return "terransoul-hook"

    @override
    def _classify_exec_error(self, command: str, result):
        """harbor's classification, after keeping the failed command's evidence on the host.

        See TBENCH-LATE-API-RETRY-1: the raw `result` here is the only copy of
        the agent's stream that does not depend on `docker cp` succeeding later.

        And TBENCH-LATE-API-RETRY-2: this is also the only place that sees the
        UNTRUNCATED stream, so it is where an expired or revoked credential is
        put back into harbor's own `AgentAuthenticationError` — the class harbor
        already excludes from retries — instead of the `UnknownApiError` its
        pattern list assigns a 401 by accident.
        """
        _capture_failed_exec_on_host(self.logs_dir, command, result)
        return _reclassify_auth_failure(
            super()._classify_exec_error(command, result), result
        )

    async def _install_stock_with_retry(self, environment: BaseEnvironment) -> None:
        """Run the stock install, re-attempting it if the ENVIRONMENT breaks.

        ⛔ THE TRIALS THIS RECOVERS NEVER RAN THE AGENT, AND THAT IS THE WHOLE
        JUSTIFICATION. `super().install()` shells out to the upstream installer,
        whose first step is
        `apt-get update && apt-get install -y curl procps` (or the apk/yum
        equivalent). That is a network fetch of Ubuntu package lists on EVERY
        trial, and when it dies the agent has not started, produced a turn, or
        seen the task.

        MEASURED across this campaign's 457 trial directories: 120 produced no
        grade at all, and 80 of those died on that one command --
        `NonZeroAgentExitCodeError ... exit 137` (SIGKILL, container OOM) before
        2026-08-07, and `exit 143` (SIGTERM, timed out) after it. The exit-137
        cluster is entirely 2026-08-04..06 and was addressed by the two-worker
        rule; exit-143 is what still happens, and it accounted for 4 of the 5
        ungraded trials since.

        WHY IT MATTERS BEYOND WASTED SPEND: the leaderboard counts an errored
        trial as reward 0 and never excludes it (leaderboard/SUBMIT.md). An
        install-failure rate therefore subtracts from the headline directly --
        this harness already recorded one such episode moving a result from
        93.5% to 76.3% (run-dg.sh, TBENCH-API-RETRY-1). Setup losses are not
        noise around the measurement, they ARE the measurement.

        ⛔ WHY NOT `--retry-include NonZeroAgentExitCodeError`. That was the
        obvious fix and it is WRONG. Harbor raises that exception from `_exec`
        for ANY non-zero command, including ones run AFTER the agent has taken
        its turn, and `--retry-include` matches on the exception NAME alone. It
        would therefore buy the agent a second attempt at the task, which is
        cheating -- exactly the footgun run-dg.sh's own comment warns about at
        the `--retry-include` block. Retrying HERE cannot do that: this wraps
        one call that provably precedes the agent, so no reachable failure it
        catches is a task attempt.

        This is the same principle the harness already applies to
        `AgentSetupTimeoutError` ("a retry does not hand the task a second
        attempt at solving anything -- it re-attempts the INSTALL"), applied to
        the failure that is actually happening.

        LOUD, because a submission has to be able to disclose it: every
        re-attempt prints to stderr and lands in the trial's own log.
        """
        last: Exception | None = None
        for attempt in range(1, _INSTALL_ATTEMPTS + 1):
            try:
                await super().install(environment)
                if attempt > 1:
                    _hook_note(
                        f"stock install succeeded on attempt {attempt}"
                        f" of {_INSTALL_ATTEMPTS}",
                    )
                return
            except Exception as exc:  # noqa: BLE001 - re-raised below if terminal
                last = exc
                if attempt == _INSTALL_ATTEMPTS:
                    break
                _hook_note(
                    f"stock install attempt {attempt} of "
                    f"{_INSTALL_ATTEMPTS} failed ({type(exc).__name__}: "
                    f"{str(exc)[:200]}); the agent has not run, re-attempting the "
                    f"INSTALL in {_INSTALL_BACKOFF_S:.0f}s",
                )
                # A bare retry re-hits the same slow mirror; give it a moment.
                if _INSTALL_BACKOFF_S:
                    await asyncio.sleep(_INSTALL_BACKOFF_S)
        assert last is not None
        _hook_note(
            f"stock install FAILED all {_INSTALL_ATTEMPTS} "
            f"attempts; the trial will error without the agent ever running",
        )
        raise last

    # ── TBENCH-INSTALL-CACHE-1: pay the agent download ONCE PER SWEEP ────────────
    #
    # ⛔ MEASURED 2026-09-05 over 305 trials since 2026-09-01: 5 died with
    # `AgentSetupTimeoutError` (1.6%) before the agent ran. At 89 tasks that is a
    # ~76% chance of losing at least one trial per sweep to setup alone, and the
    # leaderboard counts an errored trial as reward 0 and never excludes it. A
    # single such loss caps a sweep at 98.9%, so this is the binding constraint on
    # a clean run, not a nuisance.
    #
    # THE COST IS A DOWNLOAD REPEATED 89 TIMES. `ClaudeCode.install()` runs
    #     curl -fsSL .../claude-code-releases/bootstrap.sh | bash -s --
    # in EVERY trial, fetching a ~297 MB binary. On an idle machine that is ~28 s;
    # with two workers pulling at once plus disk load it crosses the 360 s
    # agent-setup budget and the trial dies before the agent starts. A k=1 sweep
    # pulls ~26 GB of one identical file.
    #
    # THE FIX IS THE SHORT-CIRCUIT UPSTREAM ALREADY HAS. `install()` begins with
    # `_installed_claude_satisfies_version()` and returns immediately when `claude`
    # is already on PATH at the requested version -- skipping the download AND the
    # apt-get. So restoring a cached `~/.local` before calling it removes the whole
    # setup cost rather than making a slow setup permissible.
    #
    # ⛔ WHY THIS IS NOT A TIMEOUT OVERRIDE. The 360 s budget is untouched and no
    # exception is retried. Setup becomes fast instead of being allowed to be slow,
    # which is why it needs no disclosure carve-out of the kind `--retry-include`
    # does. The agent, its version and its budget are identical either way.
    #
    # ⛔ THE INTEGRITY TRAP, AND WHY THE CACHE EXPIRES. When no version is pinned,
    # `_installed_claude_satisfies_version` only checks that `claude` EXISTS. A
    # permanent cache would therefore freeze whatever build it first captured and
    # quietly keep serving it for weeks, so the campaign would stop measuring the
    # agent it claims to measure. Cache validity is therefore scoped to ONE SWEEP:
    # the first trial pays the download, the remaining 88 reuse it, and the next
    # sweep starts clean. Bounded staleness, 1/89th of the cost.
    #
    # Every failure path falls through to the stock install. A cache can make a
    # trial FASTER; it must never be able to make one FAIL.


    def _agent_cache_root(self) -> Path | None:
        """Host dir holding this sweep's captured agent tree, or None if disabled.

        ⛔ TOTAL, NOT PARTIAL, FAULT CONTAINMENT -- MEASURED THE HARD WAY.
        This method raised NameError (a constant indented into class scope), and
        because it is called BEFORE the try block in each caller, the exception
        propagated into install() and errored 14 CONSECUTIVE TRIALS with
        "Agent install failed". The comment two screens up promised the opposite:
        "a cache may only make setup FASTER, never make it FAIL."

        A speed optimisation that can raise is not an optimisation. So every
        entry point here swallows everything and answers "no cache", which is
        always a correct answer -- the stock install is the fallback and it
        needs nothing from this code.
        """
        try:
            if os.environ.get("TB_AGENT_CACHE", "1") == "0":
                return None
            root = Path(__file__).resolve().parents[2] / "mcp-data" / ".tb-agent-cache"

            # An EXPLICIT id is honoured exactly. A sweep sets it so its trials
            # share one tree and stay isolated from every other run; silently
            # substituting a different tree would break that guarantee.
            explicit = os.environ.get(_AGENT_CACHE_ENV)
            if explicit:
                return root / f"sweep-{explicit}"

            today = root / f"sweep-{datetime.now().strftime('%Y%m%d')}"
            if _cache_is_populated(today):
                return today

            # ⛔ THE DATE KEY GOES COLD AT MIDNIGHT, AND THAT COST A WHOLE RUN.
            #
            # MEASURED 2026-09-07 02:42: nine consecutive single-task trials
            # errored in `_install_stock_with_retry` with
            # `curl: (60) SSL certificate problem: unable to get local issuer
            # certificate` reaching downloads.claude.ai. A COMPLETE 206 MB cache
            # from 2026-09-06 23:25 was sitting one directory away and was never
            # consulted, because the unset-id key is today's date and the day had
            # just rolled over. The first trial of a day therefore has a hard
            # network dependency, and when that network is unhealthy the cache
            # can never be populated either -- every trial of the day fails the
            # same way.
            #
            # Falling back to the newest POPULATED tree removes that dependency.
            # It is safe because the restore path proves the tree by EXECUTION
            # (`claude --version`, degrading to the stock install on
            # CACHE_UNUSABLE), so a stale or foreign tree costs one probe and
            # then behaves exactly as today does.
            newest = None
            for cand in root.glob("sweep-*"):
                if not _cache_is_populated(cand):
                    continue
                if newest is None or cand.stat().st_mtime > newest.stat().st_mtime:
                    newest = cand
            if newest is not None:
                _hook_note(
                    f"agent cache: today's key is cold, reusing {newest.name} "
                    "(proved by execution before use)",
                )
                return newest
            return today
        except Exception as exc:  # noqa: BLE001 - see the note above
            _hook_note(
                f"agent cache disabled ({type(exc).__name__}: "
                f"{str(exc)[:160]}); the stock install is unaffected",
            )
            return None


    async def _container_home(self, environment: BaseEnvironment) -> str | None:
        res = await self.exec_as_agent(environment, command='printf %s "$HOME"')
        home = (getattr(res, "stdout", "") or "").strip()
        return home or None


    async def _restore_cached_agent_inner(self, environment: BaseEnvironment) -> bool:
        """Upload the cached agent tree. True only if `claude` then really runs.

        Verified by EXECUTION, not by the upload's exit code: a tree copied from a
        different libc or architecture uploads perfectly and then cannot run, and
        that must degrade to a normal stock install rather than a dead trial.
        """
        cache = self._agent_cache_root()
        # lexists, NOT exists: `bin/claude` is a SYMLINK into
        # share/claude/versions/<v>, and exists() FOLLOWS it. On a Windows
        # host that target may not resolve, so exists() answered False for a
        # tree that was actually complete -- which is why capture discarded a
        # perfectly good copy twice (MEASURED 2026-09-05: the note recorded
        # local_bin ["claude"] while exists() said no).
        if cache is None or not os.path.lexists(cache / "bin" / "claude"):
            return False
        # An alpine image takes the npm branch upstream, not the bootstrap binary;
        # a glibc tree is useless there and must not be uploaded at all.
        # ⛔ EVERY PROBE MUST EXIT 0 AND ANSWER ON STDOUT.
        # Harbor raises NonZeroAgentExitCodeError from _exec for ANY non-zero
        # command -- this file already says so at the --retry-include note -- so a
        # probe that uses exit 1 to mean "no" THROWS instead of answering.
        # MEASURED 2026-09-05: this line aborted the whole restore on a non-alpine
        # image, i.e. on every image where the cache was meant to work.
        # Containment caught it and fell back to the stock install, so nothing
        # broke -- the cache simply never helped.
        apk = await self.exec_as_root(
            environment,
            command="if command -v apk >/dev/null 2>&1; then echo ALPINE; else echo OTHER; fi",
        )
        if "ALPINE" in (getattr(apk, "stdout", "") or ""):
            return False

        # ⛔ THE CACHE ONLY PAYS WHEN IT ALSO SKIPS apt-get. MEASURED 2026-09-05
        # mid-sweep: password-recovery, path-tracing, path-tracing-reverse and
        # polyglot-c-py all died with AgentSetupTimeoutError, and the job log shows
        # exactly why:
        #     Claude Code is already available at the requested version
        #     Running command: apt-get update && apt-get install -y curl bash nodejs npm procps
        #     Agent setup timed out after 360.0 seconds
        #
        # The restore worked. It just did not help. This cache does not remove a
        # download so much as TRADE a ~297 MB network download for a ~205 MB
        # host->container upload, and that trade is only a win when the image
        # already carries the system dependencies. When apt-get still has to run,
        # the upload is pure ADDED cost on top of it, and the two together cross
        # the 360 s budget on images that passed comfortably before the cache
        # existed.
        #
        # So: restore ONLY when harbor would skip ensure_system_dependencies
        # anyway. Otherwise fall through to the stock path, which is exactly the
        # behaviour these images had when they were passing. That makes the cache
        # strictly better than no cache, never worse -- which is what it claimed
        # to be and was not.
        #
        # The five commands are harbor's OWN criterion, read from its
        # SYSTEM_PACKAGES table (nodejs->node, procps->pgrep), not guessed: if this
        # list drifts from harbor's, the gate silently tests the wrong thing.
        deps = await self.exec_as_root(
            environment,
            command=(
                "if command -v curl >/dev/null 2>&1 && command -v bash >/dev/null 2>&1 "
                "&& command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 "
                "&& command -v pgrep >/dev/null 2>&1; "
                "then echo DEPS_OK; else echo DEPS_MISSING; fi"
            ),
        )
        if "DEPS_OK" not in (getattr(deps, "stdout", "") or ""):
            _hook_note(
                "image lacks the agent system dependencies, so apt-get must run anyway; "
                "skipping the cache restore (the upload would be pure added cost)"
            )
            return False
        home = await self._container_home(environment)
        if not home:
            return False
        try:
            await environment.upload_dir(cache, f"{home}/.local")
            await self.exec_as_agent(
                environment, command=f'chmod -R u+rwX,go+rX "{home}/.local" 2>/dev/null || true'
            )
            # Re-point the launcher IN THE CONTAINER rather than trusting a symlink
            # to survive a round-trip through a Windows host. The real binary lives
            # at share/claude/versions/<v>; whatever bin/claude arrived as (symlink,
            # plain copy, or dangling link), this makes it correct.
            await self.exec_as_agent(
                environment,
                command=(
                    f'd="{home}/.local/share/claude/versions"; '
                    f'v="$(ls -1 "$d" 2>/dev/null | tail -1)"; '
                    f'if [ -n "$v" ]; then chmod +x "$d/$v" 2>/dev/null || true; '
                    f'ln -sfn "$d/$v" "{home}/.local/bin/claude"; fi'
                ),
            )
            # Same rule: a cached binary that CANNOT RUN is the case this check
            # exists for, so it must not raise on exactly that path.
            check = await self.exec_as_agent(
                environment,
                command=(
                    f'export PATH="{home}/.local/bin:$PATH"; '
                    f'claude --version 2>/dev/null || echo CACHE_UNUSABLE'
                ),
            )
            out = (getattr(check, "stdout", "") or "").strip()
            if out and "CACHE_UNUSABLE" not in out:
                version = out
                _hook_note(
                    f"agent restored from sweep cache ({version}); "
                    f"skipped the ~297 MB download",
                )
                return True
        except Exception as exc:  # noqa: BLE001 - a cache miss is never fatal
            _hook_note(
                f"agent cache restore failed "
                f"({type(exc).__name__}: {str(exc)[:160]}); falling back to the stock install",
            )
        # Leave nothing half-restored for the stock install to trip over.
        await self.exec_as_agent(
            environment, command=f'rm -rf "{home}/.local/bin/claude" 2>/dev/null || true'
        )
        return False


    async def _populate_agent_cache_inner(self, environment: BaseEnvironment) -> None:
        """Capture the freshly installed tree for the REST of this sweep."""
        cache = self._agent_cache_root()
        if cache is None or os.path.lexists(cache / "bin" / "claude"):
            return
        home = await self._container_home(environment)
        if not home:
            return
        try:
            cache.parent.mkdir(parents=True, exist_ok=True)
            staging = cache.with_name(cache.name + ".partial")
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            # `docker compose cp <svc>:<src>/. <dst>` requires <dst> to EXIST;
            # the Linux platform, unlike the Windows one, does not create it.
            staging.mkdir(parents=True, exist_ok=True)
            await environment.download_dir(f"{home}/.local", staging)
            if not os.path.lexists(staging / "bin" / "claude"):
                # A SILENT RETURN WAS THE BUG IN THE FIRST VERSION: capture
                # failed exactly here and left no trace, so the cause was
                # unknowable from the artefacts.
                #
                # MEASURED 2026-09-05: the copy SUCCEEDS ($HOME=/root, tree
                # holds bin/share/state) but carries no bin/claude -- the
                # assumption that the bootstrap lands there is simply wrong.
                # Record where `claude` actually resolves so the next
                # iteration is evidence-led rather than another guess.
                where = await self.exec_as_agent(
                    environment,
                    command=('export PATH="$HOME/.local/bin:$PATH"; '
                             'p="$(command -v claude || true)"; '
                             'printf "%s|%s" "$p" "$(readlink -f "$p" 2>/dev/null || true)"'),
                )
                bin_listing = sorted(q.name for q in (staging / "bin").iterdir())[:20] if (staging / "bin").is_dir() else []
                listing = sorted(p.name for p in staging.iterdir())[:12] if staging.exists() else []
                _hook_note(
                    "agent cache capture found no bin/claude in the copied tree; discarding",
                    home=home,
                    staged=listing,
                    local_bin=bin_listing,
                    claude_resolves_to=(getattr(where, "stdout", "") or "").strip()[:300],
                )
                shutil.rmtree(staging, ignore_errors=True)
                return
            # Publish by RENAME so a concurrent worker never reads a half-written
            # tree: the two workers install at the same time by construction.
            try:
                staging.rename(cache)
            except OSError:
                shutil.rmtree(staging, ignore_errors=True)
                return
            _hook_note(
                f"cached the agent tree for this sweep at {cache}; "
                f"the remaining trials will skip the download",
            )
        except Exception as exc:  # noqa: BLE001 - caching is best-effort
            _hook_note(
                f"agent cache capture failed "
                f"({type(exc).__name__}: {str(exc)[:160]}); trials will keep installing normally",
            )

    # ── TOTAL FAULT CONTAINMENT ────────────────────────────────────────────
    #
    # ⛔ MEASURED 2026-09-05: 14 consecutive trials errored with "Agent install
    # failed: name '_AGENT_CACHE_ENV' is not defined". The inner methods each
    # had a try/except, but the calls made BEFORE those blocks -- resolving the
    # cache root, probing for apk, reading $HOME -- were outside them, so an
    # exception there propagated straight into install(). The invariant this
    # code claimed ("may only make setup FASTER, never make it FAIL") was
    # therefore false as written.
    #
    # These wrappers make it true by construction rather than by inspection: no
    # exception from the cache path can reach install(), whatever future edits
    # do to the internals. "No cache" is always a correct answer, because the
    # stock install needs nothing from any of this.
    async def _restore_cached_agent(self, environment: BaseEnvironment) -> bool:
        try:
            return await self._restore_cached_agent_inner(environment)
        except Exception as exc:  # noqa: BLE001 - a cache must never fail a trial
            _hook_note(
                f"agent cache restore aborted ({type(exc).__name__}: "
                f"{str(exc)[:160]}); falling back to the stock install",
            )
            return False

    async def _populate_agent_cache(self, environment: BaseEnvironment) -> None:
        try:
            await self._populate_agent_cache_inner(environment)
        except Exception as exc:  # noqa: BLE001 - capturing is best-effort only
            _hook_note(
                f"agent cache capture aborted ({type(exc).__name__}: "
                f"{str(exc)[:160]}); trials will keep installing normally",
            )

    async def _preinstall_deps_fast(self, environment: BaseEnvironment) -> None:
        """Install the agent's system packages QUICKLY, or leave it to harbor.

        See the note at the call site: the setup budget is blown by apt failing
        SLOWLY under contention, not by apt being unavailable. Short timeouts
        plus apt-level retries turn a ~minute-long failure into a few seconds,
        so the retry ladder fits inside 360 s instead of consuming it.

        Never raises and never blocks the run: every path returns, and harbor's
        own ensure_system_dependencies remains the fallback.
        """
        try:
            probe = await self.exec_as_root(
                environment,
                command=(
                    "if command -v curl >/dev/null 2>&1 && command -v bash >/dev/null 2>&1 "
                    "&& command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 "
                    "&& command -v pgrep >/dev/null 2>&1; "
                    "then echo DEPS_OK; else echo DEPS_MISSING; fi"
                ),
            )
            if "DEPS_OK" in (getattr(probe, "stdout", "") or ""):
                return
            # apk images take the npm branch upstream and are left alone.
            apk = await self.exec_as_root(
                environment,
                command="if command -v apk >/dev/null 2>&1; then echo ALPINE; else echo OTHER; fi",
            )
            if "ALPINE" in (getattr(apk, "stdout", "") or ""):
                return

            # `|| true` on the whole thing: this is an OPTIMISATION, and a
            # non-zero exit here must not raise (harbor turns any non-zero into
            # NonZeroAgentExitCodeError, which would abort the trial outright).
            opts = (
                "-o Acquire::http::Timeout=12 -o Acquire::https::Timeout=12 "
                "-o Acquire::Retries=3 -o Acquire::ForceIPv4=true"
            )
            cmd = (
                "export DEBIAN_FRONTEND=noninteractive; "
                f"for i in 1 2 3; do apt-get {opts} update >/dev/null 2>&1 && break; sleep 2; done; "
                f"apt-get {opts} install -y --no-install-recommends "
                "curl bash nodejs npm procps >/dev/null 2>&1; "
                "if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; "
                "then echo PREINSTALL_OK; else echo PREINSTALL_INCOMPLETE; fi"
            )
            res = await self.exec_as_root(environment, command=cmd)
            out = (getattr(res, "stdout", "") or "").strip()
            _hook_note(
                "fast dependency preinstall: %s" % (out.splitlines()[-1] if out else "no output"),
            )
            if "PREINSTALL_OK" in out:
                return
            # The ordinary path has already lost, so the repair below cannot
            # cost a trial that was going to work. See _APT_EOL_SNAPSHOT_REPAIR.
            rep = await self.exec_as_root(
                environment, command=_APT_EOL_SNAPSHOT_REPAIR
            )
            rout = (getattr(rep, "stdout", "") or "").strip()
            _hook_note(
                "end-of-life apt repair: %s"
                % (rout.splitlines()[-1] if rout else "no output"),
            )
        except Exception as exc:  # noqa: BLE001 - an optimisation may never fail a trial
            _hook_note(
                f"fast dependency preinstall aborted ({type(exc).__name__}: "
                f"{str(exc)[:140]}); harbor will install them the usual way"
            )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Stock Claude Code first. This can return early when a compatible
        # version is already present, which is why the CLI install below is
        # unconditional rather than chained onto its result.
        # ⛔ apt-get IS THE SETUP TIMEOUT, NOT THE DOWNLOAD. MEASURED 2026-09-05.
        # password-recovery and path-tracing died with AgentSetupTimeoutError, and
        # the adapter notes show the real sequence:
        #   stock install attempt 1 of 3 failed (exit 100): apt-get update ...
        #     Ign:1 http://security.ubuntu.com/ubuntu noble-security InRelease
        #     Ign:2 http://archive.ubuntu.com/ubuntu ...
        #   stock install succeeded on attempt 2 of 3      <- path-tracing
        # So the fetch is TRANSIENT, not broken: a bare `docker run ubuntu apt-get
        # update` on this host succeeds 3 times out of 3. It fails only under sweep
        # contention, when both workers set up at once.
        #
        # The budget is not blown by apt FAILING, it is blown by apt failing SLOWLY:
        # each attempt sits on default timeouts before giving up, and three of those
        # plus backoff crosses 360 s. Fixed by making the failure fast -- short
        # per-host timeouts and apt-level retries -- so the retries fit inside the
        # budget instead of consuming it.
        #
        # This installs the SAME five packages harbor would install, just sooner and
        # with better flags, so harbor s own ensure_system_dependencies then finds
        # them present and skips its slower invocation. Best-effort: any failure
        # falls through and harbor tries it the original way.
        await self._preinstall_deps_fast(environment)

        restored = await self._restore_cached_agent(environment)
        await self._install_stock_with_retry(environment)
        if not restored:
            await self._populate_agent_cache(environment)

        # ⛔ THE CACHE SKIPS MORE THAN THE DOWNLOAD.
        # ClaudeCode.install() returns EARLY when `claude` is already present, and
        # that short-circuit also skips its ensure_system_dependencies(curl, bash,
        # nodejs, npm, procps). So a restored trial never gets npm -- and the CLI
        # install below is `npm install -g`.
        #
        # MEASURED 2026-09-05: restore succeeded, reported the real version, and
        # the trial then died with
        #     Command failed (exit 127): npm install -g ...
        #     bash: line 1: npm: command not found
        # twice (the retry fired). The cache made setup FAIL, which is the one
        # thing it must never do -- containment cannot help here, because nothing
        # raised: the omission surfaced two steps later in someone else's command.
        #
        # Ensuring them unconditionally is cheap: the helper probes `command -v`
        # first and returns without touching apt-get when they are all present.
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "nodejs", "npm", "procps")
        )

        if not _CORE_PACKAGE_DIR.exists():
            raise RuntimeError(
                f"TerranSoul core package not found at {_CORE_PACKAGE_DIR}. "
                "The Stop hook imports it via the CLI; installing the CLI "
                "without it produces a hook that fails at startup."
            )
        if not _CLI_PACKAGE_DIR.exists():
            raise RuntimeError(
                f"TerranSoul CLI package not found at {_CLI_PACKAGE_DIR}. "
                "This adapter installs from the repo working tree and does not "
                "fall back to a published package: a silently different version "
                "would invalidate the run."
            )

        import shutil
        import subprocess
        import tempfile

        tmpdir = tempfile.mkdtemp(prefix="harbor-terransoul-hook-")
        try:
            tarballs = []
            # CORE before CLI: a tarball carries only its own files, so both
            # must land in the same node_modules for the CLI's
            # `@terransoul/core` import to resolve. Double quotes, not
            # shlex.quote — npm.cmd on Windows routes through cmd.exe, where
            # single quotes are literal.
            # THE CLI'S ONE EXTERNAL DEPENDENCY IS FETCHED FROM THE REGISTRY,
            # AND THAT IS A PER-TRIAL NETWORK DEPENDENCY WE DO NOT NEED.
            #
            # MEASURED 2026-09-07: with the agent itself restored from cache and
            # NO network needed for it, the very next step still died:
            #   npm ERR! request to https://registry.npmjs.org/@anthropic-ai%2fsdk
            #   failed, reason: unable to verify the first certificate
            # `npm install -g <our tarballs>` resolves the CLI's dependencies
            # from the registry, so every trial re-fetches them and any registry
            # outage, proxy or TLS interception fails setup before the agent
            # runs -- the same class that cost 80 trials to the stock install.
            #
            # The surface is ONE package: terransoul-core has no dependencies
            # and terransoul-cli has exactly `@anthropic-ai/sdk` plus the local
            # core. So pack that dependency from the HOST's already-resolved
            # node_modules and install all three from local files in ONE
            # transaction, which lets npm satisfy the CLI's dependency from the
            # provided set.
            #
            # BEST-EFFORT: if it cannot be packed we simply do not upload it and
            # npm falls back to the registry exactly as before. A setup
            # optimisation that can FAIL setup is not an optimisation.
            # Both locations, because npm workspaces HOIST: the dependency is
            # normally at the repo root, not under the package that declares it.
            # Looking only in the package dir found nothing and silently left the
            # registry fetch in place.
            _dep_rel = Path("node_modules") / "@anthropic-ai" / "sdk"
            _dep_dir = next(
                (d for d in (_CLI_PACKAGE_DIR / _dep_rel,
                             _CLI_PACKAGE_DIR.parents[1] / _dep_rel) if d.is_dir()),
                None,
            )
            if _dep_dir is not None:
                try:
                    _raw = subprocess.check_output(
                        f'npm pack --json "{_dep_dir}"',
                        cwd=tmpdir, text=True, shell=True,
                    )
                    _name = json.loads(_raw)[0]["filename"]
                    await environment.upload_file(str(Path(tmpdir) / _name), f"/tmp/{_name}")
                    tarballs.append(_name)
                except Exception as exc:  # noqa: BLE001 - see the note above
                    _hook_note(
                        f"could not pack the CLI dependency ({type(exc).__name__}); "
                        "npm will resolve it from the registry as before",
                    )

            for package_dir in (_CORE_PACKAGE_DIR, _CLI_PACKAGE_DIR):
                raw = subprocess.check_output(
                    f'npm pack --json "{package_dir}"',
                    cwd=tmpdir,
                    text=True,
                    shell=True,
                )
                name = json.loads(raw)[0]["filename"]
                await environment.upload_file(str(Path(tmpdir) / name), f"/tmp/{name}")
                tarballs.append(name)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        joined = " ".join(f"/tmp/{name}" for name in tarballs)
        await self.exec_as_root(environment, command=f"npm install -g {joined}")

        # The guard that matters: confirm the command the Stop hook will invoke
        # exists INSIDE the container before the trial starts, rather than
        # trusting the install command's own exit code.
        await self.exec_as_root(
            environment,
            command="command -v terransoul >/dev/null 2>&1 || "
            "(echo 'terransoul CLI not on PATH after install' >&2; exit 1)",
        )
