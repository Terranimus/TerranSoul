# -*- coding: utf-8 -*-
"""Harbor adapter: stock Claude Code, plus TerranSoul's verify-before-stop hook.

WHY THIS EXISTS. `SERVER_INSTRUCTIONS` telling Claude Code about
`brain_verify_completion` (commit 169a6a5f) measured ZERO effect on agent
behaviour across two real Terminal-Bench 3.0 sweeps -- an instruction the
agent may decline is not a guarantee. Claude Code's Stop hook is the actual
enforcement mechanism (deterministic, harness-enforced, not advisory), and
`packages/terransoul-cli/src/stop-hook.mjs` implements the decision logic.
This file is the ONLY piece still missing: the container has no
`@terransoul/cli` installed, so `terransoul stop-hook` is not a command that
exists there.

DELIBERATELY NOT A NEW AGENT. This subclasses Harbor's own `ClaudeCode`
agent and changes nothing about how it runs, what model it drives, or how it
scores -- it adds exactly one extra install step (packing and installing
`@terransoul/core` + `@terransoul/cli`, the same two packages
`terransoul_cli_agent.py` already installs for the CLI-as-agent path) and
relies on Harbor's own EXISTING `--settings` support (`agent.kwargs.config`
-> `BaseInstalledAgent.config_source`) to register the hook. No new
retrieval, no new reasoning, no new scoring path -- the same "a harness that
reasons is a harness that gets credited for the agent's score" discipline
`terransoul_cli_agent.py` states applies here too, just with nothing to
violate it: this harness does not reason at all.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment

# Repo-root-relative, matching terransoul_cli_agent.py exactly.
_CORE_PACKAGE_DIR = Path(__file__).resolve().parents[2] / "packages" / "terransoul-core"
_CLI_PACKAGE_DIR = Path(__file__).resolve().parents[2] / "packages" / "terransoul-cli"


class TerranSoulVerifyHookAgent(ClaudeCode):
    """`claude-code`, with `@terransoul/cli` installed for its Stop hook."""

    @staticmethod
    @override
    def name() -> str:
        # Deliberately distinct from `claude-code` (not
        # `AgentName.CLAUDE_CODE.value`) so a result row can never be
        # misread as the stock agent's — the eval key embeds this name, and
        # this variant runs one real extra thing the stock agent does not.
        return "claude-code-terransoul-hook"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Everything stock Claude Code needs (system deps, Node, the claude
        # binary). This may return early if a compatible version is already
        # present — which is exactly why the CLI install below is
        # unconditional rather than chained after it.
        await super().install(environment)

        if not _CORE_PACKAGE_DIR.exists():
            raise RuntimeError(
                f"TerranSoul core package not found at {_CORE_PACKAGE_DIR}. "
                "The Stop hook imports it via the CLI; installing the CLI "
                "without it produces a hook that fails at startup."
            )
        if not _CLI_PACKAGE_DIR.exists():
            raise RuntimeError(
                f"TerranSoul CLI package not found at {_CLI_PACKAGE_DIR}. "
                "This adapter installs it from the repo working tree; it "
                "does not fall back to a published package, because a "
                "silently different version would invalidate the run."
            )

        # `npm pack` into a scratch dir, upload the tarballs, install
        # globally as root — identical pattern to terransoul_cli_agent.py's
        # `install()`, including the double-quote-not-shlex.quote note
        # (npm.cmd on Windows routes through cmd.exe, where single quotes
        # are literal) and the CORE-then-CLI ordering (a tarball carries
        # only its own files, so both must land in the same node_modules
        # for the CLI's `@terransoul/core` import to resolve).
        import subprocess
        import tempfile
        import shutil

        tmpdir = tempfile.mkdtemp(prefix="harbor-terransoul-hook-")
        try:
            tarballs = []
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

        # Confirm the command Claude Code's Stop hook will actually invoke
        # exists and is executable, INSIDE the container, before the trial
        # starts — not assumed from the install command's own exit code.
        # A silently-missing hook does not error; it just never fires,
        # which reads exactly like the "instruction the agent declined"
        # failure mode this adapter exists to close.
        await self.exec_as_root(
            environment,
            command="command -v terransoul >/dev/null 2>&1 || "
            "(echo 'terransoul CLI not on PATH after install' >&2; exit 1)",
        )
