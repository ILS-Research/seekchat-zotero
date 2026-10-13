#!/usr/bin/env bash
# Newest downloadable Zotero build of each supported major version (7 … current), one per line;
# `zotero-versions.sh latest` prints only the current release. Used by run.sh and CI so the E2E tests
# always run against the newest Zotero (a tag on GitHub is not always downloadable, so each one is probed).
set -uo pipefail
dl=https://download.zotero.org/client/release

latest=$(curl -fsSI "https://www.zotero.org/download/client/dl?channel=release&platform=linux-x86_64" \
  | tr -d '\r' | sed -n 's#^[Ll]ocation:.*/release/\([0-9][0-9.]*\)/.*#\1#p' | head -1)
[ -n "$latest" ] || { echo "cannot find the current Zotero release" >&2; exit 1; }
[ "${1:-}" = latest ] && { echo "$latest"; exit 0; }

tags=$(curl -fsS "https://api.github.com/repos/zotero/zotero/tags?per_page=100" | sed -n 's/.*"name": *"\([0-9][0-9.]*\)".*/\1/p' | sort -Vr)
for major in $(seq 7 "${latest%%.*}"); do
  for v in $(echo "$tags" | grep -E "^$major\.[0-9]+\.[0-9]+$"); do
    for ext in xz bz2; do
      if curl -fsI "$dl/$v/Zotero-${v}_linux-x86_64.tar.$ext" >/dev/null 2>&1; then echo "$v"; continue 3; fi
    done
  done
done
