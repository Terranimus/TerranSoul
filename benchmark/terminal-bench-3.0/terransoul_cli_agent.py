# -*- coding: utf-8 -*-
"""Harbor adapter: the TerranSoul CLI (`packages/terransoul-cli`) + Fable 5.

No Claude Code anywhere on this path. No Tauri build either — the CLI is a Node
package, so installing it in a linux/amd64 task container is `apt-get nodejs`
plus `npm install -g`, not a two-hour cargo build that drags in GTK, WebKit,
dbus, libclang and whisper for an agent loop that touches none of them (see
LINUX-BUILD-FINDINGS.md).

This adapter is deliberately thin. It installs, it runs, it converts the
trajectory. It holds no prompt text, no task-specific logic, no memory, and no
model client — all of that lives in the CLI, which is the thing being measured
(`rules/one-path-three-surfaces.md`; a harness that reasons is a harness that
gets credited for the agent's score).
"""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Repo-root-relative location of the CLI package, packed with `npm pack` at
# install time so node_modules never crosses into the container.
_CLI_PACKAGE_DIR = Path(__file__).resolve().parents[2] / "packages" / "terransoul-cli"
_CORE_PACKAGE_DIR = Path(__file__).resolve().parents[2] / "packages" / "terransoul-core"

_NODE_MAJOR = "20"

# Inside the container. `/logs/agent` is Harbor's own mount (EnvironmentPaths),
# so anything written here lands in the trial directory the leaderboard reads.
_TASK_FILE = "/tmp/terransoul-task.md"
_RC_FILE = "/tmp/terransoul-rc"

# Harbor's own boilerplate, identical across tasks. Nothing task-specific.
_BUDGET_RE = re.compile(r"You have (\d+) seconds to complete this task", re.IGNORECASE)

# The CLI must CONCLUDE and write its trajectory before Harbor's timer fires, so
# the deadline it is told is deliberately short of the real one. The margin is a
# fraction rather than a constant because the budgets differ by task (5400 s and
# 7200 s are both real), and a fixed 60 s reads very differently against each.
_DEADLINE_SAFETY = 0.95


_TRAJECTORY = "/logs/agent/trajectory.json"
_STREAM_LOG = "/logs/agent/terransoul-stream.jsonl"


def _deadline_ms_from(instruction: str) -> int | None:
    """The wall-clock budget Harbor stated in the instruction, in ms."""
    match = _BUDGET_RE.search(instruction or "")
    if not match:
        return None
    return int(int(match.group(1)) * _DEADLINE_SAFETY * 1000)


class TerranSoulCliAgent(BaseInstalledAgent):
    """TerranSoul CLI driving Fable 5 through its own agentic loop."""

    # True because the CLI genuinely writes /logs/agent/trajectory.json in ATIF
    # v1.7. Declaring it without writing one is worse than declaring False: the
    # leaderboard's static analysis fails any trial with reward > 0 and no
    # trajectory, so the PASSING trials would be the rejected ones.
    SUPPORTS_ATIF: bool = True

    _INSTALL_CHECK_COMMAND = "command -v terransoul >/dev/null 2>&1"

    @staticmethod
    @override
    def name() -> str:
        return "terransoul-cli"

    @override
    def get_version_command(self) -> str | None:
        return "terransoul --version"

    def _declared_gpus(self) -> int:
        """GPUs this task declares it needs, from its own `task.toml`.

        READ, NOT LEARNED. `run-terransoul.sh` already greps the same field to
        decide whether a task can run on this machine at all, because Harbor
        raises the requirement while BUILDING the environment rather than
        exposing it through `get_task_configs()`. So the value is available from
        the dataset cache and nowhere else.

        Returns 0 whenever it cannot be read. A parse failure must never look
        like a GPU requirement: that would silently exclude the student from a
        task for a typo, turning a cheap run into a teacher run and reporting the
        escalation as if the model had needed help.
        """
        import re

        try:
            task = getattr(self, "_task_dir", None) or getattr(self, "task_dir", None)
            if task is None:
                return 0
            toml = Path(task) / "task.toml"
            if not toml.exists():
                return 0
            for line in toml.read_text(encoding="utf-8").splitlines():
                m = re.match(r"\s*gpus\s*=\s*(\d+)", line)
                if m:
                    return int(m.group(1))
        except Exception:
            # A harness that cannot read a task's config still runs the task.
            return 0
        return 0

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Keys are Harbor's own SYSTEM_PACKAGES keys, which are underscored and
        # do NOT match the distro package names — `ca-certificates` raises
        # "Unknown system dependencies" before a single container command runs.
        # Measured against harbor 0.21.0's base.py:317-430.
        await self.ensure_system_dependencies(environment, ["curl", "ca_certificates"])

        # Node from NodeSource when absent. Alpine images get the apk package
        # instead; both are real container bases in this dataset.
        await self.exec_as_root(
            environment,
            command=(
                "if command -v node >/dev/null 2>&1; then exit 0; fi; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "  export DEBIAN_FRONTEND=noninteractive; "
                f"  curl -fsSL https://deb.nodesource.com/setup_{_NODE_MAJOR}.x | bash -; "
                "  apt-get install -y -qq nodejs; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache nodejs npm; "
                "else "
                "  echo 'no supported package manager for Node' >&2; exit 1; "
                "fi"
            ),
        )

        if not _CORE_PACKAGE_DIR.exists():
            raise RuntimeError(
                f"TerranSoul core package not found at {_CORE_PACKAGE_DIR}. "
                "The CLI imports it; installing the CLI without it produces an "
                "agent that dies at startup with ERR_MODULE_NOT_FOUND."
            )
        if not _CLI_PACKAGE_DIR.exists():
            raise RuntimeError(
                f"TerranSoul CLI package not found at {_CLI_PACKAGE_DIR}. "
                "This adapter installs the CLI from the repo working tree; it does "
                "not fall back to a published package, because a silently different "
                "version would invalidate the run."
            )

        # `npm pack` into a scratch dir, upload the tarball, install globally.
        # mkdtemp rather than TemporaryDirectory: the tarball must still exist
        # when upload_file runs.
        import subprocess
        import tempfile
        import shutil

        tmpdir = tempfile.mkdtemp(prefix="harbor-terransoul-cli-")
        try:
            # DOUBLE quotes, not shlex.quote. `npm` is `npm.cmd` on Windows, so
            # this runs through cmd.exe, where single quotes are LITERAL
            # characters — `npm pack 'D:\path'` fails with a bare ENOENT and no
            # hint as to why. Double quotes are understood by both cmd.exe and
            # POSIX sh, and the path is ours, not user input.
            # BOTH PACKAGES, and the order matters at install time.
            #
            # The CLI imports @terransoul/core, which holds the routing and the
            # escalation policy shared with the MCP server and the desktop app.
            # A tarball carries only its OWN files: npm bundles a workspace
            # dependency into neither, and `bundleDependencies` does not follow
            # a workspace symlink. Verified by installing the CLI tarball alone
            # into an empty prefix and running it —
            #   Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../core
            # which would have killed every trial at startup, before a single
            # turn. Installing both into one prefix puts them side by side in
            # the same node_modules, where Node's resolver finds core from the
            # CLI. That is what `test_the_packed_cli_runs_standalone` pins.
            tarballs = []
            for package_dir in (_CORE_PACKAGE_DIR, _CLI_PACKAGE_DIR):
                # DOUBLE quotes, not shlex.quote. `npm` is `npm.cmd` on Windows,
                # so this runs through cmd.exe, where single quotes are LITERAL
                # characters — `npm pack 'D:\path'` fails with a bare ENOENT and
                # no hint as to why. Double quotes are understood by both
                # cmd.exe and POSIX sh, and the path is ours, not user input.
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

        # One install command, so npm resolves them together.
        joined = " ".join(f"/tmp/{name}" for name in tarballs)
        await self.exec_as_root(environment, command=f"npm install -g {joined}")

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = self.model_name or self._get_env("ANTHROPIC_MODEL")
        base_url = self._get_env("ANTHROPIC_BASE_URL")
        auth_token = self._get_env("ANTHROPIC_AUTH_TOKEN")
        if not model or not base_url or not auth_token:
            raise RuntimeError(
                "terransoul-cli requires ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and "
                "a model (--model or ANTHROPIC_MODEL), injected via `harbor run --ae`"
            )

        # Memory scope is EXPLICIT on the command line, never inherited from a
        # settings file or an ambient default. The leaderboard judge fails a
        # submission for `harness_level_cheating`, which it defines to include
        # "prior-run post-mortems", so which scope a run used has to be legible
        # from the trial's own recorded command.
        memory_scope = self._get_env("TERRANSOUL_MEMORY_SCOPE") or "session"

        # The CLI grants its own cwd, so the working directory IS the sandbox
        # root. Set it explicitly rather than inheriting whatever the image's
        # WORKDIR happens to be — a task whose image lands the agent in `/`
        # would otherwise grant the whole filesystem.
        workdir = self._get_env("WORKDIR") or "/app"
        env = {
            "ANTHROPIC_BASE_URL": base_url,
            "ANTHROPIC_AUTH_TOKEN": auth_token,
            "ANTHROPIC_MODEL": model,
            # THE TASK'S OWN DECLARED RESOURCE REQUIREMENT, read from the dataset
            # rather than learned from a previous attempt.
            #
            # A local student is served from this machine's GPU, so on a task
            # that declares it needs one, serving the student competes with the
            # graded work for the card — and the trial then records a capability
            # result for a hardware collision. The orchestrator excludes the
            # student for that task only.
            #
            # Nothing here crosses a run boundary: it is configuration handed to
            # us, in the same place the harness already reads timeouts and
            # resource limits, so it cannot encode a prior-run post-mortem
            # (`rules/bench-agi-purity.md`).
            "TERRANSOUL_TASK_GPUS": str(self._declared_gpus()),
        }
        # The agent's own wall-clock budget.
        #
        # Harbor really does not hand an adapter the per-task agent timeout:
        # `agent_timeout_sec` is computed in `trial.py:_compute_agent_timeout_sec`
        # and passed only to the ORACLE agent (`trial.py:826`), and `AgentContext`
        # carries token counts and nothing else. But Harbor DOES state the budget
        # in the instruction itself, in one uniform sentence across tasks, e.g.
        #
        #     You have 5400 seconds to complete this task.
        #     You have 7200 seconds to complete this task.
        #
        # so the only source of truth available is the one the agent is already
        # being shown. Reading it here is harness plumbing, not task knowledge:
        # the pattern is Harbor's boilerplate, identical for every task, and
        # nothing about the task's SUBJECT is parsed (`rules/bench-agi-purity.md`).
        #
        # Without this the entire Deadline subsystem is inert in the arm it was
        # built for, and a trial that overruns is SIGKILLed mid-turn. That is not
        # merely untidy: leaderboard static analysis rejects a rewarded trial
        # with no ATIF trajectory, so a run killed before it can finalize throws
        # away any point it had earned.
        deadline_ms = self._get_env("TERRANSOUL_DEADLINE_MS") or _deadline_ms_from(instruction)
        if deadline_ms:
            env["TERRANSOUL_DEADLINE_MS"] = str(deadline_ms)

        thinking_mode = self._get_env("TERRANSOUL_THINKING_MODE") or "chat"

        # Turn budget for this bench. The brain's default (30) is tuned for the
        # self-improve edit loop; a terminal task is mostly exploration and
        # Claude Code spent 101-242 turns on these same tasks. Declared here so
        # the trial's own recorded command states the budget it ran under.
        max_iterations = self._get_env("TERRANSOUL_MAX_ITERATIONS") or "150"
        env["TERRANSOUL_MAX_ITERATIONS"] = max_iterations

        mcp_url = self._get_env("TERRANSOUL_MCP_URL")
        if mcp_url:
            env["TERRANSOUL_MCP_URL"] = mcp_url
        mcp_token = self._get_env("TERRANSOUL_MCP_TOKEN")
        if mcp_token:
            env["TERRANSOUL_MCP_TOKEN"] = mcp_token

        # The instruction reaches the container as a file, written from a heredoc
        # with a quoted delimiter so nothing in the task text is expanded by the
        # shell. Task text is data.
        heredoc = f"cat > {_TASK_FILE} <<'TERRANSOUL_TASK_EOF'\n{instruction}\nTERRANSOUL_TASK_EOF\n"

        # TWO execs, not one, and the split is load-bearing.
        #
        # THE TASK TEXT MUST NOT BE IN THE ARGV OF THE PROCESS THAT SUPERVISES
        # THE AGENT. When the heredoc and the agent invocation shared a single
        # command string, the wrapper shell's own /proc/<pid>/cmdline held the
        # whole task description for the entire run — and `pkill -f <pattern>`
        # matches command lines, not process trees. Two Terminal-Bench 3.0
        # trials died at exit 143 (SIGTERM) that way, each on its own final
        # tool call, with no crash and nothing in the CLI at fault:
        #
        #   memcached-backdoor  `pkill -f target_binary`   matched the wrapper,
        #                       whose argv quoted "/app/target_binary" from the
        #                       task statement.
        #   ico-path-patch      `pkill -f './ico'`         same, via the ERE `.`
        #                       matching "/root/ico/ico".
        #
        # Restarting a service under test is ordinary, correct agent behaviour;
        # an agent that must avoid naming its own task is being handicapped by
        # its harness. So the text lives in the container only as a FILE, and
        # the supervising command line names nothing task-specific.
        await self.exec_as_agent(environment, command=heredoc, env=env)

        # `tee` would report ITS exit status, not the CLI's, so a real crash
        # would be recorded as a clean run. `pipefail` is not POSIX (dash lacks
        # it), hence the explicit status hand-off, which works in any /bin/sh
        # while still streaming the events live.
        await self.exec_as_agent(
            environment,
            command=(
                # `cd X && ...` SHORT-CIRCUITS INTO A SILENT NON-RUN.
                #
                # Not every task image has the directory this defaults to: on
                # the 74-task set, some tasks lay the work out elsewhere. When
                # the `cd` fails, `&&` skips the whole agent invocation, the
                # command exits nonzero with no stream log and no trajectory,
                # and the trial is graded as an attempt the agent never made.
                # That is a zero attributed to the model for a harness fault —
                # the exact confusion this campaign keeps paying for.
                #
                # Falling back to `/` would be worse than failing: the CLI
                # grants its own cwd as the sandbox root, so `/` would hand the
                # agent the entire filesystem. So: use the directory if it
                # exists, otherwise stay where the image's own WORKDIR put us,
                # and say on stderr which one happened so the trial log records
                # it rather than leaving it to be inferred.
                f"if [ -d {shlex.quote(workdir)} ]; then cd {shlex.quote(workdir)}; "
                f"else echo \"[adapter] {workdir} absent; using $(pwd)\" >&2; fi && "
                "{ "
                f"terransoul -p @{_TASK_FILE}"
                f" --model {shlex.quote(model)}"
                f" --memory-scope {shlex.quote(memory_scope)}"
                f" --thinking-mode {shlex.quote(thinking_mode)}"
                " --output-format stream-json --verbose"
                f" --trajectory-path {_TRAJECTORY}"
                f"; echo $? > {_RC_FILE}"
                "; } "
                f"| tee {_STREAM_LOG}; exit \"$(cat {_RC_FILE})\""
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Fill Harbor's token counters from the CLI's own terminal event.

        Runs on the HOST after logs sync back, so it reads `self.logs_dir`
        rather than the container. Synchronous, matching the base signature.

        Without this the job's `n_input_tokens` / `n_output_tokens` come back
        None, which matters twice. A sweep cannot be costed. And a run that
        produced ZERO output tokens — the signature of a run that never actually
        happened, e.g. a revoked credential — becomes indistinguishable in the
        mean from a run that genuinely attempted every task and failed. This
        repo has published that exact confusion once, over 20 trials.

        Best-effort by design: a trial whose agent died before writing a stream
        must still report its own real failure, not a secondary parse error
        raised by the accounting code.
        """
        stream_path = self.logs_dir / Path(_STREAM_LOG).name
        if not stream_path.exists():
            return

        result = None
        try:
            for line in stream_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") == "result":
                    result = event
        except OSError:
            return

        if not result:
            return

        usage = result.get("usage") or {}
        context.n_input_tokens = int(usage.get("input_tokens") or 0)
        context.n_output_tokens = int(usage.get("output_tokens") or 0)
        context.n_cache_tokens = int(usage.get("cache_read_input_tokens") or 0)
