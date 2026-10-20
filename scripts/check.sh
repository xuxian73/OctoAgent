#!/usr/bin/env bash
set -euo pipefail

# This is intentionally stack-neutral until docs/spec.md defines the website stack.
if [[ -f package.json ]]; then
  npm test --if-present
  npm run typecheck --if-present
elif [[ -d src ]]; then
  python3 -m compileall -q src
else
  echo "No application source yet; basic environment check passed."
fi
