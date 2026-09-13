# -*- coding: utf-8 -*-
"""Tests for the stock-install retry in `terransoul_hook.py`.

WHY THESE FAIL ON THE PRE-CHANGE TREE: `_install_stock_with_retry` did not
exist and `install()` awaited `super().install()` exactly once, so
`test_transient_failure_is_retried` raises the first error instead of
recovering, and `test_method_exists` raises AttributeError.

HERMETIC. `harbor` lives in a uv tool venv and is not importable from the repo
python, so the two symbols the module needs are stubbed into `sys.modules`
before import. That keeps the test runnable anywhere and, more importantly,
lets the stubbed base class COUNT how many times the install was attempted --
which is the actual claim under test.

Run: python benchmark/terminal-bench-2.1/install-retry.test.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import types
import typing
from pathlib import Path

# `typing.override` is 3.12+. The harness runs harbor's own 3.13 venv, but this
# test must be runnable from whatever `python` is on PATH, so supply a no-op
# when the real decorator is absent. It only marks intent; nothing here depends
# on its behaviour.
if not hasattr(typing, "override"):
    typing.override = lambda f: f  # type: ignore[attr-defined]

# Backoff to zero BEFORE importing: the module reads it at import time, and a
# 10s sleep per retry would make this suite take a minute to prove nothing.
os.environ["TB_STOCK_INSTALL_BACKOFF_S"] = "0"
os.environ.setdefault("TB_STOCK_INSTALL_ATTEMPTS", "3")

_ATTEMPTS: list[int] = []
_PLAN: list[BaseException | None] = []


class _StubClaudeCode:
    """Stands in for harbor's ClaudeCode. Records every install attempt."""

    def __init__(self, *a, **k) -> None:
        pass

    async def install(self, environment) -> None:
        _ATTEMPTS.append(1)
        outcome = _PLAN.pop(0) if _PLAN else None
        if outcome is not None:
            raise outcome


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
    for name, mod in [
        ("harbor", harbor),
        ("harbor.agents", agents),
        ("harbor.agents.installed", installed),
        ("harbor.agents.installed.claude_code", claude_code),
        ("harbor.environments", environments),
        ("harbor.environments.base", env_base),
    ]:
        sys.modules[name] = mod


_install_stubs()
sys.path.insert(0, str(Path(__file__).resolve().parent))
import terransoul_hook  # noqa: E402

HOOK = terransoul_hook.TerranSoulHook


def _reset(plan: list[BaseException | None]) -> None:
    _ATTEMPTS.clear()
    _PLAN.clear()
    _PLAN.extend(plan)


PASS = 0
FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        print(f"  ok   {label}")
        PASS += 1
    else:
        print(f"  FAIL {label} :: {detail}")
        FAIL += 1


def test_method_exists() -> None:
    check(
        "the retry wrapper exists and install() routes through it",
        hasattr(HOOK, "_install_stock_with_retry"),
        "install() awaited super().install() directly",
    )


def test_clean_install_is_not_retried() -> None:
    _reset([None])
    asyncio.run(HOOK.__new__(HOOK)._install_stock_with_retry(_StubEnvironment()))
    check("a clean install runs exactly once", len(_ATTEMPTS) == 1, f"attempts={len(_ATTEMPTS)}")


def test_transient_failure_is_retried() -> None:
    # Two environment failures then success -- the measured shape: apt-get is
    # killed, the retry finds the mirror responsive.
    _reset([RuntimeError("exit 143: apt-get update"), RuntimeError("exit 143: apt-get update"), None])
    asyncio.run(HOOK.__new__(HOOK)._install_stock_with_retry(_StubEnvironment()))
    check(
        "a transient install failure is re-attempted until it succeeds",
        len(_ATTEMPTS) == 3,
        f"attempts={len(_ATTEMPTS)}",
    )


def test_persistent_failure_raises_the_original_error() -> None:
    boom = RuntimeError("exit 143: apt-get update")
    _reset([boom, boom, boom, boom, boom])
    try:
        asyncio.run(HOOK.__new__(HOOK)._install_stock_with_retry(_StubEnvironment()))
    except RuntimeError as exc:
        # Bounded, and the original error survives -- swallowing it would turn a
        # broken environment into a silent mystery further down.
        check(
            "a persistent failure is bounded and re-raises the original error",
            len(_ATTEMPTS) == int(os.environ["TB_STOCK_INSTALL_ATTEMPTS"]) and exc is boom,
            f"attempts={len(_ATTEMPTS)} exc={exc!r}",
        )
        return
    check("a persistent failure is bounded and re-raises", False, "no exception raised")


def test_retry_is_scoped_to_install_only() -> None:
    # THE HONESTY PROPERTY. The retry must wrap ONLY the stock install, never
    # anything that could run after the agent takes its turn -- otherwise it
    # buys a second attempt at the task. Asserted structurally: the wrapper is
    # called exactly once in install(), and the source contains no retry around
    # the agent's own run.
    src = Path(terransoul_hook.__file__).read_text(encoding="utf-8")
    body = src.split("async def install(", 1)[1]
    check(
        "install() calls the retry wrapper exactly once",
        body.count("_install_stock_with_retry") == 1,
        f"count={body.count('_install_stock_with_retry')}",
    )
    check(
        "no retry wraps the agent's run",
        "async def run" not in src or "_install_stock_with_retry" not in src.split("async def run", 1)[-1],
        "a retry appears inside run()",
    )


if __name__ == "__main__":
    print("install-retry.test.py")
    test_method_exists()
    test_clean_install_is_not_retried()
    test_transient_failure_is_retried()
    test_persistent_failure_raises_the_original_error()
    test_retry_is_scoped_to_install_only()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
