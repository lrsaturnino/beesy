"""Knowledge priming adapter script.

Reads a JSON payload from stdin containing task_state and input_patch,
generates a knowledge-context.md compatibility mirror in the workspace,
and outputs a ScriptResultEnvelope JSON on stdout.

Stdin contract:
    {"task_state": {...}, "input_patch": {...}}

Stdout contract (ScriptResultEnvelope):
    {"summary": "...", "outputs": {...}, "state_patch": {...}, "metrics": {...}}

Exit codes:
    0 - Success
    1 - Failure (malformed input, write error, etc.)
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any


# -- Artifact paths (workspace-relative) ------------------------------------

BEES_DIR = ".bees"
MIRROR_FILENAME = "knowledge-context.md"
MIRROR_REL_PATH = f"{BEES_DIR}/{MIRROR_FILENAME}"


# -- Input handling ---------------------------------------------------------


def read_stdin_payload() -> dict[str, Any]:
    """Read and parse the JSON payload from stdin.

    Returns:
        Parsed dictionary containing task_state and input_patch fields.

    Raises:
        json.JSONDecodeError: When stdin does not contain valid JSON.
        ValueError: When stdin is empty or the parsed result is not a dict.
    """
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("stdin is empty; expected a JSON object")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError(f"Expected a JSON object, got {type(parsed).__name__}")
    return parsed


def resolve_workspace(task_state: dict[str, Any]) -> str:
    """Extract workspace path from task_state, defaulting to cwd.

    Args:
        task_state: Dictionary with optional 'workspace' key.

    Returns:
        Absolute workspace directory path.
    """
    return task_state.get("workspace", os.getcwd())


# -- Content generation -----------------------------------------------------


def build_knowledge_content(task_state: dict[str, Any]) -> str:
    """Build knowledge context markdown from available task state.

    Args:
        task_state: Dictionary containing task metadata such as description.

    Returns:
        Markdown-formatted knowledge context string.
    """
    description = task_state.get("description", "")
    lines = [
        "# Knowledge Context",
        "",
        "## Task Description",
        "",
        description if description else "(no description provided)",
        "",
        "## Repository Analysis",
        "",
        "Knowledge context primed from available workspace state.",
        "",
    ]
    return "\n".join(lines)


# -- File output ------------------------------------------------------------


def write_compatibility_mirror(workspace: str, content: str) -> str:
    """Write the knowledge-context.md compatibility mirror to the workspace.

    Creates the .bees directory if it does not exist and writes the content.

    Args:
        workspace: Absolute path to the workspace root.
        content: Markdown content to write.

    Returns:
        Absolute path to the written mirror file.
    """
    bees_dir = os.path.join(workspace, BEES_DIR)
    os.makedirs(bees_dir, exist_ok=True)
    mirror_path = os.path.join(bees_dir, MIRROR_FILENAME)
    with open(mirror_path, "w", encoding="utf-8") as f:
        f.write(content)
    return mirror_path


# -- Envelope construction --------------------------------------------------


def build_envelope(content_length: int) -> dict[str, Any]:
    """Build the ScriptResultEnvelope for stdout.

    Args:
        content_length: Character length of the generated knowledge content.

    Returns:
        Dictionary conforming to the ScriptResultEnvelope schema.
    """
    return {
        "summary": "Knowledge context primed successfully",
        "outputs": {
            "knowledge_artifact": {
                "path": MIRROR_REL_PATH,
                "label": "Knowledge Context",
                "format": "md",
            }
        },
        "state_patch": {
            "knowledge_primed": True,
        },
        "metrics": {
            "content_length": content_length,
        },
    }


# -- Entry point ------------------------------------------------------------


def main() -> None:
    """Read stdin payload, generate knowledge context, write envelope to stdout."""
    try:
        payload = read_stdin_payload()
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"Failed to parse stdin JSON: {exc}", file=sys.stderr)
        sys.exit(1)

    task_state = payload.get("task_state", {})
    workspace = resolve_workspace(task_state)

    content = build_knowledge_content(task_state)
    write_compatibility_mirror(workspace, content)

    envelope = build_envelope(len(content))
    print(json.dumps(envelope))


if __name__ == "__main__":
    main()
