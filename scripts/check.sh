#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Install explicitly with npm ci first. Never download dependencies during checks.
npm run format:check
npm run typecheck
rm -rf dist
npm run build
npm run db:check
npm test
