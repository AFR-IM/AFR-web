#!/usr/bin/env bash
set -euo pipefail
worker=${1:?Worker name required}
log=$(mktemp)
trap 'rm -f "$log"' EXIT
NO_COLOR=1 npx --no-install wrangler deploy 2>&1 | tee "$log"
version=$(awk '/^Current Version ID: / { print $NF }' "$log" | tail -n 1)
if [[ ! "$version" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "::error::$worker deploy completed but its version ID could not be recorded"
  exit 1
fi
printf -- '- %s version: `%s`\n' "$worker" "$version" >> "${GITHUB_STEP_SUMMARY:?}"
