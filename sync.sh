#!/usr/bin/env bash
# Sync www/ (canonical) → root mirrors
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"

pairs=(
  "www/index.html:index.html"
  "www/sw.js:sw.js"
  "www/css/styles.css:css/styles.css"
  "www/js/admin.js:js/admin.js"
  "www/js/config.js:js/config.js"
  "www/js/attendance.js:js/attendance.js"
  "www/js/audio.js:js/audio.js"
  "www/js/auth.js:js/auth.js"
  "www/js/face-recognition.js:js/face-recognition.js"
  "www/js/offline-queue.js:js/offline-queue.js"
  "www/js/ui.js:js/ui.js"
)

changed=0
for pair in "${pairs[@]}"; do
  src="${REPO}/${pair%%:*}"
  dst="${REPO}/${pair##*:}"
  if [ ! -f "$src" ]; then
    echo "SKIP (no source): $src"
    continue
  fi
  mkdir -p "$(dirname "$dst")"
  if ! diff -q "$src" "$dst" &>/dev/null; then
    cp "$src" "$dst"
    echo "SYNCED: ${pair%%:*} → ${pair##*:}"
    changed=$((changed + 1))
  fi
done

echo ""
if [ "$changed" -eq 0 ]; then
  echo "All mirrors up to date."
else
  echo "$changed file(s) synced."
fi
