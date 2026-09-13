# -*- coding: utf-8 -*-
"""Guard: the agent must not be killable by its own task description.

WHY THIS FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md).
Before the split, `run()` issued ONE `exec_as_agent` whose command string was
the heredoc carrying the whole task text CONCATENATED with the `terransoul`
invocation. That single command line is the wrapper shell's argv for the
entire run, so `test_agent_command_carries_no_task_text` fails on the old
adapter: the command that supervises the CLI literally contains
"/app/target_binary". Reverting the split turns this file red.

It is not a hypothetical. Two Terminal-Bench 3.0 trials died at exit 143 that
way, each on its own final tool call:

  memcached-backdoor  pkill -f target_binary   -> SIGTERM to the wrapper
  ico-path-patch      pkill -f './ico'         -> same, ERE '.' matched
                                                  "/root/ico/ico"

Run:  python -m pytest benchmark/terminal-bench-3.0/test_terransoul_cli_agent.py
      (or plain `python test_terransoul_cli_agent.py` — it self-runs)
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from terransoul_cli_agent import TerranSoulCliAgent  # noqa: E402

# Verbatim from the two trials that died, so the guard is anchored to the real
# failure rather than to a phrase invented for the test.
INSTRUCTION = (
    "The binary at `/app/target_binary` is a build of memcached prepared for a "
    "security exercise: a researcher may have inserted a backdoor into it.\n"
    "Also triage `/root/ico/ico` and write `/root/ico/ico_patched`."
)

ENV = {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
    "ANTHROPIC_AUTH_TOKEN": "not-a-real-token",
    "ANTHROPIC_MODEL": "test-model",
}


def _commands() -> list[str]:
    """Every command `run()` hands to `exec_as_agent`, in order."""
    with tempfile.TemporaryDirectory() as logs:
        agent = TerranSoulCliAgent(logs_dir=Path(logs), extra_env=dict(ENV))
        seen: list[str] = []

        async def record(_environment, command, **_kwargs):
            seen.append(command)

        agent.exec_as_agent = record  # type: ignore[method-assign]
        asyncio.run(agent.run(INSTRUCTION, environment=None, context=None))
        return seen


def test_agent_command_carries_no_task_text() -> None:
    commands = _commands()
    agent_cmds = [c for c in commands if "terransoul -p" in c]
    assert len(agent_cmds) == 1, f"expected one agent invocation, got {len(agent_cmds)}"
    cmd = agent_cmds[0]

    # Any path or identifier an agent would plausibly pass to `pkill -f`.
    for token in ("target_binary", "/root/ico/ico", "memcached", "backdoor"):
        assert token not in cmd, (
            f"the command that supervises the CLI contains {token!r}; a "
            f"`pkill -f {token}` inside the task would SIGTERM the harness"
        )


def test_the_task_text_is_still_delivered() -> None:
    """The split must not have dropped the instruction on the floor."""
    commands = _commands()
    assert any("target_binary" in c and "terransoul -p" not in c for c in commands), (
        "no command delivers the task text; the agent would run against an "
        "empty prompt file"
    )
    # And it is delivered as data, via a quoted heredoc delimiter.
    delivery = next(c for c in commands if "target_binary" in c)
    assert "<<'TERRANSOUL_TASK_EOF'" in delivery


def test_the_cli_exit_status_survives_the_tee() -> None:
    """`tee` reports its own status; a crashed CLI must not read as clean."""
    cmd = next(c for c in _commands() if "terransoul -p" in c)
    assert "| tee " in cmd, "the event stream must still reach the trial log"
    assert "echo $? >" in cmd and "exit " in cmd, (
        "the CLI's exit status is masked by tee — a real crash would be "
        "recorded as a completed run"
    )


def test_every_command_is_valid_shell() -> None:
    """Parse what we send, instead of grepping it for reassuring substrings.

    Asserting that a command CONTAINS "echo $? >" says nothing about whether a
    shell can run it. The first version of the status hand-off emitted
    `{ ...; echo $? > /tmp/terransoul-rc }` — a brace group needs a separator
    before its closing brace — and both trials died in under a second with
    `syntax error: unexpected end of file` while three substring assertions
    stayed green. So: hand it to a real parser.
    """
    import shutil
    import subprocess

    shell = shutil.which("bash") or shutil.which("sh")
    if shell is None:  # pragma: no cover - CI images all ship one
        raise AssertionError("no POSIX shell available to parse the commands")

    for cmd in _commands():
        proc = subprocess.run(
            [shell, "-n"], input=cmd, text=True, capture_output=True, check=False
        )
        assert proc.returncode == 0, (
            f"the container would refuse this command:\n{proc.stderr.strip()}\n"
            f"--- command ---\n{cmd}"
        )





def test_the_wall_clock_budget_reaches_the_cli() -> None:
    """WHY THIS FAILS PRE-CHANGE: the adapter read TERRANSOUL_DEADLINE_MS from
    the operator env and nothing else, so it was unset on every real run and the
    CLI's whole Deadline subsystem was inert in the arm it was built for. A
    trial that overran was SIGKILLed mid-turn, and leaderboard static analysis
    rejects a rewarded trial with no ATIF trajectory — so an overrun threw away
    any point the run had earned.
    """
    from terransoul_cli_agent import _deadline_ms_from

    # Harbor's own boilerplate, verbatim from two real task statements.
    assert _deadline_ms_from("You have 5400 seconds to complete this task.") == 5_130_000
    assert _deadline_ms_from("You have 7200 seconds to complete this task.") == 6_840_000
    # Short of the real budget, so the CLI can conclude and write its trajectory.
    assert _deadline_ms_from("You have 5400 seconds to complete this task.") < 5_400_000
    # No statement, no invention.
    assert _deadline_ms_from("Fix the failing test.") is None
    assert _deadline_ms_from("") is None


def test_an_explicit_deadline_outranks_the_parsed_one() -> None:
    """An operator who states a budget must not be silently overridden."""
    with tempfile.TemporaryDirectory() as logs:
        env = dict(ENV, TERRANSOUL_DEADLINE_MS="123456")
        agent = TerranSoulCliAgent(logs_dir=Path(logs), extra_env=env)
        seen: list[dict] = []

        async def record(_environment, command, **kwargs):
            seen.append(kwargs.get("env") or {})

        agent.exec_as_agent = record  # type: ignore[method-assign]
        asyncio.run(
            agent.run(
                "You have 5400 seconds to complete this task.",
                environment=None,
                context=None,
            )
        )
    assert any(e.get("TERRANSOUL_DEADLINE_MS") == "123456" for e in seen)


def test_the_parsed_deadline_is_actually_passed_to_the_container() -> None:
    """Deriving it and then not exporting it would be the same defect."""
    with tempfile.TemporaryDirectory() as logs:
        agent = TerranSoulCliAgent(logs_dir=Path(logs), extra_env=dict(ENV))
        seen: list[dict] = []

        async def record(_environment, command, **kwargs):
            seen.append(kwargs.get("env") or {})

        agent.exec_as_agent = record  # type: ignore[method-assign]
        asyncio.run(agent.run(INSTRUCTION + "\n\nYou have 600 seconds to complete this task.", environment=None, context=None))
    assert any(e.get("TERRANSOUL_DEADLINE_MS") == "570000" for e in seen)


# The self-runner iterates globals(), so it MUST stay the last thing in this
# file. When it sat mid-file the three tests defined below it were never
# defined at the time it ran, and the file reported 4 ok and exit 0 while
# silently skipping them.
if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    sys.exit(1 if failures else 0)


def test_a_missing_workdir_does_not_skip_the_agent() -> None:
    """WHY THIS FAILS PRE-CHANGE: the command began `cd /app && { terransoul ...`.

    On a task image without that directory the `cd` fails, `&&` short-circuits,
    and the agent is NEVER INVOKED — no stream log, no trajectory — while the
    trial is still graded. A zero is then attributed to the model for a harness
    fault, which is the confusion this campaign exists to stop making.

    Executed, not grepped: run the real command in a real shell with the
    directory removed and a stubbed CLI, and check the agent leg still runs.
    `test_every_command_is_valid_shell` already showed that substring
    assertions pass while the container refuses the command.
    """
    import shutil
    import subprocess

    shell = shutil.which("bash") or shutil.which("sh")
    if shell is None:  # pragma: no cover
        raise AssertionError("no POSIX shell available")

    cmd = next(c for c in _commands() if "terransoul -p" in c)
    # Point the guard at a directory that certainly does not exist, and replace
    # the CLI with a marker so we can see whether it was reached at all.
    probe = cmd.replace("/app", "/definitely-not-here-9d3f").replace(
        "terransoul -p", "echo AGENT_RAN; true -p"
    )
    proc = subprocess.run(
        [shell, "-c", probe], text=True, capture_output=True, check=False
    )
    assert "AGENT_RAN" in proc.stdout, (
        "the agent leg was skipped when the working directory was absent — "
        f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )


def test_the_packed_cli_runs_standalone() -> None:
    """WHY THIS FAILS PRE-CHANGE: the CLI imports @terransoul/core, and a tarball
    carries only its own files.

    Installing the CLI tarball alone into an empty prefix and running it gives

        Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../terransoul-core/...

    which kills every trial at startup, before a single turn — and no unit test
    in either package can see it, because in the repo the import resolves
    through the workspace. The defect lives in the PACKAGING, so only packaging
    can catch it.

    This is the guard for a whole class: any future shared module added to the
    CLI without being installed alongside it fails here rather than in a sweep.
    """
    import json as _json
    import os
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path as _Path

    if shutil.which("npm") is None:  # pragma: no cover - dev machines all have it
        return

    core = _Path(__file__).resolve().parents[2] / "packages" / "terransoul-core"
    cli = _Path(__file__).resolve().parents[2] / "packages" / "terransoul-cli"
    tmp = tempfile.mkdtemp(prefix="ts-packtest-")
    try:
        names = []
        for pkg in (core, cli):
            raw = subprocess.check_output(
                f'npm pack --json "{pkg}"', cwd=tmp, text=True, shell=True
            )
            names.append(_json.loads(raw)[0]["filename"])

        prefix = _Path(tmp) / "prefix"
        prefix.mkdir()
        subprocess.check_call(
            f'npm install --prefix "{prefix}" --no-audit --no-fund '
            + " ".join(f'"./{n}"' for n in names),
            cwd=tmp,
            shell=True,
        )

        entry = prefix / "node_modules" / "@terransoul" / "cli" / "bin" / "terransoul.mjs"
        assert entry.exists(), f"the packed CLI has no entry point at {entry}"
        out = subprocess.run(
            ["node", str(entry), "--version"], capture_output=True, text=True, check=False
        )
        assert out.returncode == 0, (
            "the packed CLI does not run standalone — this is what every "
            f"container would see:\n{out.stderr.strip()}"
        )

        # AND IT MUST REACH THE AGENT LOOP, not merely print a version.
        #
        # `--version` exits within a few lines of main(), so this guard was
        # green while main() carried a ReferenceError two hundred lines further
        # down — `env.TERRANSOUL_REVIEWER_MODEL` in a scope that only has
        # `process.env`. Every trial of a sweep died at startup with
        #
        #     error: ReferenceError: env is not defined
        #
        # and this test, written for exactly that class of defect, reported the
        # CLI as fine because it had never executed the line.
        #
        # The dead endpoint is deliberate: this asserts the process gets as far
        # as trying to reach a model, which is past everything that can throw at
        # wiring time. A ReferenceError is a crash; an unreachable endpoint is a
        # result.
        run_env = dict(os.environ)
        run_env.update(
            {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
                "ANTHROPIC_AUTH_TOKEN": "not-a-real-key",
                "TERRANSOUL_REVIEWER_MODEL": "claude-sonnet-5",
                "TERRANSOUL_MAX_ITERATIONS": "1",
            }
        )
        run = subprocess.run(
            [
                "node", str(entry), "-p", "say hi",
                "--model", "test-model",
                "--output-format", "stream-json", "--verbose",
                "--memory-scope", "off",
            ],
            capture_output=True, text=True, check=False, env=run_env, timeout=180,
        )
        combined = run.stdout + run.stderr
        for crash in ("ReferenceError", "TypeError", "is not defined", "is not a function"):
            assert crash not in combined, (
                f"the packed CLI crashed on a wiring error ({crash}) before reaching "
                f"the model:\n{combined[-1500:]}"
            )
        assert '"type":"system"' in run.stdout, (
            "the CLI never emitted its init event, so it did not reach the agent "
            f"loop at all:\n{combined[-1500:]}"
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
