#!/usr/bin/env bash
# E2E tests: builds the E2E variant of SeekChat (in the build container), then
# runs it in a real Zotero under Xvfb against a mock LLM. Headless, Docker only.
# Output (results.json, zotero.log, screenshots) lands in e2e/out/.
set -euo pipefail
cd "$(dirname "$0")/.."

# Full output of every run goes to logs/e2e.log (line-buffered via tee),
# so a long build can be followed with `tail -f logs/e2e.log`.
mkdir -p logs
exec > >(tee logs/e2e.log) 2>&1
echo "== $(date -Is) $0 $*"

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then DOCKER=(sudo docker); fi

./build.sh e2e
"${DOCKER[@]}" build --progress=plain -t seekchat-e2e:latest e2e/
mkdir -p e2e/out test/assets
"${DOCKER[@]}" run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD/dist":/dist:ro -v "$PWD/e2e/out":/out \
  -v "$PWD/test/assets":/assets:ro \
  -e E2E_TIMEOUT="${E2E_TIMEOUT:-240}" \
  seekchat-e2e:latest
