"""Batch execution entry point for the external implementation pipeline.

Orchestrates task execution across a dependency graph, delegating
individual tasks to implementation agents. This module is the primary
entry point invoked by the batch bridge adapter.

This is a stub providing the expected interface; full pipeline logic
is implemented externally.
"""

from __future__ import annotations

import sys


def main(task_pack_path: str) -> None:
    """Execute the batch implementation pipeline from a task pack file.

    Args:
        task_pack_path: Path to the task-pack.json file produced by the bridge.

    Raises:
        NotImplementedError: Pipeline execution is handled externally.
    """
    raise NotImplementedError(
        "Batch execution is delegated to the external pipeline. "
        f"Task pack: {task_pack_path}"
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: run_batch.py <task_pack_path>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
