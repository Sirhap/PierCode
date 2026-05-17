#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENLINK_DIR="${OPENLINK_DIR:-$ROOT_DIR}"
OPENLINK_PORT="${OPENLINK_PORT:-39527}"
OPENLINK_TIMEOUT="${OPENLINK_TIMEOUT:-60}"

cd "$ROOT_DIR"

echo "Starting OpenLink backend..."
echo "  dir:     $OPENLINK_DIR"
echo "  port:    $OPENLINK_PORT"
echo "  timeout: ${OPENLINK_TIMEOUT}s"
echo

exec go run ./cmd/server \
  -dir "$OPENLINK_DIR" \
  -port "$OPENLINK_PORT" \
  -timeout "$OPENLINK_TIMEOUT" \
  "$@"
