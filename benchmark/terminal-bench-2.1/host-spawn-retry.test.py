# -*- coding: utf-8 -*-
"""Tests for TBENCH-HOST-SPAWN-RETRY-1 in `terransoul_hook.py`.

WHY THESE FAIL ON THE PRE-CHANGE TREE: none of `_is_host_spawn_failure`,
`_message_is_host_spawn_failure` or `_install_compose_spawn_retry` existed, and
`DockerEnvironment._run_docker_compose_command` was left unwrapped — so
`test_patch_is_installed` raises AttributeError, and
`test_spawn_failure_is_retried_until_it_starts` sees ONE attempt and the
original RuntimeError instead of a recovered result.

WHAT IS ACTUALLY UNDER TEST is the integrity boundary, not just the retry.
`test_in_container_failure_is_not_retried` and
`test_failure_with_output_is_not_retried` are the ones that would catch this
turning into a second attempt at the task: a real non-zero exit from inside the
container, and a host failure that DID produce output, must both propagate on
the first attempt. A retry is only legal where the command provably never ran.

HERMETIC. `harbor` lives in a uv tool venv and is not importable from the repo
python, so the symbols the module needs are stubbed into `sys.modules` before
import — including a stand-in `DockerEnvironment` whose compose method COUNTS
its calls, which is the actual claim under test.

Run: python benchmark/terminal-bench-2.1/host-spawn-retry.test.py
"""
from __future__ import annotations

import os
import sys
import types
import typing
from pathlib import Path

if not hasattr(typing, "override"):
    typing.override = lambda f: f  # type: ignore[attr-defined]

# Both backoffs to zero BEFORE importing: the module reads them at import time,
# and a 15s sleep per retry would make this suite take a minute to prove
# nothing about the logic.
os.environ["TB_COMPOSE_SPAWN_BACKOFF_S"] = "0"
os.environ["TB_COMPOSE_SPAWN_ATTEMPTS"] = "4"
os.environ["TB_STOCK_INSTALL_BACKOFF_S"] = "0"
# TBENCH-HOST-SPAWN-WAIT-1: the existing exact-count tests describe the attempt
# FLOOR; the outage wait is exercised by its own tests below with a fake clock.
os.environ["TB_HOST_SPAWN_WAIT_S"] = "0"

_RC = 3221225794  # 0xC0000142 STATUS_DLL_INIT_FAILED

_CALLS: list[list] = []
_PLAN: list = []


class _ExecResult:
    """Stands in for harbor's `ExecResult` (a pydantic model there)."""

    def __init__(self, return_code: int, stdout=None, stderr=None) -> None:
        self.return_code = return_code
        self.stdout = stdout
        self.stderr = stderr


class _StubDockerEnvironment:
    """Stands in for harbor's DockerEnvironment. Records every compose call."""

    async def _run_docker_compose_command(self, command, *args, **kwargs):
        _CALLS.append(list(command))
        outcome = _PLAN.pop(0) if _PLAN else _ExecResult(0, "", "")
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _sanitize_project_name(name: str) -> str:
    """A VERBATIM copy of harbor's `_sanitize_docker_compose_project_name`.

    Copied, not approximated: the reaper's label filter is only as safe as this
    transform, so a stub that sanitised differently would let a mis-scoped
    reaper pass its own test. Source:
    harbor/environments/docker/docker.py (uv tool venv).
    """
    import re

    name = name.lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


class _StubClaudeCode:
    def __init__(self, *a, **k) -> None:
        pass

    async def install(self, environment) -> None:
        return None


class _StubEnvironment:
    pass


def _install_stubs() -> None:
    harbor = types.ModuleType("harbor")
    agents = types.ModuleType("harbor.agents")
    installed = types.ModuleType("harbor.agents.installed")
    claude_code = types.ModuleType("harbor.agents.installed.claude_code")
    claude_code.ClaudeCode = _StubClaudeCode
    environments = types.ModuleType("harbor.environments")
    env_base = types.ModuleType("harbor.environments.base")
    env_base.BaseEnvironment = _StubEnvironment
    docker_pkg = types.ModuleType("harbor.environments.docker")
    docker_mod = types.ModuleType("harbor.environments.docker.docker")
    docker_mod.DockerEnvironment = _StubDockerEnvironment
    docker_mod._sanitize_docker_compose_project_name = _sanitize_project_name
    docker_pkg.docker = docker_mod
    for name, mod in [
        ("harbor", harbor),
        ("harbor.agents", agents),
        ("harbor.agents.installed", installed),
        ("harbor.agents.installed.claude_code", claude_code),
        ("harbor.environments", environments),
        ("harbor.environments.base", env_base),
        ("harbor.environments.docker", docker_pkg),
        ("harbor.environments.docker.docker", docker_mod),
    ]:
        sys.modules[name] = mod


_install_stubs()
sys.path.insert(0, str(Path(__file__).resolve().parent))

import terransoul_hook  # noqa: E402

# Keep the disclosure channel out of the repo's real notes file while testing;
# `_hook_note` is best-effort and must not append test rows to the evidence a
# sweep discloses from.
terransoul_hook._HOOK_NOTES = Path(__file__).resolve().parent / ".host-spawn-retry-test-notes.jsonl"


def _compose_message(return_code: int = _RC, stdout: str = "None", stderr: str = "None") -> str:
    """Reproduce harbor's own `check=True` error text verbatim.

    Copied from `DockerEnvironment._run_docker_compose_command`; the predicate
    reads this string, so a test that invented its own wording would pass
    against a matcher that never fires in production.
    """
    return (
        "Docker compose command failed for environment caffe-cifar-10. "
        "Command: docker compose --project-name x cp tests/. main:/tests. "
        f"Return code: {return_code}. Stdout: {stdout}. Stderr: {stderr}. "
    )


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def _reset(plan) -> None:
    _CALLS.clear()
    _PLAN.clear()
    _PLAN.extend(plan)


_FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name}{': ' + detail if detail else ''}")
        _FAILURES.append(name)


def test_patch_is_installed() -> None:
    method = _StubDockerEnvironment._run_docker_compose_command
    check(
        "patch is installed on DockerEnvironment",
        getattr(method, "_terransoul_spawn_retry", False) is True,
        "the compose method was never wrapped",
    )


def test_predicate_requires_both_conditions() -> None:
    f = terransoul_hook._is_host_spawn_failure
    check("rc + empty streams is a spawn failure", f(_RC, None, None) is True)
    check("rc + empty strings is a spawn failure", f(_RC, "", "") is True)
    check("a different rc is not", f(1, None, None) is False)
    check("rc 137 (container OOM) is not", f(137, None, None) is False)
    check("rc with stdout is not", f(_RC, "some output", None) is False)
    check("rc with stderr is not", f(_RC, None, "boom") is False)


def test_message_predicate_matches_harbors_own_text() -> None:
    g = terransoul_hook._message_is_host_spawn_failure
    check("harbor's real message matches", g(_compose_message()) is True)
    check("a different return code does not", g(_compose_message(return_code=1)) is False)
    check(
        "the same code with real stdout does not",
        g(_compose_message(stdout="Error response from daemon")) is False,
    )


def test_spawn_failure_is_retried_until_it_starts() -> None:
    """Two host spawn failures, then the command runs. THE headline claim."""
    _reset([
        RuntimeError(_compose_message()),
        RuntimeError(_compose_message()),
        _ExecResult(0, "done", ""),
    ])
    env = _StubDockerEnvironment()
    result = _run(env._run_docker_compose_command(["cp", "tests/."]))
    check("recovered a result", getattr(result, "return_code", None) == 0)
    check("attempted three times", len(_CALLS) == 3, f"attempts={len(_CALLS)}")


def test_spawn_failure_returned_as_result_is_also_retried() -> None:
    """`check=False` returns the failure instead of raising; same verdict."""
    _reset([_ExecResult(_RC, None, None), _ExecResult(0, "done", "")])
    env = _StubDockerEnvironment()
    result = _run(env._run_docker_compose_command(["exec", "main"], check=False))
    check("recovered via the result path", getattr(result, "return_code", None) == 0)
    check("attempted twice", len(_CALLS) == 2, f"attempts={len(_CALLS)}")


def test_in_container_failure_is_not_retried() -> None:
    """INTEGRITY: a real non-zero exit from inside the container is the task's
    own outcome and must reach the caller on the first attempt."""
    _reset([_ExecResult(1, "test failed", "")])
    env = _StubDockerEnvironment()
    result = _run(env._run_docker_compose_command(["exec", "main"], check=False))
    check("propagated the real exit code", getattr(result, "return_code", None) == 1)
    check("attempted exactly once", len(_CALLS) == 1, f"attempts={len(_CALLS)}")


def test_failure_with_output_is_not_retried() -> None:
    """INTEGRITY: the return code alone is not enough — a command that produced
    output reached `main`, so re-running it would be a second execution."""
    _reset([RuntimeError(_compose_message(stdout="Error response from daemon"))])
    env = _StubDockerEnvironment()
    raised = None
    try:
        _run(env._run_docker_compose_command(["up", "--detach"]))
    except RuntimeError as exc:
        raised = exc
    check("raised", raised is not None)
    check("attempted exactly once", len(_CALLS) == 1, f"attempts={len(_CALLS)}")


def test_unrelated_error_is_not_retried() -> None:
    _reset([RuntimeError("Docker compose command failed. Return code: 125. Stdout: no such image. Stderr: None. ")])
    env = _StubDockerEnvironment()
    raised = None
    try:
        _run(env._run_docker_compose_command(["up", "--detach"]))
    except RuntimeError as exc:
        raised = exc
    check("raised", raised is not None)
    check("attempted exactly once", len(_CALLS) == 1, f"attempts={len(_CALLS)}")


def test_budget_is_bounded_and_final_failure_propagates() -> None:
    _reset([RuntimeError(_compose_message()) for _ in range(10)])
    env = _StubDockerEnvironment()
    raised = None
    try:
        _run(env._run_docker_compose_command(["cp", "tests/."]))
    except RuntimeError as exc:
        raised = exc
    check("the original error propagates after the budget", raised is not None)
    check(
        "stopped at TB_COMPOSE_SPAWN_ATTEMPTS",
        len(_CALLS) == terransoul_hook._COMPOSE_ATTEMPTS,
        f"attempts={len(_CALLS)} budget={terransoul_hook._COMPOSE_ATTEMPTS}",
    )


def test_reinstalling_does_not_stack_wrappers() -> None:
    """Idempotence: a second install must not multiply the attempt budget."""
    terransoul_hook._install_compose_spawn_retry()
    terransoul_hook._install_compose_spawn_retry()
    _reset([RuntimeError(_compose_message()) for _ in range(20)])
    env = _StubDockerEnvironment()
    try:
        _run(env._run_docker_compose_command(["cp", "tests/."]))
    except RuntimeError:
        pass
    check(
        "budget unchanged after re-installing twice",
        len(_CALLS) == terransoul_hook._COMPOSE_ATTEMPTS,
        f"attempts={len(_CALLS)} budget={terransoul_hook._COMPOSE_ATTEMPTS}",
    )


def test_failed_teardown_reaps_only_its_own_project() -> None:
    """TBENCH-TEARDOWN-REAP-1: a failed `down` removes THIS trial's containers.

    The label is the whole safety argument, so the test asserts the exact
    filter string rather than just "the reaper ran".
    """
    reaped: list[tuple[str, str]] = []

    async def _fake_reap(project, label):
        reaped.append((project, label))

    original_reap = terransoul_hook._reap_compose_project
    terransoul_hook._reap_compose_project = _fake_reap
    try:
        _reset([RuntimeError("Docker compose command failed. Return code: 1. Stdout: boom. Stderr: None. ")])
        env = _StubDockerEnvironment()
        env.session_id = "caffe-cifar-10__dFov8SP__env"
        try:
            _run(env._run_docker_compose_command(["down", "--volumes"]))
        except RuntimeError:
            pass
        check("reaped once after a failed down", len(reaped) == 1, f"reaped={reaped}")
        check(
            "scoped to this trial's sanitised project name",
            reaped and reaped[0][0] == "caffe-cifar-10__dfov8sp__env",
            f"reaped={reaped}",
        )
    finally:
        terransoul_hook._reap_compose_project = original_reap


def test_successful_teardown_reaps_nothing() -> None:
    reaped: list = []

    async def _fake_reap(project, label):
        reaped.append(project)

    original_reap = terransoul_hook._reap_compose_project
    terransoul_hook._reap_compose_project = _fake_reap
    try:
        _reset([_ExecResult(0, "", "")])
        env = _StubDockerEnvironment()
        env.session_id = "some-task__env"
        _run(env._run_docker_compose_command(["down"]))
        check("a clean teardown reaps nothing", reaped == [], f"reaped={reaped}")
    finally:
        terransoul_hook._reap_compose_project = original_reap


def test_non_teardown_failure_reaps_nothing() -> None:
    """INTEGRITY: `up`/`cp`/`exec` failures must NOT trigger container removal —
    the trial may still be live around them."""
    reaped: list = []

    async def _fake_reap(project, label):
        reaped.append(project)

    original_reap = terransoul_hook._reap_compose_project
    terransoul_hook._reap_compose_project = _fake_reap
    try:
        _reset([RuntimeError("Docker compose command failed. Return code: 1. Stdout: boom. Stderr: None. ")])
        env = _StubDockerEnvironment()
        env.session_id = "some-task__env"
        try:
            _run(env._run_docker_compose_command(["exec", "main"]))
        except RuntimeError:
            pass
        check("a failed exec reaps nothing", reaped == [], f"reaped={reaped}")
    finally:
        terransoul_hook._reap_compose_project = original_reap


def test_unresolvable_project_declines_to_reap() -> None:
    """The safety interlock: no project name -> no label -> do not remove."""
    reaped: list = []

    async def _fake_reap(project, label):
        reaped.append(project)

    original_reap = terransoul_hook._reap_compose_project
    terransoul_hook._reap_compose_project = _fake_reap
    try:
        _reset([RuntimeError("Docker compose command failed. Return code: 1. Stdout: boom. Stderr: None. ")])
        env = _StubDockerEnvironment()
        env.session_id = ""  # unresolvable
        try:
            _run(env._run_docker_compose_command(["down"]))
        except RuntimeError:
            pass
        check("declined to reap without a project name", reaped == [], f"reaped={reaped}")
    finally:
        terransoul_hook._reap_compose_project = original_reap


# ── TBENCH-HOST-SPAWN-WAIT-1 ─────────────────────────────────────────────────
# WHY THESE FAIL ON THE PRE-CHANGE TREE: `_now_monotonic`, `_spawn_backoff`,
# `_SPAWN_WAIT_S`, `_OUTAGE_STARTED_AT` and `_host_snapshot` did not exist
# (AttributeError in `_with_fake_outage_clock`), and the loop was bounded by
# `_COMPOSE_ATTEMPTS` alone, so `test_outage_wait_bridges_past_the_attempt_floor`
# saw 4 calls and the original RuntimeError instead of 21 calls and a result.


class _FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def now(self) -> float:
        return self.t


def _with_fake_outage_clock(wait_s: float):
    """Fake clock, plus a backoff that advances it by 15 s instead of sleeping."""
    clock = _FakeClock()
    saved = (
        terransoul_hook._now_monotonic,
        terransoul_hook._spawn_backoff,
        terransoul_hook._SPAWN_WAIT_S,
        terransoul_hook._OUTAGE_STARTED_AT,
        terransoul_hook._OUTAGE_ATTEMPTS,
    )

    async def _advance():
        clock.t += 15.0

    terransoul_hook._now_monotonic = clock.now
    terransoul_hook._spawn_backoff = _advance
    terransoul_hook._SPAWN_WAIT_S = wait_s
    terransoul_hook._OUTAGE_STARTED_AT = None
    terransoul_hook._OUTAGE_ATTEMPTS = 0

    def restore() -> None:
        (
            terransoul_hook._now_monotonic,
            terransoul_hook._spawn_backoff,
            terransoul_hook._SPAWN_WAIT_S,
            terransoul_hook._OUTAGE_STARTED_AT,
            terransoul_hook._OUTAGE_ATTEMPTS,
        ) = saved

    return clock, restore


def test_outage_wait_bridges_past_the_attempt_floor() -> None:
    """THE headline claim: 20 spawn failures at 15 s is a five-minute outage —
    the 2026-09-09 shape — and the command still runs, because the container it
    targets is still there."""
    _clock, restore = _with_fake_outage_clock(wait_s=900.0)
    try:
        _reset([RuntimeError(_compose_message()) for _ in range(20)] + [_ExecResult(0, "done", "")])
        env = _StubDockerEnvironment()
        result = _run(env._run_docker_compose_command(["cp", "tests/."]))
        check("recovered after a five-minute outage", getattr(result, "return_code", None) == 0)
        check("attempted 21 times", len(_CALLS) == 21, f"attempts={len(_CALLS)}")
        check("outage clock cleared on success", terransoul_hook._OUTAGE_STARTED_AT is None)
    finally:
        restore()


def test_outage_wait_is_bounded() -> None:
    """A host that stays dead costs ONE wait budget; then the failure propagates."""
    _clock, restore = _with_fake_outage_clock(wait_s=100.0)
    try:
        _reset([RuntimeError(_compose_message()) for _ in range(100)])
        env = _StubDockerEnvironment()
        raised = None
        try:
            _run(env._run_docker_compose_command(["cp", "tests/."]))
        except RuntimeError as exc:
            raised = exc
        check("the original error propagates after the budget", raised is not None)
        # failure k lands at 15*(k-1) s; re-attempt while that is < 100 s -> k <= 7, so 8 calls.
        check("stopped once the outage outlived the budget", len(_CALLS) == 8, f"attempts={len(_CALLS)}")
        check("a failure does NOT clear the outage clock", terransoul_hook._OUTAGE_STARTED_AT is not None)
    finally:
        restore()


def test_expired_outage_fails_fast_at_the_floor_for_later_commands() -> None:
    """The budget is per OUTAGE, not per command: once spent, the next command
    gets the attempt floor only, instead of a fifteen-minute wait of its own."""
    _clock, restore = _with_fake_outage_clock(wait_s=100.0)
    try:
        _reset([RuntimeError(_compose_message()) for _ in range(100)])
        env = _StubDockerEnvironment()
        try:
            _run(env._run_docker_compose_command(["cp", "tests/."]))
        except RuntimeError:
            pass
        first = len(_CALLS)
        _reset([RuntimeError(_compose_message()) for _ in range(100)])
        try:
            _run(env._run_docker_compose_command(["exec", "-T"]))
        except RuntimeError:
            pass
        check("first command spent the budget", first == 8, f"first={first}")
        check(
            "second command fails fast at the floor",
            len(_CALLS) == terransoul_hook._COMPOSE_ATTEMPTS,
            f"attempts={len(_CALLS)}",
        )
    finally:
        restore()


def test_recovery_resets_the_budget_for_the_next_outage() -> None:
    _clock, restore = _with_fake_outage_clock(wait_s=100.0)
    try:
        _reset([RuntimeError(_compose_message()) for _ in range(6)] + [_ExecResult(0, "", "")])
        env = _StubDockerEnvironment()
        _run(env._run_docker_compose_command(["cp", "tests/."]))
        _reset([RuntimeError(_compose_message()) for _ in range(6)] + [_ExecResult(0, "", "")])
        result = _run(env._run_docker_compose_command(["exec", "-T"]))
        check("second outage recovered on a fresh budget", getattr(result, "return_code", None) == 0)
        check("attempted 7 times", len(_CALLS) == 7, f"attempts={len(_CALLS)}")
    finally:
        restore()


def test_outage_notes_carry_a_host_snapshot_and_the_measured_length() -> None:
    """OBSERVABILITY: the start note carries the host state and the recovery
    note the outage's length — the two facts every previous event lacked."""
    import json as _json

    notes = terransoul_hook._HOOK_NOTES
    try:
        notes.unlink()
    except FileNotFoundError:
        pass
    _clock, restore = _with_fake_outage_clock(wait_s=900.0)
    try:
        _reset([RuntimeError(_compose_message()) for _ in range(3)] + [_ExecResult(0, "", "")])
        env = _StubDockerEnvironment()
        _run(env._run_docker_compose_command(["cp", "tests/."]))
    finally:
        restore()
    rows = [_json.loads(ln) for ln in notes.read_text(encoding="utf-8").splitlines() if ln.strip()]
    began = [r for r in rows if "OUTAGE began" in r["message"]]
    over = [r for r in rows if "outage OVER" in r["message"]]
    check("one outage-began note", len(began) == 1, f"n={len(began)}")
    check("began note carries a host snapshot", bool(began) and isinstance(began[0].get("host"), dict))
    check("one outage-over note", len(over) == 1, f"n={len(over)}")
    check(
        "over note measures the outage (three 15 s backoffs = 45 s)",
        bool(over) and over[0].get("outage_s") == 45.0,
        f"outage_s={over[0].get('outage_s') if over else None}",
    )
    check("over note counts the failed spawns", bool(over) and over[0].get("outage_failures") == 3)


def test_host_snapshot_never_raises_and_reads_the_host() -> None:
    snap = terransoul_hook._host_snapshot()
    check("snapshot is a dict", isinstance(snap, dict))
    if sys.platform == "win32":
        check("snapshot read memory", "phys_total_mb" in snap, str(snap)[:160])
        check("snapshot counted processes", snap.get("process_count", 0) > 10, str(snap.get("process_count")))
        check("snapshot summed handles", snap.get("handles_total", 0) > 0, str(snap.get("handles_total")))


def main() -> int:
    tests = [
        test_patch_is_installed,
        test_predicate_requires_both_conditions,
        test_message_predicate_matches_harbors_own_text,
        test_spawn_failure_is_retried_until_it_starts,
        test_spawn_failure_returned_as_result_is_also_retried,
        test_in_container_failure_is_not_retried,
        test_failure_with_output_is_not_retried,
        test_unrelated_error_is_not_retried,
        test_budget_is_bounded_and_final_failure_propagates,
        test_reinstalling_does_not_stack_wrappers,
        test_failed_teardown_reaps_only_its_own_project,
        test_successful_teardown_reaps_nothing,
        test_non_teardown_failure_reaps_nothing,
        test_unresolvable_project_declines_to_reap,
        test_outage_wait_bridges_past_the_attempt_floor,
        test_outage_wait_is_bounded,
        test_expired_outage_fails_fast_at_the_floor_for_later_commands,
        test_recovery_resets_the_budget_for_the_next_outage,
        test_outage_notes_carry_a_host_snapshot_and_the_measured_length,
        test_host_snapshot_never_raises_and_reads_the_host,
    ]
    for t in tests:
        print(t.__name__)
        t()
    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} check(s): {', '.join(_FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
