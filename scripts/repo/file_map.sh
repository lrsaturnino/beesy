#!/bin/bash
# Repository file mapping wrapping find with JSON stdin/stdout envelope.
# Accepts JSON stdin with input_patch.path (root directory) and
# input_patch.depth (max depth). Produces a ScriptResultEnvelope JSON
# object on stdout with file tree in state_patch.tree.

set -euo pipefail

# Read full stdin to avoid broken pipe
INPUT=$(cat)

# Extract path and depth from input_patch using lightweight JSON field extraction
ROOT_PATH=$(echo "$INPUT" | grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"path"[[:space:]]*:[[:space:]]*"//;s/"$//' | head -1)
DEPTH=$(echo "$INPUT" | grep -o '"depth"[[:space:]]*:[[:space:]]*[0-9]*' | sed 's/.*"depth"[[:space:]]*:[[:space:]]*//' | head -1)

# Apply defaults when fields are absent or empty
ROOT_PATH="${ROOT_PATH:-.}"
DEPTH="${DEPTH:-3}"

# Validate that depth is a positive integer to prevent find from failing silently
if ! [[ "$DEPTH" =~ ^[0-9]+$ ]]; then
  DEPTH=3
fi

# Validate that the root path exists before attempting find
if [ ! -d "$ROOT_PATH" ]; then
  printf '{"summary":"File map failed: path '"'"'%s'"'"' does not exist or is not a directory","state_patch":{"tree":[]},"metrics":{"file_count":0}}\n' "$ROOT_PATH"
  exit 0
fi

TREE=""
FILE_COUNT=0

# Traverse the directory tree excluding generated/vendored directories
# (node_modules, .git, dist) that are not useful for codebase understanding.
# Results are sorted for deterministic output and capped at 500 entries.
while IFS= read -r line; do
  [ -z "$line" ] && continue

  # Escape backslashes and double quotes for valid JSON string embedding
  ESCAPED=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g')
  [ "$FILE_COUNT" -gt 0 ] && TREE="${TREE},"
  TREE="${TREE}\"${ESCAPED}\""
  FILE_COUNT=$((FILE_COUNT + 1))

  [ "$FILE_COUNT" -ge 500 ] && break
done < <(find "$ROOT_PATH" -maxdepth "$DEPTH" -type f \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  2>/dev/null | sort || true)

# Produce ScriptResultEnvelope JSON on stdout
printf '{"summary":"File map complete: %d files found in '"'"'%s'"'"' (depth %s)","state_patch":{"tree":[%s]},"metrics":{"file_count":%d}}\n' \
  "$FILE_COUNT" "$ROOT_PATH" "$DEPTH" "$TREE" "$FILE_COUNT"
