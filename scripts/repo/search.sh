#!/bin/bash
# Repository content search wrapping grep with JSON stdin/stdout envelope.
# Accepts JSON stdin with input_patch.query (search pattern) and
# input_patch.path (search directory). Produces a ScriptResultEnvelope
# JSON object on stdout with matching lines in state_patch.matches.

set -euo pipefail

# Read full stdin to avoid broken pipe
INPUT=$(cat)

# Extract query and path from input_patch using lightweight JSON field extraction.
# Uses grep to isolate the key-value pair and sed to strip the key and quotes.
QUERY=$(echo "$INPUT" | grep -o '"query"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"query"[[:space:]]*:[[:space:]]*"//;s/"$//' | head -1)
SEARCH_PATH=$(echo "$INPUT" | grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"path"[[:space:]]*:[[:space:]]*"//;s/"$//' | head -1)

# Apply defaults when fields are absent or empty
QUERY="${QUERY:-.}"
SEARCH_PATH="${SEARCH_PATH:-.}"

# Validate that the search path exists before attempting grep
if [ ! -d "$SEARCH_PATH" ] && [ ! -f "$SEARCH_PATH" ]; then
  printf '{"summary":"Search failed: path '"'"'%s'"'"' does not exist","state_patch":{"matches":[]},"metrics":{"match_count":0}}' "$SEARCH_PATH"
  exit 0
fi

# Run grep across source and config file types, collecting structured match objects.
# Results are capped at 100 to prevent oversized JSON output.
MATCHES=""
MATCH_COUNT=0

while IFS= read -r line; do
  [ -z "$line" ] && continue

  # Parse file:line_number:content from grep -n output
  FILE=$(echo "$line" | cut -d: -f1)
  LINE_NUM=$(echo "$line" | cut -d: -f2)
  CONTENT=$(echo "$line" | cut -d: -f3-)

  # Escape backslashes, double quotes, and tabs for valid JSON string embedding.
  # Truncate to 200 characters to prevent oversized individual match entries.
  CONTENT=$(printf '%s' "$CONTENT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | head -c 200)

  [ "$MATCH_COUNT" -gt 0 ] && MATCHES="${MATCHES},"
  MATCHES="${MATCHES}{\"file\":\"${FILE}\",\"line\":${LINE_NUM},\"content\":\"${CONTENT}\"}"
  MATCH_COUNT=$((MATCH_COUNT + 1))

  [ "$MATCH_COUNT" -ge 100 ] && break
done < <(grep -rn --include='*.ts' --include='*.js' --include='*.yaml' --include='*.yml' --include='*.md' --include='*.json' -- "$QUERY" "$SEARCH_PATH" 2>/dev/null || true)

# Produce ScriptResultEnvelope JSON on stdout
printf '{"summary":"Search complete: %d matches found for pattern '"'"'%s'"'"' in '"'"'%s'"'"'","state_patch":{"matches":[%s]},"metrics":{"match_count":%d}}\n' \
  "$MATCH_COUNT" "$QUERY" "$SEARCH_PATH" "$MATCHES" "$MATCH_COUNT"
