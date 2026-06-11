#!/usr/bin/env bash
# Build the chatgpt-proxy into a single-file executable via PyInstaller and
# drop it into internal/subproc/proxybin/ so a release `go build -tags
# proxyembed` can embed it into the PierCode binary.
#
# Run this on each target platform (the PyInstaller output is platform-specific;
# there is no cross-compile). macOS arm64 host → darwin-arm64 binary, etc.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY_DIR="$REPO_ROOT/chatgpt-proxy"
OUT_DIR="$REPO_ROOT/internal/subproc/proxybin"
VENV="$PROXY_DIR/.venv"

# Map GOOS/GOARCH-style name from uname.
case "$(uname -s)" in
  Darwin) GOOS=darwin ;;
  Linux)  GOOS=linux ;;
  *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) GOARCH=arm64 ;;
  x86_64|amd64)  GOARCH=amd64 ;;
  *)             echo "Unsupported arch: $(uname -m)"; exit 1 ;;
esac
TARGET="chatgpt-proxy-${GOOS}-${GOARCH}"

echo "==> Target: $TARGET"
mkdir -p "$OUT_DIR"

# Ensure venv + deps + PyInstaller.
if [ ! -d "$VENV" ]; then
  echo "==> Creating venv"
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q -r "$PROXY_DIR/requirements.txt"
"$VENV/bin/pip" install -q pyinstaller

echo "==> Running PyInstaller (single file)"
cd "$PROXY_DIR"
"$VENV/bin/pyinstaller" \
  --onefile \
  --name "$TARGET" \
  --distpath "$OUT_DIR" \
  --workpath "$PROXY_DIR/.pyi-build" \
  --specpath "$PROXY_DIR/.pyi-build" \
  --collect-all curl_cffi \
  --collect-all browser_cookie3 \
  --hidden-import esprima \
  --clean \
  server.py

# PyInstaller appends nothing extra to the name on unix; confirm the artifact.
if [ -f "$OUT_DIR/$TARGET" ]; then
  chmod +x "$OUT_DIR/$TARGET"
  echo "==> Built: $OUT_DIR/$TARGET ($(du -h "$OUT_DIR/$TARGET" | cut -f1))"
else
  echo "ERROR: expected $OUT_DIR/$TARGET not found"; exit 1
fi

# Smoke test: it should start and answer /health. PyInstaller --onefile cold
# start unpacks to a temp dir and can take ~10-15s on first run, so poll.
echo "==> Smoke test (polling for cold start)"
CGPT_PROXY_PORT=8799 "$OUT_DIR/$TARGET" >/tmp/proxy-smoke.log 2>&1 &
PID=$!
OK=0
for i in $(seq 1 25); do
  sleep 1
  if curl -s http://127.0.0.1:8799/health 2>/dev/null | grep -q '"ok"'; then
    echo "==> /health OK after ${i}s"
    OK=1
    break
  fi
done
[ "$OK" = 0 ] && echo "WARN: /health did not respond in 25s; check /tmp/proxy-smoke.log"
kill "$PID" 2>/dev/null || true
echo "==> Done. Build PierCode with: go build -tags proxyembed ./cmd/server"
