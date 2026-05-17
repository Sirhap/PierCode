#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PIERCODE_DIR="${PIERCODE_DIR:-$ROOT_DIR}"
PIERCODE_PORT="${PIERCODE_PORT:-39527}"
PIERCODE_TIMEOUT="${PIERCODE_TIMEOUT:-60}"

cd "$ROOT_DIR"

echo "Starting PierCode backend..."
echo "  dir:     $PIERCODE_DIR"
echo "  port:    $PIERCODE_PORT"
echo "  timeout: ${PIERCODE_TIMEOUT}s"
echo

exec go run ./cmd/server \
  -dir "$PIERCODE_DIR" \
  -port "$PIERCODE_PORT" \
  -timeout "$PIERCODE_TIMEOUT" \
  "$@"
