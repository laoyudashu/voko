"""Keep OpenHands' internal Git refresh off the ACP stdin pipe on Windows.

OpenHands refreshes its public-skills cache with ``subprocess.run`` while
handling ``session/new``.  Its Git child otherwise inherits the ACP JSON-RPC
stdin pipe, which can remain open for the lifetime of the session.  Only Git
commands are redirected; the OpenHands process itself keeps its ACP stdin.
"""

import os
import subprocess


_original_run = subprocess.run


def _is_git_command(args):
    if not isinstance(args, (list, tuple)) or not args:
        return False
    command = os.fspath(args[0]) if hasattr(args[0], "__fspath__") else str(args[0])
    return os.path.basename(command).lower() in {"git", "git.exe"}


def _run(*popenargs, **kwargs):
    args = popenargs[0] if popenargs else kwargs.get("args")
    if _is_git_command(args) and kwargs.get("stdin") is None:
        kwargs["stdin"] = subprocess.DEVNULL
    return _original_run(*popenargs, **kwargs)


subprocess.run = _run


def _install_cli_safety_hooks():
    """Keep persisted tool names while disabling every executor in CLI mode.

    OpenHands refuses to resume a conversation when its tool names change. A
    blanket ``tools=[]`` patch therefore breaks ACP -> CLI downgrade. Keeping
    the same schemas and clearing runtime executors preserves the native
    conversation while making terminal/file/MCP actions non-executable.
    """
    if os.environ.get("VOKO_OPENHANDS_CLI_SAFE") != "1":
        return

    try:
        import openhands.sdk.agent.base as agent_base

        original_initialize = agent_base.AgentBase._initialize

        def safe_initialize(self, state):
            result = original_initialize(self, state)
            tools = getattr(self, "_tools", None)
            if isinstance(tools, dict):
                self._tools = {
                    name: tool.model_copy(update={"executor": None})
                    if hasattr(tool, "model_copy") else tool
                    for name, tool in tools.items()
                }
            return result

        agent_base.AgentBase._initialize = safe_initialize
    except Exception:
        pass


_install_cli_safety_hooks()
