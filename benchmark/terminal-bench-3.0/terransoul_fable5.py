# Terminal-Bench 3.0 Harbor adapter — product CLI + Fable 5, never Claude Code.
#
# Harbor owns the task container. `terransoul-console --exec-bridge stdio` owns
# the agent loop and emits a JSONL exec request for every run_command; this
# adapter is the deliberately thin peer that executes those requests through
# Harbor's BaseEnvironment, sends the matching JSONL response, and leaves all
# reasoning/tool selection/memory retrieval in the shipped TerranSoul code.
#
# This is not a second agent implementation. Do not add task-specific logic,
# prompt hints, memory caches, or a direct model client here.

from __future__ import annotations

from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class TerranSoulFable5(BaseInstalledAgent):
    """Run the product TerranSoul CLI against Fable 5 in a Harbor task."""

    # Kept false until the CLI adapter writes a valid ATIF trajectory; Harbor
    # must never be told telemetry exists before it actually does.
    SUPPORTS_ATIF: bool = False

    @staticmethod
    @override
    def name() -> str:
        return "terransoul-fable5"

    @override
    def get_version_command(self) -> str | None:
        return "terransoul-console --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # The release executable is supplied by a pinned image or artifact mount
        # in the campaign runner. Fail loudly rather than falling back to the
        # handwritten Node agent or Claude Code.
        await self.exec_as_agent(
            environment,
            command="command -v terransoul-console >/dev/null",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        base_url = self._get_env("TERRANSOUL_AGENT_BASE_URL")
        api_key = self._get_env("TERRANSOUL_AGENT_API_KEY")
        model = self.model_name or self._get_env("ANTHROPIC_MODEL")
        if not base_url or not api_key or not model:
            raise RuntimeError(
                "TerranSoul Fable agent requires TERRANSOUL_AGENT_BASE_URL, "
                "TERRANSOUL_AGENT_API_KEY, and ANTHROPIC_MODEL"
            )

        # WHY NO --exec-bridge HERE. `BaseEnvironment.exec` is request/response:
        # it returns an ExecResult and exposes no persistent stdin channel
        # (harbor/environments/base.py:1128). The exec bridge needs a live peer
        # answering JSONL on stdin for the whole run, which that contract cannot
        # provide from the host side.
        #
        # So the CLI runs INSIDE the container and owns its own shell. The bridge
        # exists for the opposite topology (host-side loop, remote executor) and
        # is deliberately unused on this path rather than half-wired.
        task_file = "/tmp/terransoul-task.md"
        heredoc = (
            f"cat > {task_file} <<'TERRANSOUL_TASK'\n"
            f"{instruction}\n"
            "TERRANSOUL_TASK\n"
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"{heredoc}"
                f"terransoul-console --agent-task @{task_file} "
                f"--grant-dir /app --mode max --model {model} "
                f"2>&1 | tee /logs/agent/terransoul-console.txt"
            ),
            env={
                "TERRANSOUL_AGENT_BASE_URL": base_url,
                "TERRANSOUL_AGENT_API_KEY": api_key,
                "ANTHROPIC_MODEL": model,
                "WORKDIR": "/app",
            },
        )
