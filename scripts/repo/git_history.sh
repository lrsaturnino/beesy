#!/bin/bash
# Repository git history analysis wrapping git log and git blame with
# JSON stdin/stdout envelope. Accepts JSON stdin with input_patch.path
# (file or directory) and input_patch.mode ("log" or "blame").
# Produces a ScriptResultEnvelope JSON object on stdout.

set -euo pipefail

# Read full stdin to avoid broken pipe
INPUT=$(cat)

# Extract path and mode from input_patch using lightweight JSON field extraction
TARGET_PATH=$(echo "$INPUT" | grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"path"[[:space:]]*:[[:space:]]*"//;s/"$//' | head -1)
MODE=$(echo "$INPUT" | grep -o '"mode"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"mode"[[:space:]]*:[[:space:]]*"//;s/"$//' | head -1)

# Apply defaults when fields are absent or empty
TARGET_PATH="${TARGET_PATH:-.}"
MODE="${MODE:-log}"

# Escape a single line for safe embedding in a JSON string.
# Handles backslashes, double quotes, and tabs; truncates to 300 chars.
escape_json_line() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | head -c 300
}

ENTRIES=""
ENTRY_COUNT=0

if [ "$MODE" = "blame" ]; then
  # Blame mode: requires a file path (not a directory).
  # When given a directory, produces zero entries gracefully.
  if [ -f "$TARGET_PATH" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      ESCAPED=$(escape_json_line "$line")
      [ "$ENTRY_COUNT" -gt 0 ] && ENTRIES="${ENTRIES},"
      ENTRIES="${ENTRIES}\"${ESCAPED}\""
      ENTRY_COUNT=$((ENTRY_COUNT + 1))
      [ "$ENTRY_COUNT" -ge 100 ] && break
    done < <(git blame --line-porcelain "$TARGET_PATH" 2>/dev/null | grep -E '^(author |summary )' | head -200 || true)
  fi
else
  # Log mode (default): most recent 50 commits touching the target path
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ESCAPED=$(escape_json_line "$line")
    [ "$ENTRY_COUNT" -gt 0 ] && ENTRIES="${ENTRIES},"
    ENTRIES="${ENTRIES}\"${ESCAPED}\""
    ENTRY_COUNT=$((ENTRY_COUNT + 1))
    [ "$ENTRY_COUNT" -ge 50 ] && break
  done < <(git log --oneline -50 -- "$TARGET_PATH" 2>/dev/null || true)
fi

# Produce ScriptResultEnvelope JSON on stdout
printf '{"summary":"Git %s complete: %d entries for '"'"'%s'"'"'","state_patch":{"entries":[%s]},"metrics":{"entry_count":%d}}\n' \
  "$MODE" "$ENTRY_COUNT" "$TARGET_PATH" "$ENTRIES" "$ENTRY_COUNT"
