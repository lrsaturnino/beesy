"""Batch bridge adapter script.

Translates Bees planning artifacts into Memory Bank task packs.
Reads a JSON payload from stdin, validates planning data, generates
a task-pack.json in the workspace, and outputs a ScriptResultEnvelope
JSON on stdout.

Stdin contract:
    {"task_state": {"planning_doc": "...", "workspace": "..."}, "input_patch": {...}}

Stdout contract (ScriptResultEnvelope):
    {"summary": "...", "outputs": {...}, "state_patch": {...}, "metrics": {...}}

Exit codes:
    0 - Success
    1 - Failure (missing planning data, translation error, etc.)
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any


# -- Artifact paths (workspace-relative) ------------------------------------

BEES_DIR = ".bees"
TASK_PACK_FILENAME = "task-pack.json"
TASK_PACK_REL_PATH = f"{BEES_DIR}/{TASK_PACK_FILENAME}"
PIPELINE_ENTRY_POINT = "run_batch.py"
PIPELINE_DIR_NAME = "mb-batch-implement"

# Markdown list prefixes recognised during planning document parsing
_LIST_PREFIXES = ("-", "*")


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


# -- Validation -------------------------------------------------------------


def validate_planning_data(task_state: dict[str, Any]) -> str:
    """Validate that required planning data is present for translation.

    Args:
        task_state: Dictionary expected to contain a 'planning_doc' string.

    Returns:
        The validated, non-empty planning document string.

    Raises:
        ValueError: When planning_doc is missing, non-string, or blank.
    """
    planning_doc = task_state.get("planning_doc")
    if not planning_doc or not isinstance(planning_doc, str) or not planning_doc.strip():
        raise ValueError(
            "Missing or empty 'planning_doc' in task_state. "
            "Cannot translate planning artifacts without a planning document."
        )
    return planning_doc


# -- Translation ------------------------------------------------------------


def _extract_list_items(text: str) -> list[str]:
    """Extract markdown list items from a document.

    Recognises lines starting with '-' or '*' as list entries and
    strips the prefix to yield clean step descriptions.

    Args:
        text: Raw markdown text to parse.

    Returns:
        Ordered list of step description strings.
    """
    items: list[str] = []
    for raw_line in text.strip().split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(_LIST_PREFIXES):
            # Strip the bullet character and leading whitespace
            items.append(line.lstrip("- ").lstrip("* "))
    return items


def translate_to_task_pack(planning_doc: str) -> dict[str, Any]:
    """Translate a planning document into a task pack structure.

    Parses markdown list items from the planning document and builds
    a structured task pack that the external pipeline can consume.

    Args:
        planning_doc: Markdown planning document content.

    Returns:
        Dictionary conforming to the task pack schema with version,
        source, and ordered task list.
    """
    steps = _extract_list_items(planning_doc)
    return {
        "version": "1.0",
        "source": "bees-batch-bridge",
        "tasks": [
            {"id": f"step-{i + 1}", "description": step}
            for i, step in enumerate(steps)
        ],
    }


# -- Pipeline asset discovery -----------------------------------------------


def locate_pipeline_assets() -> str:
    """Verify that the external pipeline assets are reachable.

    Locates the pipeline entry point (run_batch.py) relative to this
    script's directory.

    Returns:
        Absolute path to the pipeline directory.

    Raises:
        FileNotFoundError: When run_batch.py is not at the expected location.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    pipeline_dir = os.path.join(script_dir, PIPELINE_DIR_NAME)
    entry_point = os.path.join(pipeline_dir, PIPELINE_ENTRY_POINT)

    if not os.path.isfile(entry_point):
        raise FileNotFoundError(
            f"Pipeline asset '{PIPELINE_ENTRY_POINT}' not found at "
            f"expected path: {entry_point}"
        )

    return pipeline_dir


# -- File output ------------------------------------------------------------


def write_task_pack(workspace: str, task_pack: dict[str, Any]) -> str:
    """Write the translated task pack JSON to the workspace .bees directory.

    Args:
        workspace: Absolute path to the workspace root.
        task_pack: Task pack dictionary to serialise.

    Returns:
        Absolute path to the written task-pack.json file.
    """
    bees_dir = os.path.join(workspace, BEES_DIR)
    os.makedirs(bees_dir, exist_ok=True)
    pack_path = os.path.join(bees_dir, TASK_PACK_FILENAME)
    with open(pack_path, "w", encoding="utf-8") as f:
        json.dump(task_pack, f, indent=2)
    return pack_path


# -- Envelope construction --------------------------------------------------


def build_envelope(task_count: int) -> dict[str, Any]:
    """Build the ScriptResultEnvelope for stdout.

    Args:
        task_count: Number of tasks in the translated task pack.

    Returns:
        Dictionary conforming to the ScriptResultEnvelope schema.
    """
    return {
        "summary": f"Translated planning artifacts into task pack with {task_count} tasks",
        "outputs": {
            "task_pack": {
                "path": TASK_PACK_REL_PATH,
                "label": "Task Pack",
                "format": "json",
            }
        },
        "state_patch": {
            "batch_bridge_complete": True,
        },
        "metrics": {
            "task_count": task_count,
        },
    }


# -- Entry point ------------------------------------------------------------


def main() -> None:
    """Read stdin payload, validate planning data, translate, and write envelope."""
    try:
        payload = read_stdin_payload()
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"Failed to parse stdin JSON: {exc}", file=sys.stderr)
        sys.exit(1)

    task_state: dict[str, Any] = payload.get("task_state", {})

    # Fail fast: validate required planning data before any other work
    try:
        planning_doc = validate_planning_data(task_state)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    # Fail fast: verify pipeline assets are reachable
    try:
        locate_pipeline_assets()
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    workspace = resolve_workspace(task_state)
    task_pack = translate_to_task_pack(planning_doc)
    write_task_pack(workspace, task_pack)

    envelope = build_envelope(len(task_pack["tasks"]))
    print(json.dumps(envelope))


if __name__ == "__main__":
    main()
