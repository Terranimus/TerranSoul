# -*- coding: utf-8 -*-
"""Tests for TBENCH-LATE-API-RETRY-1 in `terransoul_hook.py`.

WHY THESE FAIL ON THE PRE-CHANGE TREE: `_install_work_aware_retry`,
`_agent_produced_work`, `_preserve_retried_attempt`, `_capture_failed_exec_on_host`
and the `TerranSoulHook._classify_exec_error` override did not exist, so every
test below raises AttributeError before its first `check`. Against harbor's own
loop the two headline claims are also false in substance:
`test_late_api_error_after_work_is_not_retried` would see TWO runs (the stock
loop matches the exception NAME and re-runs), and
`test_pre_work_retry_preserves_the_failed_attempt` would find the first
attempt's directory `shutil.rmtree`d rather than moved.

WHAT IS ACTUALLY UNDER TEST is an integrity boundary and an evidence rule:
  * a by-name retry match must NOT re-run an attempt that produced agent work
    (that is a second attempt at the task);
  * an attempt with no work is a run that never happened and IS re-run, and
    its directory is preserved outside every `jobs*` root rather than deleted;
  * the evidence of work must survive a failed `docker cp` — it is captured on
    the host from the raw stream at the moment the command fails.

HERMETIC. `harbor` lives in a uv tool venv; the modules the hook imports are
stubbed into `sys.modules` before import, including a `TrialQueue` whose
retry loop is a VERBATIM copy of harbor 0.21.0's (the fingerprint the patch
keys on). The final test additionally hashes the REAL installed harbor's loop
when its venv is present, so an upgrade that moves the loop fails here
instead of silently un-installing the patch.

Run: python benchmark/terminal-bench-2.1/late-api-retry.test.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import typing
from pathlib import Path
from types import SimpleNamespace

if not hasattr(typing, "override"):
    typing.override = lambda f: f  # type: ignore[attr-defined]

os.environ["TB_COMPOSE_SPAWN_BACKOFF_S"] = "0"
os.environ["TB_HOST_SPAWN_WAIT_S"] = "0"
os.environ["TB_STOCK_INSTALL_BACKOFF_S"] = "0"


class _ExecResult:
    def __init__(self, return_code: int, stdout=None, stderr=None) -> None:
        self.return_code = return_code
        self.stdout = stdout
        self.stderr = stderr


class _StubClaudeCode:
    def __init__(self, *a, **k) -> None:
        pass

    async def install(self, environment) -> None:
        return None

    def _classify_exec_error(self, command, result):
        return RuntimeError(f"stub classification of exit {result.return_code}")


class _AgentAuthenticationError(Exception):
    """harbor's own class for a missing/dead login, which harbor excludes from
    retries by default (harbor/models/job/config.py:298)."""


class _StubEnvironment:
    pass


class _StubDockerEnvironment:
    async def _run_docker_compose_command(self, command, *args, **kwargs):
        return _ExecResult(0, "", "")


class _Logger:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def debug(self, msg, *a, **k) -> None:
        self.lines.append(str(msg))


class _RetryConfig:
    def __init__(self, max_retries: int = 3, include=None) -> None:
        self.max_retries = max_retries
        self.include_exceptions = set(include or [])
        self.exclude_exceptions: set = set()


_RUNS: list[str] = []
_RESULTS: list = []
# Called from `Trial.create`, which is where harbor really imports the agent
# module (and therefore installs the guards) -- see TBENCH-LATE-API-RETRY-2.
_ON_CREATE = None

# The exact result line the 2026-09-13 credential death wrote into the stream.
_MEASURED_401 = (
    "Command failed (exit 1): claude --print\n"
    'stdout: {"is_error":true,"num_turns":98,"api_error_status":401,'
    '"result":"Failed to authenticate. API Error: 401 OAuth access token has expired"}'
)


class _Paths:
    def __init__(self, trial_dir: Path) -> None:
        self.trial_dir = trial_dir


class _StubTrial:
    """Stands in for harbor's Trial: `create` then `run`, returning a canned result."""

    @classmethod
    async def create(cls, config):
        t = cls()
        t.paths = _Paths(Path(config.trial_dir))
        t.config = config
        if _ON_CREATE is not None:
            _ON_CREATE()
        return t

    async def run(self):
        _RUNS.append(str(self.paths.trial_dir))
        self.paths.trial_dir.mkdir(parents=True, exist_ok=True)
        (self.paths.trial_dir / "result.json").write_text("{}", encoding="utf-8")
        return _RESULTS.pop(0)


class _StubTrialQueue:
    def __init__(self, retry: _RetryConfig) -> None:
        self._retry_config = retry
        self._logger = _Logger()

    def _setup_hooks(self, trial) -> None:
        return None

    def _should_retry_exception(self, exception_type: str) -> bool:
        if (
            self._retry_config.exclude_exceptions
            and exception_type in self._retry_config.exclude_exceptions
        ):
            return False
        if (
            self._retry_config.include_exceptions
            and exception_type not in self._retry_config.include_exceptions
        ):
            return False
        return True

    def _calculate_backoff_delay_sec(self, attempt: int) -> float:
        return 0.0

    async def _execute_trial_with_retries(
        self, trial_config
    ):
        """Execute a trial with retry logic."""
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


import asyncio  # noqa: E402 - the stub loop above references it by name, as harbor's does


def _install_stubs() -> None:
    mods = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.base": types.ModuleType("harbor.agents.installed.base"),
        "harbor.agents.installed.claude_code": types.ModuleType("harbor.agents.installed.claude_code"),
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": types.ModuleType("harbor.environments.base"),
        "harbor.environments.docker": types.ModuleType("harbor.environments.docker"),
        "harbor.environments.docker.docker": types.ModuleType("harbor.environments.docker.docker"),
        "harbor.trial": types.ModuleType("harbor.trial"),
        "harbor.trial.queue": types.ModuleType("harbor.trial.queue"),
        "harbor.trial.trial": types.ModuleType("harbor.trial.trial"),
    }
    mods["harbor.agents.installed.base"].AgentAuthenticationError = _AgentAuthenticationError
    mods["harbor.agents.installed.claude_code"].ClaudeCode = _StubClaudeCode
    mods["harbor.environments.base"].BaseEnvironment = _StubEnvironment
    mods["harbor.environments.docker.docker"].DockerEnvironment = _StubDockerEnvironment
    mods["harbor.environments.docker.docker"]._sanitize_docker_compose_project_name = lambda s: s.lower()
    mods["harbor.environments.docker"].docker = mods["harbor.environments.docker.docker"]
    mods["harbor.trial.queue"].TrialQueue = _StubTrialQueue
    mods["harbor.trial.trial"].Trial = _StubTrial
    mods["harbor.trial"].queue = mods["harbor.trial.queue"]
    mods["harbor.trial"].trial = mods["harbor.trial.trial"]
    for name, mod in mods.items():
        sys.modules[name] = mod


_install_stubs()
# BEFORE the import, because importing the module wraps this method
# (`_install_retry_decision_gate`) exactly as it does inside a real trial.
_ORIGINAL_STUB_GATE = _StubTrialQueue._should_retry_exception
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import terransoul_hook  # noqa: E402

# The pinned fingerprint is harbor's; keep it for the real-venv test, then key
# the patch to the stub's verbatim copy so the hermetic tests can install it.
_PINNED_REAL_SHA = terransoul_hook._RETRY_LOOP_SOURCE_SHA256
_STUB_LOOP_SHA = terransoul_hook._source_sha256(_StubTrialQueue._execute_trial_with_retries)
_ORIGINAL_STUB_LOOP = _StubTrialQueue._execute_trial_with_retries

_TMP = Path(tempfile.mkdtemp(prefix="late-api-retry-"))
terransoul_hook._HOOK_NOTES = _TMP / "notes.jsonl"
terransoul_hook._RETRIED_ATTEMPTS_DIR = _TMP / "retried-attempts"

_FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name}{': ' + detail if detail else ''}")
        _FAILURES.append(name)


def _run(coro):
    return asyncio.run(coro)


def _result(exception: str | None, tokens=None, message=None):
    return SimpleNamespace(
        exception_info=SimpleNamespace(exception_type=exception, exception_message=message)
        if exception
        else None,
        agent_result=SimpleNamespace(n_output_tokens=tokens),
    )


def _config(name: str = "sam-cell-seg__c9CHYJ2", job: str = "unseenSAM-1"):
    return SimpleNamespace(trial_name=name, trial_dir=_TMP / "jobs" / job / name)


def _fresh(results, include=("UnknownApiError", "ApiRateLimitError", "ApiInternalServerError")):
    _RUNS.clear()
    _RESULTS.clear()
    _RESULTS.extend(results)
    shutil.rmtree(_TMP / "jobs", ignore_errors=True)
    shutil.rmtree(_TMP / "retried-attempts", ignore_errors=True)
    terransoul_hook._AUTH_TERMINAL_SEEN = None   # the refusal is sticky per PROCESS
    return _StubTrialQueue(_RetryConfig(max_retries=3, include=include))


def _install_against_stub() -> None:
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    terransoul_hook._RETRY_LOOP_SOURCE_SHA256 = _STUB_LOOP_SHA
    terransoul_hook._install_work_aware_retry()


def test_fingerprint_mismatch_declines_to_patch() -> None:
    """The guard: a loop that has moved is not patched with a stale copy."""
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    terransoul_hook._RETRY_LOOP_SOURCE_SHA256 = "0" * 64
    terransoul_hook._install_work_aware_retry()
    check(
        "unpatched when the fingerprint differs",
        _StubTrialQueue._execute_trial_with_retries is _ORIGINAL_STUB_LOOP,
    )
    notes = (terransoul_hook._HOOK_NOTES).read_text(encoding="utf-8") if terransoul_hook._HOOK_NOTES.exists() else ""
    check("declining is LOUD", "has CHANGED" in notes, notes[-200:])


def test_patch_installs_on_a_matching_fingerprint() -> None:
    _install_against_stub()
    check(
        "patched when the fingerprint matches",
        getattr(_StubTrialQueue._execute_trial_with_retries, "_terransoul_work_aware", False) is True,
    )
    terransoul_hook._install_work_aware_retry()
    check(
        "re-installing is idempotent",
        getattr(_StubTrialQueue._execute_trial_with_retries, "_terransoul_work_aware", False) is True,
    )


def test_late_api_error_after_work_is_not_retried() -> None:
    """INTEGRITY, the headline: the agent produced work, then the API died.
    harbor's loop would run the task again from scratch; this one must not."""
    _install_against_stub()
    q = _fresh([_result("UnknownApiError", tokens=37936), _result(None)])
    res = _run(q._execute_trial_with_retries(_config()))
    check("ran exactly once", len(_RUNS) == 1, f"runs={len(_RUNS)}")
    check("the graded result is returned", res.exception_info is not None and res.exception_info.exception_type == "UnknownApiError")
    check("the trial directory is intact", (_config().trial_dir / "result.json").exists())
    notes = terransoul_hook._HOOK_NOTES.read_text(encoding="utf-8")
    check("refusal is disclosed with its evidence", "AFTER the agent produced work (37936 output tokens" in notes)


def test_pre_work_api_error_is_retried_as_a_first_attempt() -> None:
    """A run with no turn never happened; the by-name retry still applies."""
    _install_against_stub()
    q = _fresh([_result("UnknownApiError", tokens=None), _result(None)])
    res = _run(q._execute_trial_with_retries(_config()))
    check("ran twice", len(_RUNS) == 2, f"runs={len(_RUNS)}")
    check("the second attempt's clean result is returned", res.exception_info is None)


def test_pre_work_retry_preserves_the_failed_attempt() -> None:
    """EVIDENCE: the failed attempt is moved out of the job, not deleted."""
    _install_against_stub()
    q = _fresh([_result("ApiRateLimitError", tokens=None), _result(None)])
    cfg = _config()
    _run(q._execute_trial_with_retries(cfg))
    kept = terransoul_hook._RETRIED_ATTEMPTS_DIR / "unseenSAM-1" / "sam-cell-seg__c9CHYJ2__attempt1"
    check("the first attempt is kept", (kept / "result.json").exists(), str(kept))
    check("outside every jobs* root", "jobs" not in kept.relative_to(_TMP).parts[0])
    check("the live trial dir belongs to the second attempt", (cfg.trial_dir / "result.json").exists())


def test_zero_tokens_but_a_host_capture_counts_as_work() -> None:
    """The 2026-09-09 shape: `docker cp` failed, so harbor parsed no tokens —
    but the host-side capture saw model turns. That is work; no retry."""
    _install_against_stub()
    q = _fresh([_result("UnknownApiError", tokens=None), _result(None)])
    cfg = _config()
    agent_dir = cfg.trial_dir / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / terransoul_hook._EXEC_FAILURE_SIDECAR).write_text(
        json.dumps([{"assistant_turns": 12, "return_code": 1}]), encoding="utf-8"
    )
    _run(q._execute_trial_with_retries(cfg))
    check("not retried on the strength of the host capture", len(_RUNS) == 1, f"runs={len(_RUNS)}")


def test_zero_tokens_but_an_agent_step_in_the_trajectory_counts_as_work() -> None:
    _install_against_stub()
    q = _fresh([_result("UnknownApiError", tokens=None), _result(None)])
    cfg = _config()
    agent_dir = cfg.trial_dir / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "trajectory.json").write_text(
        json.dumps({"steps": [{"source": "user"}, {"source": "agent", "message": "hi"}]}), encoding="utf-8"
    )
    _run(q._execute_trial_with_retries(cfg))
    check("not retried on the strength of the trajectory", len(_RUNS) == 1, f"runs={len(_RUNS)}")


def test_exception_outside_the_include_list_is_still_never_retried() -> None:
    """The by-name refusal is unchanged — this patch only ever REMOVES retries."""
    _install_against_stub()
    q = _fresh([_result("AgentTimeoutError", tokens=None), _result(None)])
    _run(q._execute_trial_with_retries(_config()))
    check("AgentTimeoutError is not retried", len(_RUNS) == 1, f"runs={len(_RUNS)}")


def test_classify_exec_error_captures_the_stream_on_the_host() -> None:
    """The capture the retry reads, written from the raw result before harbor raises."""
    hook = terransoul_hook.TerranSoulHook()
    logs_dir = _TMP / "capture" / "agent"
    shutil.rmtree(_TMP / "capture", ignore_errors=True)
    hook.logs_dir = logs_dir
    stream = "\n".join([
        json.dumps({"type": "system", "subtype": "init"}),
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Reading the task."}]}}),
        json.dumps({"type": "user", "message": {"content": [{"type": "tool_result"}]}}),
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Done."}]}}),
        "API Error: 529 Overloaded",
    ])
    command = "claude --verbose --output-format=stream-json --print 2>&1 | tee /logs/agent/claude-code.txt"
    exc = hook._classify_exec_error(command, _ExecResult(1, stream, ""))
    check("harbor's own classification still runs", isinstance(exc, RuntimeError) and "stub classification" in str(exc))
    sidecar = logs_dir / terransoul_hook._EXEC_FAILURE_SIDECAR
    check("sidecar written", sidecar.exists())
    rows = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.exists() else []
    check("sidecar counts the model turns", bool(rows) and rows[-1]["assistant_turns"] == 2, str(rows)[:200])
    check("sidecar keeps the tail that names the error", bool(rows) and "API Error: 529" in rows[-1]["tail"])
    capture = logs_dir / terransoul_hook._HOST_CAPTURE_NAME
    check("full stream kept on the host", capture.exists() and capture.read_text(encoding="utf-8") == stream)
    worked, evidence = terransoul_hook._agent_produced_work(_result("UnknownApiError", tokens=None), logs_dir.parent)
    check("the capture is what the retry reads", worked and "host-side capture" in evidence, evidence)


def test_capture_never_raises_on_an_unwritable_dir() -> None:
    hook = terransoul_hook.TerranSoulHook()
    hook.logs_dir = _TMP / "capture-file-not-dir"
    (_TMP / "capture-file-not-dir").write_text("a file, not a directory", encoding="utf-8")
    exc = hook._classify_exec_error("claude --print", _ExecResult(1, "x", ""))
    check("classification still returned", isinstance(exc, RuntimeError))


def test_count_assistant_turns_ignores_non_json_and_other_events() -> None:
    f = terransoul_hook._count_assistant_turns
    check("None is 0", f(None) == 0)
    check("prose is 0", f("API Error: 401\nnot json") == 0)
    check("only assistant events count", f('{"type":"user"}\n{"type":"assistant"}\n{"type":"result"}') == 1)


def test_fingerprint_matches_the_installed_harbor() -> None:
    """A harbor upgrade must fail HERE, not silently un-install the patch."""
    venv_py = Path(os.environ.get("APPDATA", "")) / "uv" / "tools" / "harbor" / "Scripts" / "python.exe"
    if not venv_py.exists():
        print("  SKIP real-harbor fingerprint (harbor venv not found)")
        return
    code = (
        "import inspect,hashlib\n"
        "from harbor.trial.queue import TrialQueue\n"
        "src=inspect.getsource(TrialQueue._execute_trial_with_retries).replace('\\r\\n','\\n')\n"
        "print(hashlib.sha256(src.encode('utf-8')).hexdigest())\n"
    )
    out = subprocess.run([str(venv_py), "-c", code], capture_output=True, text=True, timeout=180)
    got = out.stdout.strip()
    check("real harbor's retry loop matches the pinned fingerprint", got == _PINNED_REAL_SHA, f"got={got[:12]} pinned={_PINNED_REAL_SHA[:12]} err={out.stderr[-200:]}")
    probe = (
        "import sys\n"
        f"sys.path.insert(0, {str(_HERE)!r})\n"
        "import terransoul_hook\n"
        "from harbor.trial.queue import TrialQueue\n"
        "print(getattr(TrialQueue._execute_trial_with_retries, '_terransoul_work_aware', False))\n"
    )
    out2 = subprocess.run([str(venv_py), "-c", probe], capture_output=True, text=True, timeout=180)
    check("patch installs on the REAL harbor", out2.stdout.strip() == "True", f"stdout={out2.stdout.strip()[:80]} err={out2.stderr[-300:]}")


def _install_as_an_import_would() -> None:
    """Install what importing this module installs, against the stub loop.

    harbor installs BOTH guards by importing the agent module; a test that
    installed only one would not be testing the shipped configuration.
    """
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    _StubTrialQueue._should_retry_exception = _ORIGINAL_STUB_GATE
    terransoul_hook._RETRY_LOOP_SOURCE_SHA256 = _STUB_LOOP_SHA
    terransoul_hook._install_work_aware_retry()
    gate = getattr(terransoul_hook, "_install_retry_decision_gate", None)
    if gate is not None:
        gate()


def test_the_retry_gate_installer_exists() -> None:
    """TBENCH-LATE-API-RETRY-2: the loop copy alone cannot reach the first trial."""
    check(
        "a retry decision gate is installed by import",
        callable(getattr(terransoul_hook, "_install_retry_decision_gate", None)),
        "terransoul_hook._install_retry_decision_gate is missing",
    )


def test_a_guard_installed_mid_loop_still_refuses_the_retry() -> None:
    """THE 2026-09-13 SHAPE, AND THE ONE THAT MATTERS MOST.

    harbor imports this module from `Trial.__init__` -> `_init_agent`, i.e. from
    INSIDE the first iteration of the retry loop it is supposed to replace
    (harbor/trial/trial.py:123, harbor/trial/queue.py:199). The loop frame in
    flight is harbor's own, and rebinding the class attribute cannot redirect
    it. Here the install happens during the first `Trial.create`, exactly as it
    does in a real single-task job, and the graded attempt must STILL survive.

    FAILS ON THE PRE-CHANGE TREE: with only the loop-copy patch, the in-flight
    stock loop runs to `shutil.rmtree` and the task is attempted a second time
    -- `runs=2` -- which is the deletion this whole section exists to prevent.
    """
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    _StubTrialQueue._should_retry_exception = _ORIGINAL_STUB_GATE
    q = _fresh([_result("UnknownApiError", tokens=37936), _result(None)])
    global _ON_CREATE
    _ON_CREATE = _install_as_an_import_would          # the agent module's import
    try:
        res = _run(q._execute_trial_with_retries(_config()))
    finally:
        _ON_CREATE = None
    check("ran exactly once despite the mid-loop install", len(_RUNS) == 1, f"runs={len(_RUNS)}")
    check(
        "the graded result is returned with the exception as provenance",
        res.exception_info is not None and res.exception_info.exception_type == "UnknownApiError",
    )
    check("the trial directory is intact", (_config().trial_dir / "result.json").exists())


def test_the_gate_refuses_inside_harbors_own_unpatched_loop() -> None:
    """The gate is what reaches a loop frame that is already running."""
    _install_as_an_import_would()
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP   # harbor's, in flight
    q = _fresh([_result("UnknownApiError", tokens=37936), _result(None)])
    before = len(terransoul_hook._HOOK_NOTES.read_text(encoding="utf-8"))
    _run(q._execute_trial_with_retries(_config()))
    check("harbor's own loop did not re-run the task", len(_RUNS) == 1, f"runs={len(_RUNS)}")
    # Only what THIS run appended: a note left by an earlier test must not be
    # able to satisfy the disclosure of this one.
    notes = terransoul_hook._HOOK_NOTES.read_text(encoding="utf-8")[before:]
    check("the refusal is disclosed with its evidence", "AFTER the agent produced work" in notes)


def test_the_gate_preserves_a_never_ran_attempt_from_harbors_loop() -> None:
    """harbor's loop deletes it two lines later, so the gate moves it out first."""
    _install_as_an_import_would()
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    q = _fresh([_result("ApiRateLimitError", tokens=None), _result(None)])
    cfg = _config()
    _run(q._execute_trial_with_retries(cfg))
    check("the never-ran attempt was re-run", len(_RUNS) == 2, f"runs={len(_RUNS)}")
    kept = terransoul_hook._RETRIED_ATTEMPTS_DIR / "unseenSAM-1" / "sam-cell-seg__c9CHYJ2__attempt1"
    check("and its directory was kept, not deleted", (kept / "result.json").exists(), str(kept))


def test_an_expired_credential_is_terminal_even_with_no_work() -> None:
    """A fresh environment cannot get a fresh token.

    MEASURED 2026-09-13: both re-attempts died at their first API call with
    `"api_error_status":401` and one model turn each. FAILS ON THE PRE-CHANGE
    TREE, where no code reads the error text at all and the by-name match
    spends every attempt in the budget.
    """
    _install_as_an_import_would()
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    q = _fresh([
        _result("UnknownApiError", tokens=None, message=_MEASURED_401),
        _result(None),
        _result(None),
        _result(None),
    ])
    _run(q._execute_trial_with_retries(_config()))
    check("the dead credential was not re-attempted", len(_RUNS) == 1, f"runs={len(_RUNS)}")
    notes = terransoul_hook._HOOK_NOTES.read_text(encoding="utf-8")
    check("and it says STOPPING, with the needle", "STOPPING by-name retries" in notes)
    # The needle quoted is the FIRST match in the recorded text, which for this
    # stream is Claude Code's own status key -- not a paraphrase of it.
    check("the note quotes a needle from the measured stream", 'api_error_status' in notes)


def test_the_credential_refusal_is_sticky_for_the_process() -> None:
    """One dead token dooms every later trial in the same harbor process."""
    _install_as_an_import_would()
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    q = _fresh([_result("UnknownApiError", tokens=None, message=_MEASURED_401), _result(None)])
    _run(q._execute_trial_with_retries(_config()))
    # A LATER trial, whose own failure carries no credential text at all.
    _RUNS.clear()
    _RESULTS.clear()
    _RESULTS.extend([_result("ApiRateLimitError", tokens=None), _result(None)])
    _run(q._execute_trial_with_retries(_config(name="dna-insert__ZZZ")))
    check("the later trial was refused too", len(_RUNS) == 1, f"runs={len(_RUNS)}")
    terransoul_hook._AUTH_TERMINAL_SEEN = None


def test_a_transient_api_error_is_still_retried_after_the_gate() -> None:
    """The gate only ever REMOVES retries; it must not remove the honest ones."""
    _install_as_an_import_would()
    _StubTrialQueue._execute_trial_with_retries = _ORIGINAL_STUB_LOOP
    q = _fresh([_result("ApiRateLimitError", tokens=None), _result(None)])
    res = _run(q._execute_trial_with_retries(_config()))
    check("a pre-work 429 is still a first attempt", len(_RUNS) == 2, f"runs={len(_RUNS)}")
    check("and the clean second attempt is returned", res.exception_info is None)


def test_classify_reclassifies_a_dead_credential_as_harbors_auth_error() -> None:
    """harbor already excludes AgentAuthenticationError from retries; a 401 was
    reaching `UnknownApiError` only because the pattern list has no needle for
    it (base.py:476 vs :507)."""
    from harbor.agents.installed.base import AgentAuthenticationError

    hook = terransoul_hook.TerranSoulHook()
    hook.logs_dir = _TMP / "reclassify" / "agent"
    shutil.rmtree(_TMP / "reclassify", ignore_errors=True)
    stream = "\n".join([
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}}),
        json.dumps({"is_error": True, "num_turns": 1, "api_error_status": 401,
                    "result": "Failed to authenticate. API Error: 401 OAuth access token has expired",
                    "type": "result"}),
    ])
    exc = hook._classify_exec_error("claude --print", _ExecResult(1, stream, ""))
    check(
        "an expired token is harbor's own AgentAuthenticationError",
        isinstance(exc, AgentAuthenticationError),
        f"got {type(exc).__name__}",
    )
    check("harbor's detail is carried over", "stub classification" in str(exc))
    plain = hook._classify_exec_error("claude --print", _ExecResult(1, "API Error: 529 Overloaded", ""))
    check(
        "a 529 is left exactly as harbor classified it",
        not isinstance(plain, AgentAuthenticationError),
        f"got {type(plain).__name__}",
    )


def test_the_auth_needles_do_not_fire_on_a_tasks_own_output() -> None:
    """Precision: a false positive suppresses every later retry in the process."""
    f = terransoul_hook._auth_failure_signature
    check("the measured expiry matches", bool(f(_MEASURED_401)))
    check("the measured revocation matches", bool(f("OAuth access token has been revoked")))
    check("the provider error body matches", bool(f('{"type":"authentication_error"}')))
    check("a 529 does not match", not f("API Error: 529 Overloaded"))
    check("a container HTTP 401 does not match", not f("curl: (22) returned error: 401"))
    check("a task's own 401 does not match", not f("test_auth.py:401 failed; 401 lines"))
    check("a rate limit does not match", not f("rate limit exceeded, please retry"))


def test_the_gate_fails_open_and_loud_when_the_loop_moves() -> None:
    """A harbor upgrade that renames the loop's locals must not silently pass."""
    _install_as_an_import_would()
    q = _StubTrialQueue(_RetryConfig(max_retries=3, include=("UnknownApiError",)))
    before = terransoul_hook._HOOK_NOTES.read_text(encoding="utf-8")
    allowed = q._should_retry_exception("UnknownApiError")      # called with no loop frame
    after = terransoul_hook._HOOK_NOTES.read_text(encoding="utf-8")
    check("the retry is allowed exactly as harbor would", allowed is True)
    check("and the blindness is disclosed", "exposed no `trial`/`result`" in after[len(before):])

def main() -> int:
    tests = [
        test_fingerprint_mismatch_declines_to_patch,
        test_patch_installs_on_a_matching_fingerprint,
        test_late_api_error_after_work_is_not_retried,
        test_pre_work_api_error_is_retried_as_a_first_attempt,
        test_pre_work_retry_preserves_the_failed_attempt,
        test_zero_tokens_but_a_host_capture_counts_as_work,
        test_zero_tokens_but_an_agent_step_in_the_trajectory_counts_as_work,
        test_exception_outside_the_include_list_is_still_never_retried,
        test_classify_exec_error_captures_the_stream_on_the_host,
        test_capture_never_raises_on_an_unwritable_dir,
        test_count_assistant_turns_ignores_non_json_and_other_events,
        test_fingerprint_matches_the_installed_harbor,
        # TBENCH-LATE-API-RETRY-2: the guard must reach the FIRST trial.
        test_the_retry_gate_installer_exists,
        test_a_guard_installed_mid_loop_still_refuses_the_retry,
        test_the_gate_refuses_inside_harbors_own_unpatched_loop,
        test_the_gate_preserves_a_never_ran_attempt_from_harbors_loop,
        test_an_expired_credential_is_terminal_even_with_no_work,
        test_the_credential_refusal_is_sticky_for_the_process,
        test_a_transient_api_error_is_still_retried_after_the_gate,
        test_classify_reclassifies_a_dead_credential_as_harbors_auth_error,
        test_the_auth_needles_do_not_fire_on_a_tasks_own_output,
        test_the_gate_fails_open_and_loud_when_the_loop_moves,
    ]
    print("late-api-retry:")
    for t in tests:
        print(f" {t.__name__}")
        try:
            t()
        except Exception as exc:  # noqa: BLE001 - report, keep going
            print(f"  FAIL {t.__name__}: raised {type(exc).__name__}: {exc}")
            _FAILURES.append(t.__name__)
    shutil.rmtree(_TMP, ignore_errors=True)
    if _FAILURES:
        print(f"\n{len(_FAILURES)} FAILED: {', '.join(_FAILURES)}")
        return 1
    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
