# -*- coding: utf-8 -*-
"""Tests for TBENCH-CONTAINER-DEATH-1 in `terransoul_hook.py`.

QUEUED, NOT YET APPLIED. The block this tests lives in
`scratchpad/container_death_block.py`; the running sweep re-invokes
`terransoul_hook.py` once per task, so it lands when the sweep is idle. Copy
this file to `benchmark/terminal-bench-2.1/container-death.test.py` at the same
time.

WHY THESE FAIL ON THE PRE-CHANGE TREE: `_looks_like_container_death` and
`_record_container_death` do not exist, so `test_predicate` raises
AttributeError and `test_death_is_recorded` sees an empty call list.

WHAT IS ACTUALLY UNDER TEST is the scoping, not the logging.
`test_ordinary_failure_records_nothing` is the one that matters: the recorder
shells out to `docker inspect`, and a predicate that fired on every non-zero
exit would run it on every ordinary command failure in every trial.

HERMETIC: harbor is stubbed, and the recorder is replaced with a spy, so no
daemon is needed.

Run: python benchmark/terminal-bench-2.1/container-death.test.py
"""
from __future__ import annotations

import os
import sys
import types
import typing
from pathlib import Path

if not hasattr(typing, "override"):
    typing.override = lambda f: f  # type: ignore[attr-defined]

os.environ["TB_COMPOSE_SPAWN_BACKOFF_S"] = "0"
os.environ["TB_COMPOSE_SPAWN_ATTEMPTS"] = "4"
os.environ["TB_STOCK_INSTALL_BACKOFF_S"] = "0"

_CALLS: list[list] = []
_PLAN: list = []


class _ExecResult:
    def __init__(self, return_code, stdout=None, stderr=None):
        self.return_code = return_code
        self.stdout = stdout
        self.stderr = stderr


class _StubDockerEnvironment:
    async def _run_docker_compose_command(self, command, *args, **kwargs):
        _CALLS.append(list(command))
        outcome = _PLAN.pop(0) if _PLAN else _ExecResult(0, "", "")
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _sanitize_project_name(name: str) -> str:
    """VERBATIM copy of harbor's `_sanitize_docker_compose_project_name`."""
    import re
    name = name.lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


class _StubClaudeCode:
    def __init__(self, *a, **k): pass
    async def install(self, environment): return None


class _StubEnvironment: pass


def _install_stubs() -> None:
    mods = {}
    for name in ("harbor", "harbor.agents", "harbor.agents.installed",
                 "harbor.environments", "harbor.environments.docker"):
        mods[name] = types.ModuleType(name)
    cc = types.ModuleType("harbor.agents.installed.claude_code")
    cc.ClaudeCode = _StubClaudeCode
    eb = types.ModuleType("harbor.environments.base")
    eb.BaseEnvironment = _StubEnvironment
    dm = types.ModuleType("harbor.environments.docker.docker")
    dm.DockerEnvironment = _StubDockerEnvironment
    dm._sanitize_docker_compose_project_name = _sanitize_project_name
    mods["harbor.environments.docker"].docker = dm
    mods["harbor.agents.installed.claude_code"] = cc
    mods["harbor.environments.base"] = eb
    mods["harbor.environments.docker.docker"] = dm
    for k, v in mods.items():
        sys.modules[k] = v


_install_stubs()
sys.path.insert(0, str(Path(__file__).resolve().parent))

import terransoul_hook  # noqa: E402

terransoul_hook._HOOK_NOTES = Path(__file__).resolve().parent / ".container-death-test-notes.jsonl"

_FAILURES: list[str] = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name}{': ' + detail if detail else ''}")
        _FAILURES.append(name)


def _run(coro):
    import asyncio
    return asyncio.run(coro)


def _reset(plan):
    _CALLS.clear(); _PLAN.clear(); _PLAN.extend(plan)


# Harbor's real wording, from the measured failures:
#   Agent install failed: 'service "main" is not running'
_DEATH_MSG = 'Agent install failed: \'service "main" is not running\''
_ORDINARY_MSG = ("Docker compose command failed for environment x. "
                 "Command: docker compose exec main pytest. "
                 "Return code: 1. Stdout: 2 failed. Stderr: None. ")


def test_predicate():
    f = terransoul_hook._looks_like_container_death
    check("compose's real 'is not running' wording matches", f(_DEATH_MSG) is True)
    check("'No such container' matches", f("Error: No such container: abc") is True)
    check("an ordinary non-zero exit does NOT match", f(_ORDINARY_MSG) is False)
    check("a host-spawn failure does NOT match",
          f("Return code: 3221225794. Stdout: None. Stderr: None. ") is False)


def test_death_is_recorded():
    seen = []

    async def spy(env, label):
        seen.append(label)

    orig = terransoul_hook._record_container_death
    terransoul_hook._record_container_death = spy
    try:
        _reset([RuntimeError(_DEATH_MSG)])
        env = _StubDockerEnvironment(); env.session_id = "torch-tensor-parallelism__puxPmce__env"
        try:
            _run(env._run_docker_compose_command(["exec", "main"]))
        except RuntimeError:
            pass
        check("recorded exactly once on container death", len(seen) == 1, f"seen={seen}")
    finally:
        terransoul_hook._record_container_death = orig


def test_ordinary_failure_records_nothing():
    """INTEGRITY: the recorder shells out to `docker inspect`. A predicate that
    fired on every non-zero exit would run it on every failing command."""
    seen = []

    async def spy(env, label):
        seen.append(label)

    orig = terransoul_hook._record_container_death
    terransoul_hook._record_container_death = spy
    try:
        _reset([RuntimeError(_ORDINARY_MSG)])
        env = _StubDockerEnvironment(); env.session_id = "some-task__env"
        try:
            _run(env._run_docker_compose_command(["exec", "main"]))
        except RuntimeError:
            pass
        check("an ordinary failure records nothing", seen == [], f"seen={seen}")
    finally:
        terransoul_hook._record_container_death = orig


def test_recorder_survives_missing_docker():
    """It runs on an ALREADY-FAILING path; it must never add an exception."""
    env = _StubDockerEnvironment(); env.session_id = "some-task__env"
    raised = None
    try:
        _run(terransoul_hook._record_container_death(env, "exec main"))
    except Exception as exc:  # noqa: BLE001
        raised = exc
    check("recorder never raises", raised is None, f"raised={raised!r}")


def main() -> int:
    for t in (test_predicate, test_death_is_recorded,
              test_ordinary_failure_records_nothing,
              test_recorder_survives_missing_docker):
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
