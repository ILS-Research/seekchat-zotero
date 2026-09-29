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

# Optional live scenarios against a real model server, e.g.
#   E2E_LIVE_URL=https://ollama.ils.local E2E_LIVE_MODEL=qwen3_8_27b_128k:latest ./e2e/run.sh
# (E2E_LIVE_PROVIDER=openai for /v1 servers, E2E_LIVE_API_KEY for servers that need a bearer key).
# Without E2E_LIVE_URL they are skipped.
LIVE=()
# The portal (reverse proxy, certificate signed by the in-house CA) must be reachable by name in the container.
portal_ip=$(getent hosts zotero.ils.local | awk '{print $1; exit}')
[ -n "$portal_ip" ] && LIVE+=(--add-host "zotero.ils.local:$portal_ip" -e E2E_PORTAL=true)
if [ -n "${E2E_LIVE_URL:-}" ]; then
  LIVE=(-e E2E_LIVE_URL -e E2E_LIVE_MODEL -e E2E_LIVE_PROVIDER -e E2E_LIVE_API_KEY)
  # Resolve the host here, in case the container's DNS does not know internal names.
  live_host=$(echo "$E2E_LIVE_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')
  live_ip=$(getent hosts "$live_host" | awk '{print $1; exit}')
  [ -n "$live_ip" ] && LIVE+=(--add-host "$live_host:$live_ip")
fi

# Optional: SeekBook sideloaded as well (live scenario with a real book index), e.g.
#   E2E_SEEKBOOK_XPI=../seekbook-zotero_src/dist/seekbook-0.3.3.xpi E2E_LIVE_URL=… ./e2e/run.sh
if [ -n "${E2E_SEEKBOOK_XPI:-}" ]; then
  LIVE+=(-v "$(realpath "$E2E_SEEKBOOK_XPI")":/seekbook.xpi:ro)
fi

"${DOCKER[@]}" run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD/dist":/dist:ro -v "$PWD/e2e/out":/out \
  -v "$PWD/test/assets":/assets:ro \
  -e E2E_ONLY="${E2E_ONLY:-}" \
  -e E2E_TIMEOUT="${E2E_TIMEOUT:-$([ -n "${E2E_LIVE_URL:-}" ] && echo 600 || echo 240)}" \
  "${LIVE[@]}" \
  seekchat-e2e:latest
