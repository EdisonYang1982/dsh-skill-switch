#!/usr/bin/env bash
# Run every dsh-skill-switch test against the built lib/.
# Usage: ./test/run-all.sh   (from the plugin root, after `npm run build`)
set -euo pipefail
cd "$(dirname "$0")/.."
node test/verify-scope-routing.mjs
node test/extract-state-region.mjs && node test/session-state.test.mjs
node test/integration-routes.mjs
node test/integration-catalog.mjs
node test/group.test.mjs
echo "all test suites passed"
